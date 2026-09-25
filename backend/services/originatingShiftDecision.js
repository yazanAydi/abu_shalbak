import { HttpError, badRequest } from "../utils/httpError.js";
import { withTransaction } from "../utils/dbTx.js";
import { round2 } from "../utils/money.js";
import { userHasAccountantPermission } from "../utils/accountantPermissions.js";

export const PENDING_COUNT_ALERT =
  "انتهت الوردية ولم يتم جردها. عالج هذا الطلب من النظام قبل إتمام الجرد.";
export const CLOSED_SHIFT_ALERT =
  "أُغلقت الوردية وجُردت. هذا الطلب يحتاج تسوية يدوية ولن يُغيّر الجرد المحفوظ.";

const REQUEST_TABLES = {
  refund: "refund_requests",
  zimma: "on_account_requests",
  cash_debt: "customer_cash_debt_requests",
  advance: "advance_requests",
};

const PERMISSION_KEYS = {
  refund: "refund_approvals",
  zimma: "on_account_approvals",
  cash_debt: "on_account_approvals",
  advance: "advance_approvals",
};

function httpError(status, message, code) {
  return new HttpError(status, message, code);
}

function parseJson(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function assertHandoverChoice(disposition) {
  if (disposition !== "returned" && disposition !== "outstanding") {
    throw badRequest("حدد هل أُعيد النقد أو البضاعة", "HANDOVER_DISPOSITION_REQUIRED");
  }
  return disposition;
}

export function assertHandoverFollowUp(disposition) {
  if (disposition !== "returned" && disposition !== "loss_accepted") {
    throw badRequest("حدد إعادة النقد أو البضاعة أو قبول العجز", "HANDOVER_DISPOSITION_REQUIRED");
  }
  return disposition;
}

/**
 * Lock the request's own shift. Open and pending_count stay writable.
 * A counted shift is never posted to.
 */
export async function lockOriginatingShift(db, shiftId) {
  const id = Number(shiftId);
  if (!id) throw badRequest("الطلب غير مرتبط بوردية", "SHIFT_REQUIRED");
  const shift = await db.get("SELECT * FROM cashier_shifts WHERE id = ?", [id]);
  if (!shift) throw httpError(404, "الوردية غير موجودة", "SHIFT_NOT_FOUND");
  if (shift.status === "closed") {
    throw httpError(409, CLOSED_SHIFT_ALERT, "CLOSED_SHIFT_RECONCILE");
  }
  if (shift.status !== "open" && shift.status !== "pending_count") {
    throw httpError(409, "حالة الوردية لا تسمح بالقرار", "SHIFT_STATUS_CHANGED");
  }
  const locked = await db.run(
    "UPDATE cashier_shifts SET status = status WHERE id = ? AND status = ?",
    [id, shift.status]
  );
  if (!locked.changes) {
    const again = await db.get("SELECT status FROM cashier_shifts WHERE id = ?", [id]);
    if (again?.status === "closed") {
      throw httpError(409, CLOSED_SHIFT_ALERT, "CLOSED_SHIFT_RECONCILE");
    }
    throw httpError(409, "تغيّرت حالة الوردية. أعد المحاولة.", "SHIFT_STATUS_CHANGED");
  }
  return { shift, mode: shift.status };
}

/** @returns {{ action: string, alert: string } | null} */
export async function telegramShiftHold(db, shiftId) {
  const id = Number(shiftId);
  if (!id) return null;
  const shift = await db.get("SELECT status FROM cashier_shifts WHERE id = ?", [id]);
  if (!shift) return null;
  if (shift.status === "pending_count") {
    return { action: "shift_pending_count", alert: PENDING_COUNT_ALERT };
  }
  if (shift.status === "closed") {
    return { action: "shift_closed_reconcile", alert: CLOSED_SHIFT_ALERT };
  }
  return null;
}

export function rejectHandoverFields(mode, disposition, recordedBy) {
  if (mode !== "pending_count") {
    return { disposition: null, recordedAt: null, recordedBy: null };
  }
  const choice = assertHandoverChoice(disposition);
  return {
    disposition: choice,
    recordedAt: new Date().toISOString(),
    recordedBy: recordedBy ?? null,
  };
}

export async function updateOutstandingHandover(db, table, requestId, userId, disposition) {
  const allowed = Object.values(REQUEST_TABLES);
  if (!allowed.includes(table)) throw httpError(500, "جدول غير معروف", "INTERNAL_ERROR");
  const choice = assertHandoverFollowUp(disposition);
  const id = Number(requestId);
  return withTransaction(db, async () => {
    const request = await db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    if (!request) throw httpError(404, "الطلب غير موجود", "NOT_FOUND");
    if (request.status !== "rejected" || request.handover_disposition !== "outstanding") {
      throw badRequest("لا توجد إعادة معلّقة لهذا الطلب", "HANDOVER_NOT_OUTSTANDING");
    }
    const locked = await lockOriginatingShift(db, request.shift_id);
    if (locked.mode !== "pending_count") {
      throw badRequest("لا يمكن تعديل حالة الإعادة إلا قبل إتمام الجرد", "SHIFT_NOT_PENDING_COUNT");
    }
    const now = new Date().toISOString();
    const upd = await db.run(
      `UPDATE ${table}
       SET handover_disposition = ?, handover_recorded_at = ?, handover_recorded_by = ?
       WHERE id = ? AND status = 'rejected' AND handover_disposition = 'outstanding'`,
      [choice, now, userId ?? null, id]
    );
    if (!upd.changes) throw badRequest("لا توجد إعادة معلّقة لهذا الطلب", "HANDOVER_NOT_OUTSTANDING");
    return db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  });
}

function goodsLines(items) {
  return (Array.isArray(items) ? items : [])
    .map((it) => ({
      name: String(it?.name || "").trim() || "صنف",
      quantity: Number(it?.quantity) || 0,
      unit_name: it?.unit_name ? String(it.unit_name) : null,
    }))
    .filter((it) => it.quantity > 0);
}

function discrepancyFromRow(kind, row) {
  const base = {
    kind,
    request_id: row.id,
    disposition: row.handover_disposition,
    blocks_count: row.handover_disposition === "outstanding",
    cash_amount: null,
    goods: [],
  };
  if (kind === "refund") {
    const method = row.payment_method;
    if (method === "cash") {
      return {
        ...base,
        label: `استرجاع نقدي #${row.id}`,
        cash_amount: round2(Number(row.total_amount) || 0),
      };
    }
    return {
      ...base,
      label: method === "visa" ? `استرجاع بطاقة #${row.id}` : `استرجاع ذمة #${row.id}`,
      goods: goodsLines(parseJson(row.items_json, [])),
    };
  }
  if (kind === "zimma") {
    const snapshot = parseJson(row.sale_snapshot_json, {});
    const cash = round2(Number(snapshot.cashTotal) || 0);
    return {
      ...base,
      label: `بيع بالذمة #${row.id}`,
      cash_amount: cash > 0 ? cash : null,
      goods: goodsLines(snapshot.itemsForJson),
    };
  }
  if (kind === "cash_debt") {
    return {
      ...base,
      label: `ذمة نقدية #${row.id} — ${row.customer_name || "عميل"}`,
      cash_amount: round2(Number(row.amount) || 0),
    };
  }
  return {
    ...base,
    label: `سلف #${row.id} — ${row.employee_name || "موظف"}`,
    cash_amount: round2(Number(row.amount) || 0),
  };
}

async function rowsFor(db, sql, params) {
  return db.all(sql, params);
}

export async function listShiftDecisionState(db, shiftId, user) {
  const id = Number(shiftId);
  const [refunds, zimma, debts, advances] = await Promise.all([
    rowsFor(
      db,
      `SELECT * FROM refund_requests WHERE shift_id = ? AND status = 'pending' ORDER BY id`,
      [id]
    ),
    rowsFor(
      db,
      `SELECT * FROM on_account_requests WHERE shift_id = ? AND status = 'pending' ORDER BY id`,
      [id]
    ),
    rowsFor(
      db,
      `SELECT * FROM customer_cash_debt_requests WHERE shift_id = ? AND status = 'pending' ORDER BY id`,
      [id]
    ),
    rowsFor(
      db,
      `SELECT * FROM advance_requests WHERE shift_id = ? AND status = 'pending' ORDER BY id`,
      [id]
    ),
  ]);
  const [refundDisc, zimmaDisc, debtDisc, advanceDisc] = await Promise.all([
    rowsFor(
      db,
      `SELECT * FROM refund_requests
       WHERE shift_id = ? AND status = 'rejected'
         AND handover_disposition IN ('outstanding', 'loss_accepted')
       ORDER BY id`,
      [id]
    ),
    rowsFor(
      db,
      `SELECT * FROM on_account_requests
       WHERE shift_id = ? AND status = 'rejected'
         AND handover_disposition IN ('outstanding', 'loss_accepted')
       ORDER BY id`,
      [id]
    ),
    rowsFor(
      db,
      `SELECT * FROM customer_cash_debt_requests
       WHERE shift_id = ? AND status = 'rejected'
         AND handover_disposition IN ('outstanding', 'loss_accepted')
       ORDER BY id`,
      [id]
    ),
    rowsFor(
      db,
      `SELECT * FROM advance_requests
       WHERE shift_id = ? AND status = 'rejected'
         AND handover_disposition IN ('outstanding', 'loss_accepted')
       ORDER BY id`,
      [id]
    ),
  ]);

  const can = {};
  for (const kind of Object.keys(PERMISSION_KEYS)) {
    can[kind] = await userHasAccountantPermission(db, user, PERMISSION_KEYS[kind]);
  }

  const pending_requests = [
    ...refunds.map((row) => ({
      kind: "refund",
      request_id: row.id,
      label: row.payment_method === "cash" ? `استرجاع نقدي #${row.id}` : row.payment_method === "visa" ? `استرجاع بطاقة #${row.id}` : `استرجاع ذمة #${row.id}`,
      amount: round2(Number(row.total_amount) || 0),
      payment_method: row.payment_method,
      can_decide: can.refund,
    })),
    ...zimma.map((row) => ({
      kind: "zimma",
      request_id: row.id,
      label: `بيع بالذمة #${row.id}`,
      amount: round2(Number(row.on_account_amount ?? row.total_amount) || 0),
      payment_method: "on_account",
      can_decide: can.zimma,
    })),
    ...debts.map((row) => ({
      kind: "cash_debt",
      request_id: row.id,
      label: `ذمة نقدية #${row.id} — ${row.customer_name || "عميل"}`,
      amount: round2(Number(row.amount) || 0),
      payment_method: "cash",
      can_decide: can.cash_debt,
    })),
    ...advances.map((row) => ({
      kind: "advance",
      request_id: row.id,
      label: `سلف #${row.id} — ${row.employee_name || "موظف"}`,
      amount: round2(Number(row.amount) || 0),
      payment_method: "cash",
      can_decide: can.advance,
    })),
  ];

  const handover_discrepancies = [
    ...refundDisc.map((row) => discrepancyFromRow("refund", row)),
    ...zimmaDisc.map((row) => discrepancyFromRow("zimma", row)),
    ...debtDisc.map((row) => discrepancyFromRow("cash_debt", row)),
    ...advanceDisc.map((row) => discrepancyFromRow("advance", row)),
  ].map((row) => ({
    ...row,
    can_decide: !!can[row.kind],
  }));

  const outstanding_count = handover_discrepancies.filter((row) => row.blocks_count).length;
  return {
    pending_requests,
    handover_discrepancies,
    pending_count: pending_requests.length,
    outstanding_count,
    count_blocked: pending_requests.length > 0 || outstanding_count > 0,
    balanced: handover_discrepancies.length === 0,
  };
}

export async function assertShiftReadyToClose(db, shiftId) {
  const state = await listShiftDecisionState(db, shiftId, null);
  if (state.pending_count > 0 || state.outstanding_count > 0) {
    throw httpError(
      409,
      `لا يمكن إتمام الجرد: ${state.pending_count} طلب معلّق و${state.outstanding_count} إعادة غير محسومة.`,
      "COUNT_BLOCKED"
    );
  }
}

export async function listClosedShiftPendingRequests(db) {
  const sql = (table, kind, labelSql, amountSql) =>
    `SELECT '${kind}' AS kind, r.id AS request_id, r.shift_id, s.business_day, s.end_time,
            u.username AS cashier_name, ${labelSql} AS label, ${amountSql} AS amount
     FROM ${table} r
     JOIN cashier_shifts s ON s.id = r.shift_id
     JOIN users u ON u.id = r.cashier_id
     WHERE r.status = 'pending' AND s.status = 'closed'`;

  const parts = [
    sql("refund_requests", "refund", "'استرجاع #' || r.id", "r.total_amount"),
    sql("on_account_requests", "zimma", "'بيع بالذمة #' || r.id", "COALESCE(r.on_account_amount, r.total_amount)"),
    sql(
      "customer_cash_debt_requests",
      "cash_debt",
      "'ذمة نقدية #' || r.id || ' — ' || COALESCE(r.customer_name, '')",
      "r.amount"
    ),
    sql(
      "advance_requests",
      "advance",
      "'سلف #' || r.id || ' — ' || COALESCE(r.employee_name, '')",
      "r.amount"
    ),
  ];
  const rows = await db.all(`${parts.join(" UNION ALL ")} ORDER BY shift_id, request_id`);
  return rows.map((row) => ({
    ...row,
    amount: round2(Number(row.amount) || 0),
  }));
}
