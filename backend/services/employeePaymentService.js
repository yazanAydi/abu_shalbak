import { round2 } from "../utils/money.js";
import { shopTodayYmd } from "../utils/shopTime.js";
import { withTransaction } from "../utils/dbTx.js";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../utils/httpError.js";
import { userHasAccountantPermission } from "../utils/accountantPermissions.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { appendEmployeeEvent, nextEmployeeEventSeq } from "./employeeEventSeq.js";
import { parseYmd, requireEmployee } from "./employeeService.js";

const PAY_METHODS = new Set(["cash", "transfer", "check", "other"]);
const PURPOSES = new Set(["salary_advance", "salary_payment"]);
const CORRECTION_MODES = new Set(["reverse", "replace", "annotate_recipient"]);

/**
 * Canonical employee cash-payment writer.
 * A POS سلفة على الراتب posts exactly one salary_payment + one operating_expenses
 * row. Office salary payments and advances use the same writer without a
 * drawer line. Later allocation must not insert another expense.
 *
 * Must be called inside an existing withTransaction.
 */

export async function assertCanApproveLinkedSalaryAdvance(db, user) {
  const canAdvance = await userHasAccountantPermission(db, user, "advance_approvals");
  const canPayroll = await userHasAccountantPermission(db, user, "employee_payroll");
  if (!canAdvance || !canPayroll) {
    throw forbidden(
      "الموافقة على سلفة على الراتب تتطلب صلاحية موافقات السلف وصلاحية الموظفون والرواتب",
      "PAYROLL_APPROVAL_REQUIRED"
    );
  }
}

export async function assertCanPostOfficeSalaryExpense(db, user) {
  const canPayroll = await userHasAccountantPermission(db, user, "employee_payroll");
  if (!canPayroll) {
    throw forbidden(
      "تسجيل رواتب أو سلفة على الراتب يتطلب صلاحية الموظفون والرواتب",
      "PAYROLL_REQUIRED"
    );
  }
}

export function isSalaryExpenseCategory(cat) {
  const name = String(
    cat && typeof cat === "object" ? cat.name || cat.category || "" : cat || ""
  )
    .trim()
    .toLowerCase();
  const ar = String(cat && typeof cat === "object" ? cat.name_ar || "" : "").trim();
  if (name === "salaries" || name === "salary_advance") return true;
  if (name.includes("salary") || name.includes("wage")) return true;
  if (ar.includes("رواتب") || ar.includes("سلفة") || ar.includes("سلف")) return true;
  return false;
}

export function purposeFromSalaryCategory(cat, bodyPurpose) {
  if (PURPOSES.has(bodyPurpose)) return bodyPurpose;
  const name = String(
    cat && typeof cat === "object" ? cat.name || cat.category || "" : cat || ""
  )
    .trim()
    .toLowerCase();
  const ar = String(cat && typeof cat === "object" ? cat.name_ar || "" : "").trim();
  if (name === "salary_advance" || ar.includes("سلف")) return "salary_advance";
  return "salary_payment";
}

async function resolveSalariesCategory(db) {
  const row = await db.get(
    `SELECT id, name FROM expense_categories
     WHERE name = 'salaries' OR name_ar = 'رواتب'
     ORDER BY CASE WHEN name = 'salaries' THEN 0 ELSE 1 END, id
     LIMIT 1`
  );
  return row || { id: null, name: "salaries" };
}

function requirePositiveMoney(value, label = "المبلغ") {
  const amt = round2(Number(value));
  if (!Number.isFinite(amt) || amt <= 0) {
    throw badRequest(`${label} غير صالح`, "VALIDATION_ERROR");
  }
  return amt;
}

function requireOccurredOn(value) {
  const day = parseYmd(value) || (value ? null : shopTodayYmd());
  if (!day) throw badRequest("تاريخ الدفعة يجب أن يكون بصيغة YYYY-MM-DD");
  return day;
}

function requireReason(value, label = "سبب التصحيح مطلوب") {
  const reason = value != null ? String(value).trim() : "";
  if (!reason) throw badRequest(label, "REASON_REQUIRED");
  if (reason.length > 500) throw badRequest("السبب طويل جداً");
  return reason;
}

