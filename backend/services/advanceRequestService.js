import { createHash } from "node:crypto";
import { requireOpenShiftForCashier } from "../middleware/getCurrentShift.js";
import { logAuditUser, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { getTelegramManagerUser } from "./refundRequestService.js";
import { computeExpectedBaseCash } from "../utils/salePayments.js";
import { HttpError, badRequest } from "../utils/httpError.js";
import { round2 } from "../utils/money.js";
import { listPosEmployeeDirectory } from "./employeeService.js";
import {
  isSulafTelegramConfigured,
  sendAdvanceApprovalMessage,
  editAdvanceRequestMessage,
  sendAdvanceDecisionStatusMessage,
} from "../utils/telegram.js";
import { withTransaction } from "../utils/dbTx.js";
import { shopBusinessDayYmd } from "../utils/businessDay.js";
import {
  assertCanApproveLinkedSalaryAdvance,
  postPosSalaryAdvanceInTx,
} from "./employeePaymentService.js";
import { enqueueOperationPrint } from "./operationPrintService.js";
import {
  lockOriginatingShift,
  rejectHandoverFields,
  updateOutstandingHandover,
} from "./originatingShiftDecision.js";

export { getTelegramManagerUser };

async function computeShiftExpectedCash(db, shiftId, openingCash) {
  return computeExpectedBaseCash(db, shiftId, openingCash);
}

export async function createAdvanceRequest(db, params) {
  const { cashierId, employeeId, amount, notes, req } = params;
  const empId = Number(employeeId);
  if (!empId) {
    const err = new Error("اختر الموظف");
    err.status = 400;
    err.code = "EMPLOYEE_REQUIRED";
    throw err;
  }
  const amt = round2(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) {
    const err = new Error("المبلغ يجب أن يكون أكبر من صفر");
    err.status = 400;
    throw err;
  }

  const employee = await db.get("SELECT id, name, active FROM employees WHERE id = ?", [empId]);
  if (!employee) {
    const err = new Error("الموظف غير موجود");
    err.status = 400;
    err.code = "EMPLOYEE_NOT_FOUND";
    throw err;
  }
  if (!Number(employee.active)) {
    const err = new Error("لا يمكن طلب سلف لموظف غير نشط");
    err.status = 400;
    err.code = "EMPLOYEE_INACTIVE";
    throw err;
  }
  const snapshotName = String(employee.name || "").trim();

  const { shift, error: shiftErr } = await requireOpenShiftForCashier(db, cashierId);
  if (shiftErr || !shift) {
    const err = new Error(shiftErr || "لا توجد وردية مفتوحة");
    err.status = 400;
    throw err;
  }

  const created = await withTransaction(db, async () => {
    const ins = await db.run(
      `INSERT INTO advance_requests
         (cashier_id, shift_id, employee_id, employee_name, amount, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [cashierId, shift.id, employee.id, snapshotName, amt, notes != null ? String(notes).trim() || null : null]
    );
    const requestId = ins.lastID;
    const row = await db.get("SELECT * FROM advance_requests WHERE id = ?", [requestId]);
    const cashier = await db.get("SELECT username FROM users WHERE id = ?", [cashierId]);

    if (req?.user) {
      await logAuditUser(db, req.user, AUDIT_ACTIONS.ADVANCE_REQUEST_CREATE, "advance_requests", requestId, null, {
        employee_id: employee.id,
        employee_name: snapshotName,
        amount: amt,
      });
    }

    return { request: row, request_id: requestId, cashier, trimmedName: snapshotName };
  });

  let telegramMessageId = null;
  if (isSulafTelegramConfigured()) {
    try {
      telegramMessageId = await sendAdvanceApprovalMessage({
        requestId: created.request_id,
        cashierName: created.cashier?.username || String(cashierId),
        employeeName: created.trimmedName,
        amount: amt,
        notes: notes || "",
      });
      await db.run("UPDATE advance_requests SET telegram_message_id = ? WHERE id = ?", [
        telegramMessageId,
        created.request_id,
      ]);
      created.request.telegram_message_id = telegramMessageId;
    } catch (e) {
      console.error("Telegram sulaf send failed:", e.message);
    }
  }

  return {
    request: created.request,
    request_id: created.request_id,
    telegram: isSulafTelegramConfigured() && !!telegramMessageId,
    message: "سُجّل طلب السلف قيد المراجعة. لن يُصرف النقد حتى موافقة المسؤول.",
  };
}

export async function getAdvanceRequestById(db, id) {
  return db.get(
    `SELECT ar.*, u.username AS cashier_username, m.username AS manager_username,
            s.status AS shift_status
     FROM advance_requests ar
     JOIN users u ON u.id = ar.cashier_id
     LEFT JOIN users m ON m.id = ar.manager_id
     LEFT JOIN cashier_shifts s ON s.id = ar.shift_id
     WHERE ar.id = ?`,
    [id]
  );
}

export async function listPendingAdvanceRequests(db) {
  return db.all(
    `SELECT ar.*, u.username AS cashier_username, s.status AS shift_status
     FROM advance_requests ar
     JOIN users u ON u.id = ar.cashier_id
     LEFT JOIN cashier_shifts s ON s.id = ar.shift_id
     WHERE ar.status = 'pending'
     ORDER BY ar.created_at ASC, ar.id ASC`
  );
}

export async function recordAdvanceHandover(db, requestId, userId, disposition) {
  return updateOutstandingHandover(db, "advance_requests", requestId, userId, disposition);
}

export async function listAdvanceRequestHistory(db, status = "all", limit = 200) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 200));
  let sql = `SELECT ar.*, u.username AS cashier_username, m.username AS manager_username
             FROM advance_requests ar
             JOIN users u ON u.id = ar.cashier_id
             LEFT JOIN users m ON m.id = ar.manager_id
             WHERE ar.status != 'pending'`;
  const params = [];
  if (status === "approved" || status === "rejected") {
    sql += " AND ar.status = ?";
    params.push(status);
  }
  sql += " ORDER BY COALESCE(ar.approved_at, ar.rejected_at, ar.created_at) DESC, ar.id DESC LIMIT ?";
  params.push(lim);
  return db.all(sql, params);
}

export async function listMyAdvanceRequests(db, cashierId, limit = 100) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 100));
  return db.all(
    `SELECT ar.*, m.username AS manager_username
     FROM advance_requests ar
     LEFT JOIN users m ON m.id = ar.manager_id
     WHERE ar.cashier_id = ?
     ORDER BY ar.created_at DESC, ar.id DESC
     LIMIT ?`,
    [Number(cashierId), lim]
  );
}

export async function listUnreadAdvanceDecisions(db, cashierId) {
  return db.all(
    `SELECT ar.*, m.username AS manager_username
     FROM advance_requests ar
     LEFT JOIN users m ON m.id = ar.manager_id
     WHERE ar.cashier_id = ?
       AND ar.status IN ('approved', 'rejected')
       AND ar.cashier_acknowledged_at IS NULL
     ORDER BY COALESCE(ar.approved_at, ar.rejected_at) ASC, ar.id ASC`,
    [Number(cashierId)]
  );
}

export async function acknowledgeAdvanceDecision(db, requestId, cashierId) {
  const row = await db.get("SELECT * FROM advance_requests WHERE id = ?", [requestId]);
  if (!row) {
    const err = new Error("طلب السلف غير موجود");
    err.status = 404;
    throw err;
  }
  if (Number(row.cashier_id) !== Number(cashierId)) {
    const err = new Error("ممنوع");
    err.status = 403;
    throw err;
  }
  if (!["approved", "rejected"].includes(row.status)) {
    const err = new Error("الطلب لم يُبت فيه بعد");
    err.status = 400;
    throw err;
  }
  const now = new Date().toISOString();
  await db.run(
    `UPDATE advance_requests SET
       cashier_acknowledged_at = ?,
       cashier_notified_at = COALESCE(cashier_notified_at, ?)
     WHERE id = ?`,
    [now, now, requestId]
  );
  return getAdvanceRequestById(db, requestId);
}

async function notifyTelegramAfterDecision(request, managerUser, status, decisionSource) {
  if (!isSulafTelegramConfigured()) return;
  const payload = {
    requestId: request.id,
    status,
    employeeName: request.employee_name,
    amount: request.amount,
    approverName: managerUser?.username || null,
    decisionSource,
  };
  if (request.telegram_message_id) {
    try {
      await editAdvanceRequestMessage({
        messageId: request.telegram_message_id,
        ...payload,
      });
    } catch (e) {
      console.error("Telegram sulaf edit failed:", e.message);
    }
  }
  if (decisionSource === "admin") {
    try {
      await sendAdvanceDecisionStatusMessage(payload);
    } catch (e) {
      console.error("Telegram sulaf status failed:", e.message);
    }
  }
}

export async function approveAdvanceRequest(
  db,
  requestId,
  managerUser,
  reviewNotes,
  req = null,
  decisionSource = "admin",
  occurredOn = null
) {
  const updated = await withTransaction(db, async () => {
    const request = await db.get("SELECT * FROM advance_requests WHERE id = ?", [requestId]);
    if (!request) {
      const err = new Error("طلب السلف غير موجود");
      err.status = 404;
      throw err;
    }
    if (request.status !== "pending") {
      const err = new Error("الطلب ليس قيد المراجعة");
      err.status = 400;
      err.code = "NOT_PENDING";
      throw err;
    }

    const locked = await lockOriginatingShift(db, request.shift_id);
    const shift = locked.shift;
    if (locked.mode !== "open" && locked.mode !== "pending_count") {
      const err = new Error("لا توجد وردية مفتوحة لصرف السلف");
      err.status = 400;
      err.code = "NO_OPEN_SHIFT";
      throw err;
    }

    const employeeId = request.employee_id != null ? Number(request.employee_id) : null;
    if (employeeId && decisionSource !== "telegram") {
      await assertCanApproveLinkedSalaryAdvance(db, managerUser);
    }

    const expectedCash = await computeShiftExpectedCash(db, shift.id, shift.opening_cash);
    const amount = round2(Number(request.amount));
    if (expectedCash < amount) {
      const err = new Error(`النقد في الدرج غير كافٍ (المتاح: ₪${expectedCash.toFixed(2)})`);
      err.status = 400;
      err.code = "INSUFFICIENT_CASH";
      throw err;
    }

    const now = new Date().toISOString();
    const desc = employeeId
      ? `سلفة على الراتب — ${request.employee_name} #${requestId}`
      : `سلف — ${request.employee_name} #${requestId}`;
    const movement = await db.run(
      `INSERT INTO shift_cash_movements (shift_id, movement_type, amount, description, advance_request_id)
       VALUES (?, 'advance', ?, ?, ?)`,
      [shift.id, -amount, desc, requestId]
    );

    let ledger = null;
    if (employeeId) {
      const shiftDay = shopBusinessDayYmd({
        business_day: shift.business_day,
        start_time: shift.start_time,
      });
      const businessDay =
        locked.mode === "pending_count"
          ? shift.business_day || shiftDay
          : occurredOn && /^\d{4}-\d{2}-\d{2}$/.test(String(occurredOn))
            ? String(occurredOn)
            : shiftDay;
      ledger = await postPosSalaryAdvanceInTx(db, {
        employeeId,
        amount,
        occurredOn: businessDay,
        advanceRequestId: requestId,
        shiftCashMovementId: movement.lastID,
        createdBy: decisionSource === "telegram" ? null : managerUser?.id ?? null,
        note: request.notes
          ? `سلفة على الراتب — ${request.employee_name} #${requestId} — ${request.notes}`
          : undefined,
      });
    }

    if (managerUser?.failAfterPost) {
      const err = new Error("forced");
      err.code = "FORCED_ROLLBACK";
      throw err;
    }

    const actorId = decisionSource === "telegram" ? managerUser?.telegram_user_id || null : null;
    const actorName = decisionSource === "telegram" ? managerUser?.telegram_actor_name || managerUser?.username || null : null;
    const managerId = decisionSource === "telegram" ? null : managerUser?.id ?? null;
    const decided = await db.run(
      `UPDATE advance_requests SET
        status = 'approved', manager_id = ?, approved_at = ?,
        review_notes = COALESCE(?, review_notes), rejected_at = NULL,
        decision_source = ?,
        ledger_entry_id = COALESCE(?, ledger_entry_id),
        operating_expense_id = COALESCE(?, operating_expense_id),
        telegram_actor_id = ?, telegram_actor_name = ?
       WHERE id = ? AND status = 'pending'`,
      [
        managerId,
        now,
        reviewNotes,
        decisionSource,
        ledger?.id ?? null,
        ledger?.operating_expense_id ?? null,
        actorId,
        actorName,
        requestId,
      ]
    );
    if (!decided.changes) {
      const err = new Error("الطلب ليس قيد المراجعة");
      err.status = 400;
      err.code = "NOT_PENDING";
      throw err;
    }

    const auditUser = req?.user || managerUser;
    await logAuditUser(db, auditUser, AUDIT_ACTIONS.ADVANCE_REQUEST_APPROVE, "advance_requests", requestId, { status: "pending" }, {
      manager_id: managerId,
      telegram_user_id: actorId,
      telegram_actor_name: actorName,
      employee_id: employeeId,
      amount,
    });

    const cashier = await db.get("SELECT username FROM users WHERE id = ?", [request.cashier_id]);
    await enqueueOperationPrint(db, {
      kind: "salary_advance",
      referenceId: requestId,
      cashierId: request.cashier_id,
      shiftId: shift.id,
      documentNo: `ADV-${requestId}`,
      snapshot: {
        title: "سلفة على الراتب",
        documentNo: `ADV-${requestId}`,
        timestamp: now,
        businessDay: shift.business_day,
        cashierName: cashier?.username || "",
        shiftId: shift.id,
        partyLabel: `الموظف: ${request.employee_name || ""}`,
        lines: ["سلفة على الراتب"],
        note: request.notes || null,
        amountLabel: `المبلغ ${amount.toFixed(2)} شيقل`,
        footer: "سلفة على الراتب",
        managerName: managerUser.username || "",
        requestRef: `#${requestId}`,
      },
    });

    return getAdvanceRequestById(db, requestId);
  });
  await notifyTelegramAfterDecision(updated, managerUser, "approved", decisionSource);
  return { request: updated };
}

export async function rejectAdvanceRequest(
  db,
  requestId,
  managerUser,
  reviewNotes,
  req = null,
  decisionSource = "admin",
  options = {}
) {
  const updated = await withTransaction(db, async () => {
    const request = await db.get("SELECT * FROM advance_requests WHERE id = ?", [requestId]);
    if (!request) {
      const err = new Error("طلب السلف غير موجود");
      err.status = 404;
      throw err;
    }
    if (request.status !== "pending") {
      const err = new Error("الطلب ليس قيد المراجعة");
      err.status = 400;
      err.code = "NOT_PENDING";
      throw err;
    }

    const locked = await lockOriginatingShift(db, request.shift_id);
    const now = new Date().toISOString();
    const actorId = decisionSource === "telegram" ? managerUser?.telegram_user_id || null : null;
    const actorName = decisionSource === "telegram" ? managerUser?.telegram_actor_name || managerUser?.username || null : null;
    const managerId = decisionSource === "telegram" ? null : managerUser?.id ?? null;
    const handover = rejectHandoverFields(locked.mode, options?.handoverDisposition, managerId);
    const decided = await db.run(
      `UPDATE advance_requests SET
        status = 'rejected', manager_id = ?, rejected_at = ?,
        review_notes = COALESCE(?, review_notes), approved_at = NULL,
        decision_source = ?, telegram_actor_id = ?, telegram_actor_name = ?,
        handover_disposition = ?, handover_recorded_at = ?, handover_recorded_by = ?
       WHERE id = ? AND status = 'pending'`,
      [
        managerId,
        now,
        reviewNotes,
        decisionSource,
        actorId,
        actorName,
        handover.disposition,
        handover.recordedAt,
        handover.recordedBy,
        requestId,
      ]
    );
    if (!decided.changes) {
      const err = new Error("الطلب ليس قيد المراجعة");
      err.status = 400;
      err.code = "NOT_PENDING";
      throw err;
    }

    const auditUser = req?.user || managerUser;
    await logAuditUser(db, auditUser, AUDIT_ACTIONS.ADVANCE_REQUEST_REJECT, "advance_requests", requestId, { status: "pending" }, {
      manager_id: managerId,
      telegram_user_id: actorId,
      telegram_actor_name: actorName,
    });

    return getAdvanceRequestById(db, requestId);
  });
  await notifyTelegramAfterDecision(updated, managerUser, "rejected", decisionSource);
  return { request: updated };
}

export function fingerprintShiftAdvance({ employeeId, amount, notes }) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        employee_id: Number(employeeId) || 0,
        amount: round2(amount),
        notes: notes ? String(notes) : null,
      })
    )
    .digest("hex");
}

