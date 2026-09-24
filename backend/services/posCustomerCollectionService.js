import { createHash } from "node:crypto";
import { insertPostedCustomerReceiptVoucher } from "../routes/vouchers.js";
import { withTransaction } from "../utils/dbTx.js";
import { getEmployeeLinkedToCustomer, sqlOrdinaryCustomer } from "../utils/employeeCustomer.js";
import { HttpError, badRequest } from "../utils/httpError.js";
import { round2 } from "../utils/money.js";
import { shopTodayYmd } from "../utils/shopTime.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";

export const CUSTOMER_COLLECTION_MOVEMENT = "customer_collection";

export function fingerprintPosCustomerCollection({ customerId, amount, notes }) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        customer_id: Number(customerId) || 0,
        amount: round2(amount),
        notes: notes ? String(notes) : null,
      })
    )
    .digest("hex");
}

export function parsePosCustomerAmount(raw) {
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

export function outstandingDebt(balance) {
  const n = round2(Number(balance) || 0);
  return n > 0 ? n : 0;
}

export async function listCustomerCollectionOptions(db, q) {
  const term = String(q || "").trim();
  const params = [];
  let sql = `SELECT c.id, c.name FROM customers c WHERE ${sqlOrdinaryCustomer("c")}`;
  if (term) {
    sql += " AND (c.name LIKE ? OR c.phone LIKE ? OR c.customer_code LIKE ?)";
    params.push(`%${term}%`, `%${term}%`, `%${term}%`);
  }
  sql += " ORDER BY c.name COLLATE NOCASE, c.id LIMIT 200";
  return db.all(sql, params);
}

export async function getCustomerCollectionOption(db, customerId) {
  const id = Number(customerId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await db.get(
    `SELECT c.id, c.name, c.balance FROM customers c WHERE c.id = ? AND ${sqlOrdinaryCustomer("c")}`,
    [id]
  );
  if (!row) return null;
  return { id: row.id, name: row.name, outstanding: outstandingDebt(row.balance) };
}

export async function listShiftCustomerCollections(db, shiftId) {
  const rows = await db.all(
    `SELECT
        v.id AS voucher_id,
        v.voucher_no,
        v.total_amount AS amount,
        COALESCE(m.created_at, v.posted_at, v.created_at) AS collected_at,
        v.notes,
        v.recorded_by_id,
        u.username AS cashier_name,
        u.username AS recorded_by_name,
        c.id AS customer_id,
        c.name AS customer_name,
        m.id AS movement_id
     FROM shift_cash_movements m
     JOIN vouchers v ON v.id = m.voucher_id
     LEFT JOIN users u ON u.id = v.recorded_by_id
     LEFT JOIN voucher_lines vl ON vl.voucher_id = v.id AND vl.customer_id IS NOT NULL
     LEFT JOIN customers c ON c.id = vl.customer_id
     WHERE m.shift_id = ? AND m.movement_type = ?
     ORDER BY m.created_at ASC, m.id ASC`,
    [shiftId, CUSTOMER_COLLECTION_MOVEMENT]
  );
  const total = round2(rows.reduce((sum, row) => sum + Number(row.amount || 0), 0));
  return { rows, total };
}

async function loadCollectionResult(db, voucherId, { replayed = false } = {}) {
  const row = await db.get(
    `SELECT
        v.id AS voucher_id,
        v.voucher_no,
        v.total_amount AS amount,
        v.shift_id,
        COALESCE(m.created_at, v.posted_at, v.created_at) AS collected_at,
        v.notes,
        v.recorded_by_id,
        c.id AS customer_id,
        c.name AS customer_name,
        c.balance AS customer_balance,
        u.username AS cashier_name,
        u.username AS recorded_by_name,
        m.id AS movement_id
     FROM vouchers v
     LEFT JOIN voucher_lines vl ON vl.voucher_id = v.id AND vl.customer_id IS NOT NULL
     LEFT JOIN customers c ON c.id = vl.customer_id
     LEFT JOIN users u ON u.id = v.recorded_by_id
     LEFT JOIN shift_cash_movements m ON m.voucher_id = v.id AND m.movement_type = ?
     WHERE v.id = ?`,
    [CUSTOMER_COLLECTION_MOVEMENT, voucherId]
  );
  if (!row) return null;
  return {
    voucher_id: row.voucher_id,
    voucher_no: row.voucher_no,
    amount: round2(Number(row.amount) || 0),
    shift_id: row.shift_id,
    collected_at: row.collected_at,
    notes: row.notes,
    recorded_by_id: row.recorded_by_id,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    cashier_name: row.cashier_name,
    recorded_by_name: row.recorded_by_name,
    movement_id: row.movement_id,
    remaining_debt: outstandingDebt(row.customer_balance),
    replayed,
  };
}

export async function resolvePosCustomerCollectionIdempotency(db, { key, fingerprint, userId }) {
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
  return loadCollectionResult(db, row.id, { replayed: true });
}

function isIdempotencyConstraint(err) {
  return (
    err &&
    String(err.code || "").startsWith("SQLITE_CONSTRAINT") &&
    /idempotency/i.test(String(err.message || ""))
  );
}

function parseCollectionInput(input, actorId) {
  const customerId = Number(input.customerId);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    throw badRequest("عميل غير صالح", "INVALID_CUSTOMER");
  }
  const amount = parsePosCustomerAmount(input.amount);
  const notes =
    input.notes != null && String(input.notes).trim() !== "" ? String(input.notes).trim() : null;
  const key = String(input.idempotencyKey || "").trim();
  if (key.length < 8 || key.length > 100) {
    throw badRequest("مفتاح التكرار مطلوب (8–100 حرفاً)", "VALIDATION_ERROR");
  }
  return {
    actorId: Number(actorId),
    customerId,
    amount,
    notes,
    key,
    fingerprint: fingerprintPosCustomerCollection({ customerId, amount, notes }),
  };
}

async function assertOrdinaryCollectableCustomer(db, customerId) {
  const linked = await getEmployeeLinkedToCustomer(db, customerId);
  if (linked) {
    throw badRequest("هذا حساب ذمة موظف ولا يُحصَّل من قبض العملاء", "EMPLOYEE_ACCOUNT");
  }
  const customer = await db.get("SELECT id, name, balance FROM customers WHERE id = ?", [customerId]);
  if (!customer) throw badRequest("عميل غير صالح", "INVALID_CUSTOMER");
  return customer;
}

async function postLinkedCustomerCollection(db, { shift, parsed, req }) {
  await db.run("UPDATE customers SET balance = COALESCE(balance, 0) WHERE id = ?", [parsed.customerId]);
  const customer = await assertOrdinaryCollectableCustomer(db, parsed.customerId);
  const remaining = outstandingDebt(customer.balance);
  if (remaining < 0.009) {
    throw badRequest("لا توجد ذمة على هذا العميل", "NO_OUTSTANDING_DEBT");
  }
  if (parsed.amount - remaining > 0.009) {
    throw badRequest(
      `المبلغ أكبر من الذمة المتبقية (₪${remaining.toFixed(2)})`,
      "AMOUNT_EXCEEDS_DEBT"
    );
  }

  const voucher = await insertPostedCustomerReceiptVoucher(db, {
    customerId: parsed.customerId,
    amount: parsed.amount,
    paidOn: shopTodayYmd(),
    method: "cash",
    note: parsed.notes,
    userId: parsed.actorId,
    shiftId: shift.id,
    idempotencyKey: parsed.key,
    payloadFingerprint: parsed.fingerprint,
  });

  const movement = await db.run(
    `INSERT INTO shift_cash_movements (shift_id, movement_type, amount, description, voucher_id)
     VALUES (?, 'customer_collection', ?, ?, ?)`,
    [
      shift.id,
      parsed.amount,
      `تحصيل ذمة — ${customer.name} سند #${voucher.voucher_no}`,
      voucher.id,
    ]
  );

  if (req) {
    await logAudit(db, req, AUDIT_ACTIONS.VOUCHER_POST, "vouchers", voucher.id, null, {
      customer_id: parsed.customerId,
      amount: parsed.amount,
      shift_id: shift.id,
      movement_id: movement.lastID,
      recorded_by_id: parsed.actorId,
      movement_type: CUSTOMER_COLLECTION_MOVEMENT,
    });
  }

  return loadCollectionResult(db, voucher.id, { replayed: false });
}

/**
 * Cash received against an ordinary customer's existing debt.
 * One posted receipt voucher reduces the balance once.
 * Drawer cash counts that receipt only through the linked inflow movement.
 */
export async function postPosCustomerCollection(db, input) {
  const parsed = parseCollectionInput(input, input.cashierId);
  try {
    return await withTransaction(db, async () => {
      const existing = await resolvePosCustomerCollectionIdempotency(db, {
        key: parsed.key,
        fingerprint: parsed.fingerprint,
        userId: parsed.actorId,
      });
      if (existing) return existing;

      const locked = await db.run(
        `UPDATE cashier_shifts SET status = status WHERE cashier_id = ? AND status = 'open'`,
        [parsed.actorId]
      );
      const shift = await db.get(
        `SELECT * FROM cashier_shifts WHERE cashier_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`,
        [parsed.actorId]
      );
      if (!shift || !locked.changes) {
        const err = new Error("لا توجد وردية مفتوحة");
        err.status = 400;
        err.code = "NO_OPEN_SHIFT";
        throw err;
      }
      return postLinkedCustomerCollection(db, { shift, parsed, req: input.req });
    });
  } catch (err) {
    if (isIdempotencyConstraint(err)) {
      const replay = await resolvePosCustomerCollectionIdempotency(db, {
        key: parsed.key,
        fingerprint: parsed.fingerprint,
        userId: parsed.actorId,
      });
      if (replay) return replay;
    }
    throw err;
  }
}
