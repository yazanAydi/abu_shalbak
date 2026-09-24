import { createHash } from "node:crypto";
import { insertPostedSupplierPaymentVoucher } from "../routes/vouchers.js";
import { withTransaction } from "../utils/dbTx.js";
import { HttpError, badRequest } from "../utils/httpError.js";
import { round2 } from "../utils/money.js";
import { shopTodayYmd, shopYmdFromTimestamp } from "../utils/shopTime.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { enqueueOperationPrint, printStatusLabel } from "./operationPrintService.js";

export function fingerprintPosSupplierPayment({ supplierId, amount, notes }) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        supplier_id: Number(supplierId) || 0,
        amount: round2(amount),
        notes: notes ? String(notes) : null,
      })
    )
    .digest("hex");
}

export function parsePosSupplierAmount(raw) {
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

export async function listSupplierPaymentOptions(db, q) {
  const term = String(q || "").trim();
  const params = [];
  let sql = "SELECT id, name FROM suppliers";
  if (term) {
    sql += " WHERE name LIKE ?";
    params.push(`%${term}%`);
  }
  sql += " ORDER BY name COLLATE NOCASE, id LIMIT 200";
  return db.all(sql, params);
}

export async function listShiftSupplierPayments(db, shiftId) {
  const rows = await db.all(
    `SELECT
        v.id AS voucher_id,
        v.voucher_no,
        v.total_amount AS amount,
        COALESCE(m.created_at, v.posted_at, v.created_at) AS paid_at,
        v.notes,
        v.recorded_by_id,
        u.username AS cashier_name,
        u.username AS recorded_by_name,
        s.id AS supplier_id,
        s.name AS supplier_name,
        m.id AS movement_id,
        pj.status AS print_status
     FROM shift_cash_movements m
     JOIN vouchers v ON v.id = m.voucher_id
     LEFT JOIN users u ON u.id = v.recorded_by_id
     LEFT JOIN voucher_lines vl ON vl.voucher_id = v.id AND vl.supplier_id IS NOT NULL
     LEFT JOIN suppliers s ON s.id = vl.supplier_id
     LEFT JOIN operation_print_jobs pj
       ON pj.kind = 'supplier_payment' AND pj.reference_id = v.id
     WHERE m.shift_id = ? AND m.movement_type = 'supplier_payment'
     ORDER BY m.created_at ASC, m.id ASC`,
    [shiftId]
  );
  const total = round2(rows.reduce((sum, row) => sum + Number(row.amount || 0), 0));
  return {
    rows: rows.map((row) => ({ ...row, print_label: printStatusLabel(row.print_status) })),
    total,
  };
}

async function loadPaymentResult(db, voucherId, { replayed = false } = {}) {
  const row = await db.get(
    `SELECT
        v.id AS voucher_id,
        v.voucher_no,
        v.total_amount AS amount,
        v.shift_id,
        COALESCE(m.created_at, v.posted_at, v.created_at) AS paid_at,
        v.recorded_by_id,
        s.id AS supplier_id,
        s.name AS supplier_name,
        u.username AS cashier_name,
        u.username AS recorded_by_name,
        m.id AS movement_id
     FROM vouchers v
     LEFT JOIN voucher_lines vl ON vl.voucher_id = v.id AND vl.supplier_id IS NOT NULL
     LEFT JOIN suppliers s ON s.id = vl.supplier_id
     LEFT JOIN users u ON u.id = v.recorded_by_id
     LEFT JOIN shift_cash_movements m ON m.voucher_id = v.id AND m.movement_type = 'supplier_payment'
     WHERE v.id = ?`,
    [voucherId]
  );
  return row ? { ...row, replayed } : null;
}

export async function resolvePosSupplierPaymentIdempotency(db, { key, fingerprint, userId }) {
  const row = await db.get(
    `SELECT id, recorded_by_id, payload_fingerprint FROM vouchers WHERE idempotency_key = ?`,
    [key]
  );
  if (!row) return null;
  if (Number(row.recorded_by_id) !== Number(userId)) {
    throw new HttpError(403, "مفتاح التكرار لا يخص هذا الصندوق", "IDEMPOTENCY_OWNER_MISMATCH");
  }
  if (row.payload_fingerprint && row.payload_fingerprint !== fingerprint) {
    throw new HttpError(
      409,
      "تم استخدام مفتاح التكرار مع محتوى مختلف. لا تُعد الإرسال بمحتوى جديد تحت نفس المفتاح.",
      "IDEMPOTENCY_KEY_REUSE"
    );
  }
  return loadPaymentResult(db, row.id, { replayed: true });
}

function isIdempotencyConstraint(err) {
  return (
    err &&
    String(err.code || "").startsWith("SQLITE_CONSTRAINT") &&
    /idempotency/i.test(String(err.message || ""))
  );
}

function parsePaymentInput(input, actorId) {
  const supplierId = Number(input.supplierId);
  if (!Number.isInteger(supplierId) || supplierId <= 0) {
    throw badRequest("مورد غير صالح", "INVALID_SUPPLIER");
  }
  const amount = parsePosSupplierAmount(input.amount);
  const notes =
    input.notes != null && String(input.notes).trim() !== "" ? String(input.notes).trim() : null;
  const key = String(input.idempotencyKey || "").trim();
  if (key.length < 8 || key.length > 100) {
    throw badRequest("مفتاح التكرار مطلوب (8–100 حرفاً)", "VALIDATION_ERROR");
  }
  return {
    actorId: Number(actorId),
    supplierId,
    amount,
    notes,
    key,
    fingerprint: fingerprintPosSupplierPayment({ supplierId, amount, notes }),
  };
}

function voucherDateForShift(shift) {
  if (shift?.business_day && /^\d{4}-\d{2}-\d{2}$/.test(String(shift.business_day))) {
    return String(shift.business_day);
  }
  return shopYmdFromTimestamp(shift?.start_time) || shopTodayYmd();
}

export async function postLinkedSupplierPayment(db, { shift, parsed, req, paidOn, forgotten = false, managerName = "" }) {
  const supplier = await db.get("SELECT id, name FROM suppliers WHERE id = ?", [parsed.supplierId]);
  if (!supplier) throw badRequest("مورد غير صالح", "INVALID_SUPPLIER");

  const voucher = await insertPostedSupplierPaymentVoucher(db, {
    supplierId: parsed.supplierId,
    amount: parsed.amount,
    paidOn,
    method: "cash",
    note: parsed.notes,
    userId: parsed.actorId,
    shiftId: shift.id,
    idempotencyKey: parsed.key,
    payloadFingerprint: parsed.fingerprint,
  });

  const movement = await db.run(
    `INSERT INTO shift_cash_movements (shift_id, movement_type, amount, description, voucher_id)
     VALUES (?, 'supplier_payment', ?, ?, ?)`,
    [shift.id, -parsed.amount, `دفع لمورد — ${supplier.name} سند #${voucher.voucher_no}`, voucher.id]
  );

  const cashier = await db.get("SELECT username FROM users WHERE id = ?", [shift.cashier_id]);
  const recorder = await db.get("SELECT username FROM users WHERE id = ?", [parsed.actorId]);
  await enqueueOperationPrint(db, {
    kind: "supplier_payment",
    referenceId: voucher.id,
    cashierId: shift.cashier_id,
    shiftId: shift.id,
    documentNo: String(voucher.voucher_no),
    snapshot: {
      title: "دفع لمورد",
      documentNo: String(voucher.voucher_no),
      timestamp: new Date().toISOString(),
      businessDay: paidOn,
      cashierName: cashier?.username || "",
      shiftId: shift.id,
      partyLabel: `المورد: ${supplier.name}`,
      lines: forgotten
        ? ["تسجيل دفعة سابقة من الصندوق. هذه ليست تعليمات بالدفع مرة أخرى."]
        : ["دفع نقدي من الصندوق"],
      note: parsed.notes,
      amountLabel: `المبلغ المدفوع ${parsed.amount.toFixed(2)} شيقل`,
      footer: forgotten ? "دفعة سابقة مُسجّلة أثناء العد" : "دفع نقدي من الصندوق",
      managerName: managerName || (forgotten ? recorder?.username || "" : ""),
    },
  });

  if (req) {
    await logAudit(db, req, AUDIT_ACTIONS.VOUCHER_POST, "vouchers", voucher.id, null, {
      supplier_id: parsed.supplierId,
      amount: parsed.amount,
      shift_id: shift.id,
      movement_id: movement.lastID,
      recorded_by_id: parsed.actorId,
    });
  }

  return loadPaymentResult(db, voucher.id, { replayed: false });
}

async function runSupplierPayment(db, { parsed, resolveShift, req, paidOnForShift, forgotten = false }) {
  try {
    return await withTransaction(db, async () => {
      const existing = await resolvePosSupplierPaymentIdempotency(db, {
        key: parsed.key,
        fingerprint: parsed.fingerprint,
        userId: parsed.actorId,
      });
      if (existing) return existing;
      const shift = await resolveShift();
      return postLinkedSupplierPayment(db, {
        shift,
        parsed,
        req,
        paidOn: paidOnForShift(shift),
        forgotten,
      });
    });
  } catch (err) {
    if (isIdempotencyConstraint(err)) {
      const replay = await resolvePosSupplierPaymentIdempotency(db, {
        key: parsed.key,
        fingerprint: parsed.fingerprint,
        userId: parsed.actorId,
      });
      if (replay) return replay;
    }
    throw err;
  }
}

/**
 * Cash handed to a supplier from the cashier's open drawer.
 * Posts one payment voucher and one negative shift cash movement.
 */
export async function postPosSupplierPayment(db, input) {
  const parsed = parsePaymentInput(input, input.cashierId);
  return runSupplierPayment(db, {
    parsed,
    req: input.req,
    paidOnForShift: () => shopTodayYmd(),
    resolveShift: async () => {
      const shift = await db.get(
        `SELECT * FROM cashier_shifts WHERE cashier_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`,
        [parsed.actorId]
      );
      if (!shift) {
        const err = new Error("لا توجد وردية مفتوحة");
        err.status = 400;
        err.code = "NO_OPEN_SHIFT";
        throw err;
      }
      return shift;
    },
  });
}

/**
 * Forgotten cash already handed to a supplier during a shift waiting to be counted.
 * Uses the selected shift, not the office user's current shift.
 */
export async function requirePendingCountShift(db, shiftId) {
  const id = Number(shiftId);
  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest("معرّف الوردية غير صالح", "INVALID_SHIFT");
  }
  const locked = await db.run(
    `UPDATE cashier_shifts SET status = status WHERE id = ? AND status = 'pending_count'`,
    [id]
  );
  const shift = await db.get("SELECT * FROM cashier_shifts WHERE id = ?", [id]);
  if (!shift) {
    const err = new Error("الوردية غير موجودة");
    err.status = 404;
    err.code = "NOT_FOUND";
    throw err;
  }
  if (shift.status === "closed" || (!locked.changes && shift.status === "closed")) {
    const err = new Error("لا يمكن تسجيل دفعة على وردية مغلقة");
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
  return shift;
}

export async function postShiftSupplierPayment(db, input) {
  const parsed = parsePaymentInput(input, input.userId);
  return runSupplierPayment(db, {
    parsed,
    req: input.req,
    forgotten: true,
    paidOnForShift: voucherDateForShift,
    resolveShift: () => requirePendingCountShift(db, input.shiftId),
  });
}