function parseShiftAdvanceAmount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw badRequest("المبلغ يجب أن يكون رقماً موجباً", "INVALID_AMOUNT");
  }
  const stored = round2(n);
  if (Math.abs(n - stored) > 1e-9) {
    throw badRequest("المبلغ يجب أن يكون حتى خانتين عشريتين", "INVALID_AMOUNT_PRECISION");
  }
  return stored;
}

export async function listEmployeeAdvanceOptions(db, q) {
  const term = String(q || "").trim();
  const params = [];
  let sql = "SELECT id, name FROM employees WHERE active = 1";
  if (term) {
    sql += " AND name LIKE ?";
    params.push(`%${term}%`);
  }
  sql += " ORDER BY name COLLATE NOCASE, id LIMIT 200";
  return listPosEmployeeDirectory(await db.all(sql, params));
}

export async function listShiftAdvances(db, shiftId) {
  const rows = await db.all(
    `SELECT
        m.id AS movement_id,
        ar.id AS request_id,
        COALESCE(ar.amount, ABS(m.amount)) AS amount,
        COALESCE(m.created_at, ar.approved_at, ar.created_at) AS paid_at,
        ar.notes,
        ar.employee_id,
        COALESCE(ar.employee_name, e.name) AS employee_name,
        ar.manager_id AS recorded_by_id,
        u.username AS recorded_by_name
     FROM shift_cash_movements m
     LEFT JOIN advance_requests ar ON ar.id = m.advance_request_id
     LEFT JOIN employees e ON e.id = ar.employee_id
     LEFT JOIN users u ON u.id = ar.manager_id
     WHERE m.shift_id = ? AND m.movement_type = 'advance'
     ORDER BY m.created_at ASC, m.id ASC`,
    [shiftId]
  );
  const total = round2(rows.reduce((sum, row) => sum + Number(row.amount || 0), 0));
  return { rows, total };
}