function purposeLabel(purpose) {
  return purpose === "salary_advance" ? "سلفة على الراتب" : "دفعة راتب";
}

export function paymentCorrectionBlock(row) {
  if (!row) return { code: "NOT_FOUND", message: "الدفعة غير موجودة" };
  if (row.entry_type === "salary_payment_reversal") {
    return {
      code: "NOT_CORRECTABLE",
      message: "سطر العكس لا يُصحَّح منفصلاً — السجل الأصلي محفوظ بتاريخه",
    };
  }
  if (String(row.status || "active") === "reversed") {
    return { code: "ALREADY_REVERSED", message: "هذه الدفعة مصحّحة مسبقاً" };
  }
  if (row.advance_request_id || row.shift_cash_movement_id) {
    return {
      code: "POS_CORRECTION_BLOCKED",
      message:
        "لا يمكن تصحيح سلفة الصندوق من هنا: حركة الدرج تبقى كما سُجّلت في الوردية، ولا يُخترع إرجاع نقد ولا تُعاد كتابة وردية مغلقة",
    };
  }
  return null;
}

/**
 * @param {object} db
 * @param {{
 *   employeeId: number,
 *   amount: number,
 *   occurredOn?: string,
 *   purpose?: 'salary_advance'|'salary_payment',
 *   paymentMethod?: string,
 *   referenceNote?: string|null,
 *   advanceRequestId?: number|null,
 *   shiftCashMovementId?: number|null,
 *   createdBy?: number|null,
 *   note?: string|null,
 *   idempotencyKey?: string|null,
 *   categoryId?: number|null,
 *   categoryName?: string|null,
 * }} params
 */
