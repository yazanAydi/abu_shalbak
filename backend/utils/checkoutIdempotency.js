import { createHash } from "node:crypto";
import { HttpError } from "./httpError.js";
import { checkoutPayloadHasOnAccount, normalizeCheckoutNotes } from "./checkoutNotes.js";

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function qtyOrPrice(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

/**
 * SHA-256 of normalized items, payments, customer, and suspended sale id.
 */
export function fingerprintCheckoutPayload(body = {}) {
  const items = (body.items || [])
    .map((i) => ({
      product_id: Number(i.product_id) || 0,
      unit_id: numOrNull(i.unit_id ?? i.product_unit_id),
      quantity: qtyOrPrice(i.quantity),
      price: qtyOrPrice(i.price),
    }))
    .sort(
      (a, b) =>
        a.product_id - b.product_id || (a.unit_id || 0) - (b.unit_id || 0) || a.quantity - b.quantity
    );

  const payments = (body.payments || [])
    .map((p) => ({
      method: p.method || null,
      amount: p.amount != null ? qtyOrPrice(p.amount) : null,
      original_amount: p.original_amount != null ? qtyOrPrice(p.original_amount) : null,
      currency_id: numOrNull(p.currency_id),
    }))
    .sort((a, b) => String(a.method).localeCompare(String(b.method)));

  const canonicalObj = {
    items,
    payments,
    payment_method: body.payment_method || null,
    customer_id: numOrNull(body.customer_id),
    suspended_sale_id: numOrNull(body.suspended_sale_id),
  };
  const employeeId = numOrNull(body.employee_id);
  if (employeeId != null) canonicalObj.employee_id = employeeId;
  if (checkoutPayloadHasOnAccount(body)) {
    const notes = normalizeCheckoutNotes(body.notes);
    if (notes) canonicalObj.notes = notes;
  }
  const canonical = JSON.stringify(canonicalObj);
  return createHash("sha256").update(canonical).digest("hex");
}

function assertOwner(storedCashierId, userId) {
  if (Number(storedCashierId) !== Number(userId)) {
    throw new HttpError(403, "مفتاح التكرار لا يخص هذا الصندوق", "IDEMPOTENCY_OWNER_MISMATCH");
  }
}

function assertFingerprint(storedFp, incomingFp) {
  if (storedFp == null || storedFp === "") return;
  if (storedFp !== incomingFp) {
    throw new HttpError(
      409,
      "تم استخدام مفتاح التكرار مع محتوى مختلف. لا تُعد الإرسال بمحتوى جديد تحت نفس المفتاح.",
      "IDEMPOTENCY_KEY_REUSE"
    );
  }
}

/**
 * Look up a checkout key across completed sales and ذمة requests.
 * Must run inside the same write transaction as the subsequent insert.
 */
export async function resolveCheckoutIdempotency(db, { key, fingerprint, userId }) {
  const sale = await db.get(
    `SELECT id, cashier_id, payload_fingerprint
     FROM transactions WHERE idempotency_key = ?`,
    [key]
  );
  const oa = await db.get(
    `SELECT id, cashier_id, payload_fingerprint, status, transaction_id
     FROM on_account_requests WHERE idempotency_key = ?`,
    [key]
  );

  if (sale) {
    assertOwner(sale.cashier_id, userId);
    assertFingerprint(sale.payload_fingerprint, fingerprint);
    return { kind: "sale", transactionId: sale.id };
  }

  if (oa) {
    assertOwner(oa.cashier_id, userId);
    assertFingerprint(oa.payload_fingerprint, fingerprint);
    if (oa.status === "pending") {
      return { kind: "oa_pending", requestId: oa.id };
    }
    if (oa.status === "approved" && oa.transaction_id) {
      return { kind: "sale", transactionId: oa.transaction_id };
    }
    if (oa.status === "approved") {
      return { kind: "oa_pending", requestId: oa.id };
    }
    throw new HttpError(
      409,
      "طلب الذمة لهذا المفتاح مرفوض أو منتهٍ",
      "IDEMPOTENCY_REQUEST_REJECTED"
    );
  }

  return { kind: "proceed" };
}