async function loadShiftAdvanceResult(db, requestId, { replayed = false } = {}) {
  const row = await db.get(
    `SELECT
        ar.id AS request_id,
        ar.shift_id,
        ar.amount,
        ar.employee_id,
        ar.employee_name,
        ar.manager_id AS recorded_by_id,
        u.username AS recorded_by_name,
        m.id AS movement_id,
        ar.ledger_entry_id,
        ar.operating_expense_id
     FROM advance_requests ar
     LEFT JOIN users u ON u.id = ar.manager_id
     LEFT JOIN shift_cash_movements m ON m.advance_request_id = ar.id AND m.movement_type = 'advance'
     WHERE ar.id = ?`,
    [requestId]
  );
  return row ? { ...row, replayed } : null;
}

async function resolveShiftAdvanceIdempotency(db, { key, fingerprint, userId }) {
  const row = await db.get(
    `SELECT id, manager_id, payload_fingerprint FROM advance_requests WHERE idempotency_key = ?`,
    [key]
  );
  if (!row) return null;
  if (Number(row.manager_id) !== Number(userId)) {
    throw new HttpError(403, "مفتاح التكرار لا يخص هذا المستخدم", "IDEMPOTENCY_OWNER_MISMATCH");
  }
  if (row.payload_fingerprint && row.payload_fingerprint !== fingerprint) {
    throw new HttpError(
      409,
      "تم استخدام مفتاح التكرار مع محتوى مختلف. لا تُعد الإرسال بمحتوى جديد تحت نفس المفتاح.",
      "IDEMPOTENCY_KEY_REUSE"
    );
  }
  return loadShiftAdvanceResult(db, row.id, { replayed: true });
}

