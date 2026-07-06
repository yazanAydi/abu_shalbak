import { refundedQtyByProduct } from "../services/refundRequestService.js";

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

export function parseTransactionItems(itemsJson) {
  try {
    const arr = JSON.parse(itemsJson);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function buildItemsPreview(items, maxItems = 3) {
  const parts = [];
  for (const it of items.slice(0, maxItems)) {
    const name = String(it.name || "").trim() || "صنف";
    const qty = Number(it.quantity) || 0;
    parts.push(qty > 1 ? `${name} ×${qty}` : name);
  }
  if (items.length > maxItems) parts.push("…");
  return parts.join("، ");
}

export async function buildSaleSummary(db, tx) {
  const items = parseTransactionItems(tx.items_json);
  const item_count = items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
  const items_preview = buildItemsPreview(items);
  const already = await refundedQtyByProduct(db, tx.id);

  let fully_refunded = items.length > 0;
  for (const it of items) {
    const pid = Number(it.product_id);
    const uid = Number(it.unit_id ?? it.product_unit_id ?? 0);
    const sold = Number(it.quantity) || 0;
    const ref =
      already.get(`${pid}:${uid}`) ??
      already.get(`${pid}:0`) ??
      already.get(pid) ??
      0;
    if (Math.max(0, sold - ref) > 0) {
      fully_refunded = false;
      break;
    }
  }
  if (items.length === 0) fully_refunded = false;

  return {
    transaction_id: tx.id,
    receipt_number: tx.receipt_number || null,
    created_at: tx.created_at,
    total: round2(Number(tx.total)),
    payment_method: tx.payment_method,
    item_count,
    items_preview,
    fully_refunded,
    returnable: !fully_refunded,
  };
}
