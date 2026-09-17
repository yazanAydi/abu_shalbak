import { badRequest } from "./httpError.js";

export const CHECKOUT_NOTES_MAX = 500;

export function checkoutPayloadHasOnAccount(body = {}) {
  if (body.payment_method === "on_account") return true;
  return Array.isArray(body.payments) && body.payments.some((p) => p?.method === "on_account");
}

/**
 * Trim ends, keep internal newlines, drop control characters.
 * Empty / whitespace-only → null (valid).
 */
export function normalizeCheckoutNotes(value) {
  if (value == null) return null;
  const s = String(value)
    .replace(/\0/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  const trimmed = s.trim();
  return trimmed || null;
}

export function parseCheckoutNotes(value) {
  const notes = normalizeCheckoutNotes(value);
  if (notes && notes.length > CHECKOUT_NOTES_MAX) {
    throw badRequest("الملاحظات يجب ألا تتجاوز 500 حرف", "NOTES_TOO_LONG");
  }
  return notes;
}

/** Cashier ذمة notes only. Ignored for cash/visa/mixed. */
export function resolveCheckoutNotes(body) {
  if (!checkoutPayloadHasOnAccount(body)) return null;
  return parseCheckoutNotes(body?.notes);
}