function isAdvanceIdempotencyConstraint(err) {
  return (
    err &&
    String(err.code || "").startsWith("SQLITE_CONSTRAINT") &&
    /idempotency/i.test(String(err.message || ""))
  );
}

/**
 * Forgotten cash already handed as سلف during a shift waiting to be counted.
 * Posts one approved advance request, one negative drawer movement, and the
 * canonical employee salary-advance ledger row.
 */
export async function postShiftSalaryAdvance(db, input) {
  const shiftId = Number(input.shiftId);
  if (!Number.isInteger(shiftId) || shiftId <= 0) {
    throw badRequest("معرّف الوردية غير صالح", "INVALID_SHIFT");
  }
  const employeeId = Number(input.employeeId);
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    throw badRequest("اختر الموظف", "EMPLOYEE_REQUIRED");
  }
  const amount = parseShiftAdvanceAmount(input.amount);
  const notes =
    input.notes != null && String(input.notes).trim() !== "" ? String(input.notes).trim() : null;
  const key = String(input.idempotencyKey || "").trim();
  if (key.length < 8 || key.length > 100) {
    throw badRequest("مفتاح التكرار مطلوب (8–100 حرفاً)", "VALIDATION_ERROR");
  }
  const userId = Number(input.userId);
  const fingerprint = fingerprintShiftAdvance({ employeeId, amount, notes });

  try {
    return await withTransaction(db, async () => {
      await assertCanApproveLinkedSalaryAdvance(db, input.user);
      const existing = await resolveShiftAdvanceIdempotency(db, {
        key,
        fingerprint,
        userId,
      });
      if (existing) return existing;

      const locked = await db.run(
        `UPDATE cashier_shifts SET status = status WHERE id = ? AND status = 'pending_count'`,
        [shiftId]
      );
      const shift = await db.get("SELECT * FROM cashier_shifts WHERE id = ?", [shiftId]);
      if (!shift) {
        const err = new Error("الوردية غير موجودة");
        err.status = 404;
        err.code = "NOT_FOUND";
        throw err;
      }
      if (shift.status === "closed") {
        const err = new Error("لا يمكن تسجيل سلف على وردية مغلقة");
        err.status = 400;
        err.code = "SHIFT_CLOSED";
        throw err;
      }
      if (!locked.changes || shift.status !== "pending_count") {
        const err = new Error("الوردية ليست بانتظار العد");
        err.status = 400;
        err.code = "NOT_PENDING";
        throw err;
      }

      const employee = await db.get("SELECT id, name, active FROM employees WHERE id = ?", [employeeId]);
      if (!employee) {
        throw badRequest("الموظف غير موجود", "EMPLOYEE_NOT_FOUND");
      }
      if (!Number(employee.active)) {
        throw badRequest("لا يمكن تسجيل سلف لموظف غير نشط", "EMPLOYEE_INACTIVE");
      }
      const employeeName = String(employee.name || "").trim();
      const now = new Date().toISOString();
      const occurredOn = shopBusinessDayYmd({
        business_day: shift.business_day,
        start_time: shift.start_time,
      });

      const ins = await db.run(
        `INSERT INTO advance_requests
           (cashier_id, manager_id, shift_id, employee_id, employee_name, amount, notes,
            status, decision_source, approved_at, idempotency_key, payload_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', 'shift_count', ?, ?, ?)`,
        [
          shift.cashier_id,
          userId,
          shift.id,
          employee.id,
          employeeName,
          amount,
          notes,
          now,
          key,
          fingerprint,
        ]
      );
      const requestId = ins.lastID;
      const desc = `سلفة على الراتب — ${employeeName} #${requestId}`;
      const movement = await db.run(
        `INSERT INTO shift_cash_movements (shift_id, movement_type, amount, description, advance_request_id)
         VALUES (?, 'advance', ?, ?, ?)`,
        [shift.id, -amount, desc, requestId]
      );

      const ledger = await postPosSalaryAdvanceInTx(db, {
        employeeId: employee.id,
        amount,
        occurredOn,
        advanceRequestId: requestId,
        shiftCashMovementId: movement.lastID,
        createdBy: userId,
        note: notes ? `${desc} — ${notes}` : desc,
      });

      await db.run(
        `UPDATE advance_requests SET ledger_entry_id = ?, operating_expense_id = ? WHERE id = ?`,
        [ledger?.id ?? null, ledger?.operating_expense_id ?? null, requestId]
      );

      if (input.req?.user || input.user) {
        await logAuditUser(
          db,
          input.req?.user || input.user,
          AUDIT_ACTIONS.ADVANCE_REQUEST_APPROVE,
          "advance_requests",
          requestId,
          null,
          {
            manager_id: userId,
            employee_id: employee.id,
            amount,
            shift_id: shift.id,
            movement_id: movement.lastID,
            decision_source: "shift_count",
          }
        );
      }

      return loadShiftAdvanceResult(db, requestId, { replayed: false });
    });
  } catch (err) {
    if (isAdvanceIdempotencyConstraint(err)) {
      const replay = await resolveShiftAdvanceIdempotency(db, { key, fingerprint, userId });
      if (replay) return replay;
    }
    throw err;
  }
}
