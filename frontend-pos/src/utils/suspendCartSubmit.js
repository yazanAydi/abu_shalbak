import { newIdempotencyKey } from "./completeSaleSubmit";
import { cartItemsToSuspendPayload } from "./suspendedCart";

export function suspendPayloadSignature(items, { note = null, customerId = null, employeeId = null } = {}) {
  return JSON.stringify({
    items: cartItemsToSuspendPayload(items),
    note: note ?? null,
    customerId: customerId || null,
    employeeId: employeeId || null,
  });
}

/**
 * A restored cart updates its saved id. A new cart creates once.
 * An unanswered create keeps its idempotency key so a retry cannot insert a second row.
 */
export function resolveSuspendAttempt({ activeSaleId, outstandingKey }) {
  if (activeSaleId) return { mode: "update" };
  if (outstandingKey) return { mode: "create", idempotencyKey: outstandingKey, reuse: true };
  return { mode: "create", idempotencyKey: newIdempotencyKey(), reuse: false };
}

export function buildSuspendRequest({
  saleId = null,
  items,
  note = null,
  version = null,
  customerId = null,
  employeeId = null,
  idempotencyKey = null,
  preserveParty = false,
}) {
  const body = { items: cartItemsToSuspendPayload(items) };
  if (!preserveParty) {
    body.note = note ?? null;
    body.customer_id = customerId ? Number(customerId) : null;
    body.employee_id = employeeId ? Number(employeeId) : null;
  }
  if (saleId) {
    if (version != null) body.version = Number(version);
    return { method: "put", url: `/api/suspended-sales/${saleId}`, body };
  }
  body.idempotency_key = idempotencyKey;
  return { method: "post", url: "/api/suspended-sales", body };
}