export async function postEmployeePaymentInTx(db, params) {
  const employeeId = Number(params.employeeId);
  const amount = requirePositiveMoney(params.amount);
  const purpose = PURPOSES.has(params.purpose) ? params.purpose : "salary_advance";
  const paymentMethod = PAY_METHODS.has(params.paymentMethod) ? params.paymentMethod : "cash";
  const advanceRequestId =
    params.advanceRequestId != null && params.advanceRequestId !== ""
      ? Number(params.advanceRequestId)
      : null;
  const movementId =
    params.shiftCashMovementId != null && params.shiftCashMovementId !== ""
      ? Number(params.shiftCashMovementId)
      : null;

  if (!employeeId) throw badRequest("معرّف الموظف مطلوب", "EMPLOYEE_REQUIRED");
  if (advanceRequestId && !Number.isFinite(advanceRequestId)) {
    throw badRequest("معرّف طلب السلف مطلوب");
  }
  if (params.shiftCashMovementId != null && !movementId) {
    throw badRequest("حركة الدرج مطلوبة");
  }

  if (advanceRequestId) {
    const existing = await db.get(
      "SELECT * FROM employee_ledger_entries WHERE advance_request_id = ?",
      [advanceRequestId]
    );
    if (existing) return existing;
  }

  const employee = await db.get("SELECT id, name, active FROM employees WHERE id = ?", [employeeId]);
  if (!employee) throw notFound("الموظف غير موجود");

  const occurredOn = requireOccurredOn(params.occurredOn);
  const idempotencyKey =
    params.idempotencyKey ||
    (advanceRequestId ? `pos-advance:${advanceRequestId}` : null);

  if (idempotencyKey) {
    const keyed = await db.get(
      "SELECT * FROM employee_ledger_entries WHERE idempotency_key = ?",
      [idempotencyKey]
    );
    if (keyed) return keyed;
  }

  let cat = null;
  if (params.categoryId != null && params.categoryId !== "") {
    cat = await db.get("SELECT id, name FROM expense_categories WHERE id = ?", [
      Number(params.categoryId),
    ]);
  }
  if (!cat && params.categoryName) {
    cat = { id: params.categoryId ?? null, name: String(params.categoryName) };
  }
  if (!cat) cat = await resolveSalariesCategory(db);

  const note =
    params.note != null && String(params.note).trim()
      ? String(params.note).trim().slice(0, 500)
      : params.referenceNote != null && String(params.referenceNote).trim()
        ? String(params.referenceNote).trim().slice(0, 500)
        : advanceRequestId
          ? `${purposeLabel(purpose)} — ${employee.name} #${advanceRequestId}`
          : `${purposeLabel(purpose)} — ${employee.name}`;

  const exp = await db.run(
    `INSERT INTO operating_expenses
       (category, category_id, amount, paid_on, payment_method, reference_note, recorded_by_id, source, source_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'employee_payment', NULL)`,
    [cat.name, cat.id, amount, occurredOn, paymentMethod, note, params.createdBy ?? null]
  );

  const eventSeq = await nextEmployeeEventSeq(db, employeeId);
  let ledger;
  try {
    const ins = await db.run(
      `INSERT INTO employee_ledger_entries
         (employee_id, entry_type, purpose, occurred_on, amount,
          operating_expense_id, advance_request_id, shift_cash_movement_id,
          idempotency_key, event_seq, created_by, status)
       VALUES (?, 'salary_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        employeeId,
        purpose,
        occurredOn,
        amount,
        exp.lastID,
        advanceRequestId,
        movementId,
        idempotencyKey,
        eventSeq,
        params.createdBy ?? null,
      ]
    );
    await db.run("UPDATE operating_expenses SET source_id = ? WHERE id = ?", [ins.lastID, exp.lastID]);
    await appendEmployeeEvent(db, {
      employeeId,
      eventDate: occurredOn,
      kind: "salary_payment",
      eventSeq,
      sourceTable: "employee_ledger_entries",
      sourceId: ins.lastID,
    });
    ledger = await db.get("SELECT * FROM employee_ledger_entries WHERE id = ?", [ins.lastID]);
  } catch (err) {
    const msg = String(err?.message || "");
    if (/UNIQUE|unique/i.test(msg)) {
      if (advanceRequestId || idempotencyKey) {
        const again = await db.get(
          "SELECT * FROM employee_ledger_entries WHERE advance_request_id = ? OR idempotency_key = ?",
          [advanceRequestId, idempotencyKey]
        );
        if (again) return again;
      }
      throw conflict("دفعة السلف مسجّلة مسبقاً", "ADVANCE_ALREADY_POSTED");
    }
    throw err;
  }
  return ledger;
}

export async function postPosSalaryAdvanceInTx(db, params) {
  return postEmployeePaymentInTx(db, {
    employeeId: params.employeeId,
    amount: params.amount,
    occurredOn: params.occurredOn,
    purpose: "salary_advance",
    paymentMethod: "cash",
    advanceRequestId: params.advanceRequestId,
    shiftCashMovementId: params.shiftCashMovementId,
    createdBy: params.createdBy,
    note: params.note,
  });
}

export async function postOfficeEmployeePayment(db, employeeId, body, req) {
  await requireEmployee(db, employeeId);
  const purpose = body?.purpose;
  if (!PURPOSES.has(purpose)) {
    throw badRequest("نوع الدفعة يجب أن يكون دفعة راتب أو سلفة على الراتب");
  }
  const paymentMethod = String(body?.payment_method || "").trim();
  if (!PAY_METHODS.has(paymentMethod)) {
    throw badRequest("طريقة الدفع غير صالحة");
  }
  const referenceNote =
    body?.reference_note != null && String(body.reference_note).trim()
      ? String(body.reference_note).trim().slice(0, 500)
      : null;
  const categoryId =
    body?.category_id != null && body.category_id !== "" ? Number(body.category_id) : null;

  const ledger = await withTransaction(db, async () =>
    postEmployeePaymentInTx(db, {
      employeeId,
      amount: body?.amount,
      occurredOn: body?.occurred_on,
      purpose,
      paymentMethod,
      referenceNote,
      createdBy: req?.user?.id ?? null,
      note: referenceNote,
      categoryId,
      categoryName: body?.category_name || null,
    })
  );

  if (req) {
    await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_PAYMENT_CREATE, "employee_ledger_entries", ledger.id, null, {
      employee_id: Number(employeeId),
      purpose,
      amount: round2(Number(ledger.amount)),
      occurred_on: ledger.occurred_on,
      operating_expense_id: ledger.operating_expense_id,
      payment_method: paymentMethod,
    });
  }
  return mapLedger(ledger, { payment_method: paymentMethod, reference_note: referenceNote });
}

export async function postSalaryExpenseFromOffice(db, body, req, category) {
  await assertCanPostOfficeSalaryExpense(db, req?.user);
  const employeeId = Number(body?.employee_id);
  if (!employeeId) {
    throw badRequest("يجب اختيار موظف لرواتب أو سلفة على الراتب", "EMPLOYEE_REQUIRED");
  }
  const purpose = purposeFromSalaryCategory(category, body?.purpose);
  return postOfficeEmployeePayment(
    db,
    employeeId,
    {
      purpose,
      amount: body?.amount,
      occurred_on: body?.paid_on || body?.occurred_on,
      payment_method: body?.payment_method,
      reference_note: body?.reference_note,
      category_id: body?.category_id ?? category?.id ?? null,
      category_name: category?.name || body?.category || null,
    },
    req
  );
}

export async function listEmployeePayments(db, employeeId) {
  const rows = await db.all(
    `SELECT e.*, o.payment_method, o.reference_note
     FROM employee_ledger_entries e
     LEFT JOIN operating_expenses o ON o.id = e.operating_expense_id
     WHERE e.employee_id = ?
     ORDER BY e.occurred_on ASC, e.event_seq ASC, e.id ASC`,
    [employeeId]
  );
  return rows.map((row) => mapLedger(row));
}

export function mapLedger(row, extras = {}) {
  if (!row) return null;
  const block = paymentCorrectionBlock(row);
  return {
    id: row.id,
    employee_id: row.employee_id,
    entry_type: row.entry_type,
    purpose: row.purpose,
    kind_label:
      row.entry_type === "salary_payment_reversal"
        ? `عكس ${purposeLabel(row.purpose)}`
        : purposeLabel(row.purpose),
    occurred_on: row.occurred_on,
    amount: round2(Number(row.amount)),
    operating_expense_id: row.operating_expense_id,
    advance_request_id: row.advance_request_id,
    shift_cash_movement_id: row.shift_cash_movement_id ?? null,
    payment_method: row.payment_method || extras.payment_method || null,
    reference_note: row.reference_note || extras.reference_note || null,
    event_seq: row.event_seq,
    created_at: row.created_at,
    status: row.status || "active",
    reverses_id: row.reverses_id ?? null,
    intended_employee_id: row.intended_employee_id ?? null,
    correction_reason: row.correction_reason || null,
    correction_date: row.correction_date || null,
    can_correct: !block,
    correction_block: block,
  };
}

export async function assertExpenseNotLinked(db, expenseId) {
  const row = await db.get("SELECT id, source FROM operating_expenses WHERE id = ?", [expenseId]);
  if (!row) return;
  if (row.source === "shop_consumption") {
    throw new HttpError(
      409,
      "لا يمكن حذف مصروف استهلاك المحل لأنه مربوط بخصم مخزون",
      "LINKED_EXPENSE"
    );
  }
  if (row.source) {
    throw new HttpError(409, "لا يمكن حذف مصروف مربوط بدفعة موظف", "LINKED_EXPENSE");
  }
  const led = await db.get("SELECT id FROM employee_ledger_entries WHERE operating_expense_id = ?", [
    expenseId,
  ]);
  if (led) {
    throw new HttpError(409, "لا يمكن حذف مصروف مربوط بدفعة موظف", "LINKED_EXPENSE");
  }
}

async function loadLedgerWithExpense(db, id) {
  return db.get(
    `SELECT e.*, o.payment_method, o.reference_note, o.category, o.category_id
     FROM employee_ledger_entries e
     LEFT JOIN operating_expenses o ON o.id = e.operating_expense_id
     WHERE e.id = ?`,
    [id]
  );
}

async function reverseOfficePaymentInTx(db, original, { reason, correctionDate, createdBy }) {
  const keyed = `payment-reverse:${original.id}`;
  const existing = await db.get("SELECT * FROM employee_ledger_entries WHERE reverses_id = ? OR idempotency_key = ?", [
    original.id,
    keyed,
  ]);
  if (existing) return existing;

  const block = paymentCorrectionBlock(original);
  if (block) {
    throw conflict(block.message, block.code);
  }

  const amount = round2(Number(original.amount));
  const note = `عكس ${purposeLabel(original.purpose)} — ${reason}`.slice(0, 500);
  const catName = original.category || "salaries";
  const catId = original.category_id ?? null;
  const paymentMethod = PAY_METHODS.has(original.payment_method) ? original.payment_method : "cash";

  const exp = await db.run(
    `INSERT INTO operating_expenses
       (category, category_id, amount, paid_on, payment_method, reference_note, recorded_by_id, source, source_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'employee_payment_reversal', NULL)`,
    [catName, catId, round2(-amount), correctionDate, paymentMethod, note, createdBy ?? null]
  );

  const eventSeq = await nextEmployeeEventSeq(db, original.employee_id);
  const ins = await db.run(
    `INSERT INTO employee_ledger_entries
       (employee_id, entry_type, purpose, occurred_on, amount,
        operating_expense_id, advance_request_id, shift_cash_movement_id,
        idempotency_key, event_seq, created_by, status, reverses_id,
        correction_reason, correction_date)
     VALUES (?, 'salary_payment_reversal', ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'active', ?, ?, ?)`,
    [
      original.employee_id,
      original.purpose,
      correctionDate,
      amount,
      exp.lastID,
      keyed,
      eventSeq,
      createdBy ?? null,
      original.id,
      reason,
      correctionDate,
    ]
  );
  await db.run("UPDATE operating_expenses SET source_id = ? WHERE id = ?", [ins.lastID, exp.lastID]);
  await db.run(
    `UPDATE employee_ledger_entries
     SET status = 'reversed', correction_reason = ?, correction_date = ?
     WHERE id = ?`,
    [reason, correctionDate, original.id]
  );
  await appendEmployeeEvent(db, {
    employeeId: original.employee_id,
    eventDate: correctionDate,
    kind: "salary_payment_reversal",
    eventSeq,
    sourceTable: "employee_ledger_entries",
    sourceId: ins.lastID,
  });
  return db.get("SELECT * FROM employee_ledger_entries WHERE id = ?", [ins.lastID]);
}

async function annotateRecipientInTx(db, original, { intendedEmployeeId, reason, correctionDate }) {
  const intendedId = Number(intendedEmployeeId);
  if (!intendedId) throw badRequest("الموظف المقصود مطلوب", "EMPLOYEE_REQUIRED");
  if (intendedId === Number(original.employee_id)) {
    throw badRequest("المستلم المقصود هو نفس المستلم الفعلي", "SAME_EMPLOYEE");
  }
  if (original.entry_type === "salary_payment_reversal") {
    throw conflict("لا تُعلَّق ملاحظة مستلم على سطر عكس", "NOT_CORRECTABLE");
  }
  const intended = await requireEmployee(db, intendedId);
  await db.run(
    `UPDATE employee_ledger_entries
     SET intended_employee_id = ?, correction_reason = ?, correction_date = ?
     WHERE id = ?`,
    [intended.id, reason, correctionDate, original.id]
  );
  return db.get("SELECT * FROM employee_ledger_entries WHERE id = ?", [original.id]);
}

export async function correctOfficeEmployeePayment(db, employeeId, paymentId, body, req) {
  await requireEmployee(db, employeeId);
  const mode = String(body?.mode || "").trim();
  if (!CORRECTION_MODES.has(mode)) {
    throw badRequest("نوع التصحيح يجب أن يكون عكساً أو استبدالاً أو ملاحظة مستلم", "VALIDATION_ERROR");
  }
  const reason = requireReason(body?.reason);
  const correctionDate = parseYmd(body?.correction_date) || shopTodayYmd();
  if (body?.correction_date && !parseYmd(body.correction_date)) {
    throw badRequest("تاريخ التصحيح يجب أن يكون بصيغة YYYY-MM-DD");
  }

  if (body?.employee_id != null && Number(body.employee_id) !== Number(employeeId)) {
    throw conflict(
      "لا يمكن نقل الدفعة إلى موظف آخر — المبلغ ما زال عند المستلم الفعلي. سجّل ملاحظة المستلم المقصود دون نقل النقد",
      "EMPLOYEE_RECLASS_BLOCKED"
    );
  }

  const result = await withTransaction(db, async () => {
    const original = await loadLedgerWithExpense(db, Number(paymentId));
    if (!original || Number(original.employee_id) !== Number(employeeId)) {
      throw notFound("الدفعة غير موجودة");
    }

    if (mode === "annotate_recipient") {
      const annotated = await annotateRecipientInTx(db, original, {
        intendedEmployeeId: body?.intended_employee_id,
        reason,
        correctionDate,
      });
      return { mode, original: annotated, reversal: null, replacement: null };
    }

    if (mode === "replace" || mode === "reverse") {
      const posBlock = paymentCorrectionBlock({
        ...original,
        status: original.status === "reversed" ? "active" : original.status,
      });
      if (original.advance_request_id || original.shift_cash_movement_id) {
        throw conflict(
          (posBlock && posBlock.message) ||
            "لا يمكن تصحيح سلفة الصندوق من هنا: حركة الدرج تبقى كما سُجّلت في الوردية، ولا يُخترع إرجاع نقد ولا تُعاد كتابة وردية مغلقة",
          "POS_CORRECTION_BLOCKED"
        );
      }
    }

    const existingReversal = await db.get(
      "SELECT * FROM employee_ledger_entries WHERE reverses_id = ?",
      [original.id]
    );

    if (mode === "reverse") {
      const reversal = existingReversal
        ? existingReversal
        : await reverseOfficePaymentInTx(db, original, {
            reason,
            correctionDate,
            createdBy: req?.user?.id ?? null,
          });
      return { mode, original, reversal, replacement: null };
    }

    const newAmount = requirePositiveMoney(body?.amount, "المبلغ الجديد");
    if (existingReversal) {
      const replacementKey = `payment-replace:${original.id}`;
      const replacement = await db.get(
        "SELECT * FROM employee_ledger_entries WHERE idempotency_key = ?",
        [replacementKey]
      );
      if (replacement && round2(Number(replacement.amount)) === newAmount) {
        return { mode, original, reversal: existingReversal, replacement };
      }
      throw conflict("هذه الدفعة مصحّحة مسبقاً", "ALREADY_REVERSED");
    }

    const reversal = await reverseOfficePaymentInTx(db, original, {
      reason,
      correctionDate,
      createdBy: req?.user?.id ?? null,
    });
    const replacement = await postEmployeePaymentInTx(db, {
      employeeId: original.employee_id,
      amount: newAmount,
      occurredOn: correctionDate,
      purpose: original.purpose,
      paymentMethod: PAY_METHODS.has(original.payment_method) ? original.payment_method : "cash",
      referenceNote: reason,
      createdBy: req?.user?.id ?? null,
      note: `تصحيح مبلغ — ${reason}`.slice(0, 500),
      idempotencyKey: `payment-replace:${original.id}`,
      categoryId: original.category_id,
      categoryName: original.category,
    });
    return { mode, original, reversal, replacement };
  });

  if (req) {
    const action =
      mode === "annotate_recipient"
        ? AUDIT_ACTIONS.EMPLOYEE_PAYMENT_ANNOTATE
        : AUDIT_ACTIONS.EMPLOYEE_PAYMENT_CORRECT;
    await logAudit(db, req, action, "employee_ledger_entries", Number(paymentId), null, {
      employee_id: Number(employeeId),
      mode,
      reason,
      correction_date: correctionDate,
      reversal_id: result.reversal?.id ?? null,
      replacement_id: result.replacement?.id ?? null,
      intended_employee_id: result.original?.intended_employee_id ?? null,
    });
  }

  const origMapped = mapLedger(await loadLedgerWithExpense(db, Number(paymentId)));
  return {
    mode: result.mode,
    original: origMapped,
    reversal: result.reversal ? mapLedger(await loadLedgerWithExpense(db, result.reversal.id)) : null,
    replacement: result.replacement
      ? mapLedger(await loadLedgerWithExpense(db, result.replacement.id))
      : null,
  };
}
