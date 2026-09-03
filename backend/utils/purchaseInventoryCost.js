import { round2 } from "./money.js";

/** Extra precision for derived unit costs (matches purchase route). */
export function round6(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

/**
 * Payable inventory value of a purchase/return line.
 * Matches purchase-invoice posting: prefer post-discount `line_total`
 * (VAT-inclusive supplier payable). VAT policy is unchanged.
 */
export function purchaseLineGross(it) {
  if (it?.line_total != null && it.line_total !== "") {
    return Number(it.line_total) || 0;
  }
  return Number(it?.total_cost) || 0;
}

export function purchaseBaseQty(it) {
  if (it?.base_quantity != null && it.base_quantity !== "") {
    return Number(it.base_quantity) || 0;
  }
  return Number(it?.quantity) || 0;
}

export function purchaseBaseUnitCost(it) {
  const qty = purchaseBaseQty(it);
  const gross = purchaseLineGross(it);
  if (qty > 0) return round6(gross / qty);
  return Number(it?.unit_cost) || 0;
}

/**
 * Weighted-average cost after inbound stock.
 * Same formula as purchase invoice posting.
 */
export function wacAfterInbound(oldStock, oldCost, inboundQty, inboundUnitCost) {
  const stock = Number(oldStock) || 0;
  const cost = Number(oldCost) || 0;
  const qty = Number(inboundQty) || 0;
  const unit = Number(inboundUnitCost) || 0;
  const newStock = stock + qty;
  if (newStock > 0) {
    return round2((stock * cost + qty * unit) / newStock);
  }
  return round2(unit);
}

/**
 * Weighted-average cost after a supplier return.
 *
 * Returns are NOT batch-linked (only optional header invoice_id).
 * This reverses the return document's stated inventory value
 * (`line_total / base_quantity`), not a FIFO/LIFO layer.
 *
 * When remaining stock is 0 or negative, keep the last `products.cost`
 * so a later inbound with oldStock<=0 uses incoming cost only.
 */
export function wacAfterOutbound(oldStock, oldCost, outboundQty, outboundUnitCost) {
  const stock = Number(oldStock) || 0;
  const cost = Number(oldCost) || 0;
  const qty = Number(outboundQty) || 0;
  const unit = Number(outboundUnitCost) || 0;
  const newStock = stock - qty;
  if (newStock > 0) {
    const remainingValue = stock * cost - qty * unit;
    if (remainingValue <= 0) return 0;
    return round2(remainingValue / newStock);
  }
  return round2(cost);
}
