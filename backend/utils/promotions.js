/**
 * Promotion engine (shared logic). Pure functions, no imports.
 *
 * A promotion never changes a product's unit price (that would trip the
 * checkout PRICE_MISMATCH guard). Instead it produces a discount amount that
 * is subtracted from the order total: total = subtotal + tax - discount.
 *
 * offer_type:
 *   percentage   -> discount_value is a percent (e.g. 10 = 10% off matching lines)
 *   fixed        -> discount_value is an amount off PER UNIT of matching lines
 *   buy_x_get_y  -> buy_qty + get_qty: cheapest get_qty units per group are free
 *   bundle       -> flat discount_value off once a line reaches buy_qty units
 */

function r2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function promoMatchesLine(promo, line) {
  if (promo.product_id) return Number(promo.product_id) === Number(line.product_id);
  if (promo.category) return promo.category === line.category;
  return false;
}

/**
 * @param {Array} promos active promotions
 * @param {Array<{product_id:number, category?:string, quantity:number, unitPrice:number}>} lines
 * @returns {{ discount:number, breakdown:Array }}
 */
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
            const freeUnits = Math.floor(qty / group) * get;
            d = r2(freeUnits * unit);
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

/** Build the SQL WHERE for active promotions (active + within date window). */
export async function getActivePromotions(db) {
  return db.all(
    `SELECT p.* FROM promotions p
     LEFT JOIN campaigns c ON c.id = p.campaign_id
     WHERE p.active = 1
       AND (p.campaign_id IS NULL OR c.active = 1)
       AND (p.start_date IS NULL OR date(p.start_date) <= date('now'))
       AND (p.end_date IS NULL OR date(p.end_date) >= date('now'))
       AND (c.start_date IS NULL OR date(c.start_date) <= date('now'))
       AND (c.end_date IS NULL OR date(c.end_date) >= date('now'))`
  );
}
