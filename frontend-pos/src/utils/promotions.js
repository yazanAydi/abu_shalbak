/**
 * POS-side mirror of the backend promotion engine (display only).
 * The server recomputes the authoritative discount at checkout, so this is
 * purely to show the customer/cashier the expected discount in the cart.
 */

function r2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function promoMatchesLine(promo, line) {
  if (promo.product_id) return Number(promo.product_id) === Number(line.product_id);
  if (promo.category) return promo.category === line.category;
  return false;
}

export function computeCartDiscount(promos, lines) {
  let discount = 0;
  const breakdown = [];
  if (!Array.isArray(promos) || !Array.isArray(lines)) return { discount: 0, breakdown };

  for (const promo of promos) {
    for (const line of lines) {
      if (!promoMatchesLine(promo, line)) continue;
      const qty = Math.max(0, Number(line.quantity) || 0);
      const unit = Math.max(0, Number(line.unitPrice) || 0);
      const lineGross = r2(qty * unit);
      if (qty <= 0 || lineGross <= 0) continue;
      if (promo.min_amount && lineGross < Number(promo.min_amount)) continue;

      let d = 0;
      const val = Number(promo.discount_value) || 0;
      switch (promo.offer_type) {
        case "percentage":
          d = r2(lineGross * (val / 100));
          break;
        case "fixed":
          d = r2(Math.min(val * qty, lineGross));
          break;
        case "buy_x_get_y": {
          const buy = Number(promo.buy_qty) || 0;
          const get = Number(promo.get_qty) || 0;
          const group = buy + get;
          if (buy > 0 && get > 0 && group > 0) {
            d = r2(Math.floor(qty / group) * get * unit);
          }
          break;
        }
        case "bundle": {
          const buy = Number(promo.buy_qty) || 0;
          if (buy > 0 && qty >= buy) d = r2(Math.min(val, lineGross));
          break;
        }
        default:
          d = 0;
      }
      if (d > 0) {
        discount = r2(discount + d);
        breakdown.push({ promotion_id: promo.id, name: promo.name, product_id: line.product_id, discount: d });
      }
    }
  }
  return { discount: r2(Math.max(0, discount)), breakdown };
}
