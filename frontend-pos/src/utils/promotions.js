/**
 * POS-side mirror of the backend promotion engine (display only).
 * The server recomputes the authoritative discount at checkout, so this is
 * purely to show the customer/cashier the expected discount in the cart.
 */

function r2(n) {
  return Math.round(Number(n) * 100) / 100;
}

const OFFER_PRIORITY = {
  multi_price: 50,
  buy_x_get_y: 40,
  bundle: 30,
  fixed: 20,
  percentage: 10,
};

function promoMatchesLine(promo, line) {
  if (promo.product_id) {
    if (Number(promo.product_id) !== Number(line.product_id)) return false;
    if (promo.product_unit_id != null && promo.product_unit_id !== "") {
      return Number(promo.product_unit_id) === Number(line.product_unit_id);
    }
    return true;
  }
  if (promo.category) return promo.category === line.category;
  return false;
}

function promoRemainingQuota(promo) {
  const limit = Number(promo.limit_qty) || 0;
  if (limit <= 0) return Infinity;
  const used = Number(promo.used_qty) || 0;
  return Math.max(0, limit - used);
}

function sortedPromosForLine(promos, line) {
  return promos
    .filter((p) => promoMatchesLine(p, line))
    .slice()
    .sort(
      (a, b) =>
        (OFFER_PRIORITY[b.offer_type] || 0) - (OFFER_PRIORITY[a.offer_type] || 0)
    );
}

function calcPromoLineDiscount(promo, line, remaining) {
  const qty = Math.max(0, Number(line.quantity) || 0);
  const unit = Math.max(0, Number(line.unitPrice) || 0);
  if (qty <= 0 || unit <= 0) return null;

  let d = 0;
  let unitsUsed = 0;
  const val = Number(promo.discount_value) || 0;

  switch (promo.offer_type) {
    case "percentage": {
      const eligibleQty = remaining === Infinity ? qty : Math.min(qty, remaining);
      const eligibleGross = r2(eligibleQty * unit);
      if (eligibleGross <= 0) return null;
      if (promo.min_amount && eligibleGross < Number(promo.min_amount)) return null;
      d = r2(eligibleGross * (val / 100));
      unitsUsed = eligibleQty;
      break;
    }
    case "fixed": {
      const eligibleQty = remaining === Infinity ? qty : Math.min(qty, remaining);
      const eligibleGross = r2(eligibleQty * unit);
      if (eligibleGross <= 0) return null;
      if (promo.min_amount && eligibleGross < Number(promo.min_amount)) return null;
      d = r2(Math.min(val * eligibleQty, eligibleGross));
      unitsUsed = eligibleQty;
      break;
    }
    case "buy_x_get_y": {
      const buy = Number(promo.buy_qty) || 0;
      const get = Number(promo.get_qty) || 0;
      const group = buy + get;
      if (buy <= 0 || get <= 0 || group <= 0) return null;
      let groups = Math.floor(qty / group);
      if (remaining !== Infinity) {
        groups = Math.min(groups, Math.floor(remaining / group));
      }
      if (groups <= 0) return null;
      const lineGross = r2(qty * unit);
      if (promo.min_amount && lineGross < Number(promo.min_amount)) return null;
      d = r2(groups * get * unit);
      unitsUsed = groups * group;
      break;
    }
    case "bundle": {
      const buy = Number(promo.buy_qty) || 0;
      if (buy <= 0 || qty < buy) return null;
      if (remaining !== Infinity && remaining < buy) return null;
      const lineGross = r2(qty * unit);
      if (promo.min_amount && lineGross < Number(promo.min_amount)) return null;
      d = r2(Math.min(val, lineGross));
      unitsUsed = buy;
      break;
    }
    case "multi_price": {
      const buy = Number(promo.buy_qty) || 0;
      if (buy <= 0) return null;
      let groups = Math.floor(qty / buy);
      if (remaining !== Infinity) {
        groups = Math.min(groups, Math.floor(remaining / buy));
      }
      if (groups <= 0) return null;
      const lineGross = r2(qty * unit);
      if (promo.min_amount && lineGross < Number(promo.min_amount)) return null;
      const savingsPerGroup = Math.max(0, r2(buy * unit - val));
      d = r2(groups * savingsPerGroup);
      unitsUsed = groups * buy;
      break;
    }
    default:
      return null;
  }

  if (d > 0 && unitsUsed > 0) {
    return { discount: d, unitsUsed };
  }
  return null;
}

export function computeCartDiscount(promos, lines) {
  let discount = 0;
  const breakdown = [];
  if (!Array.isArray(promos) || !Array.isArray(lines)) return { discount: 0, breakdown };

  const quotaRemaining = new Map();

  const getRemaining = (promo) => {
    if (!quotaRemaining.has(promo.id)) {
      quotaRemaining.set(promo.id, promoRemainingQuota(promo));
    }
    return quotaRemaining.get(promo.id);
  };

  const consumeQuota = (promo, unitsUsed) => {
    const remaining = getRemaining(promo);
    if (remaining === Infinity) return;
    quotaRemaining.set(promo.id, Math.max(0, remaining - unitsUsed));
  };

  for (const line of lines) {
    const candidates = sortedPromosForLine(promos, line);
    for (const promo of candidates) {
      const remaining = getRemaining(promo);
      if (remaining !== Infinity && remaining <= 0) continue;

      const result = calcPromoLineDiscount(promo, line, remaining);
      if (result) {
        discount = r2(discount + result.discount);
        breakdown.push({
          promotion_id: promo.id,
          name: promo.name,
          product_id: line.product_id,
          product_unit_id: line.product_unit_id ?? null,
          discount: result.discount,
          units_used: result.unitsUsed,
        });
        consumeQuota(promo, result.unitsUsed);
        break;
      }
    }
  }
  return { discount: r2(Math.max(0, discount)), breakdown };
}
