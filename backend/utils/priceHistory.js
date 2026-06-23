import { logAudit, AUDIT_ACTIONS } from "./auditLog.js";

/**
 * Record a selling-price change: append an immutable product_price_history row
 * and write an audit log entry. The caller is responsible for having already
 * updated products.price (ideally inside the same DB transaction).
 *
 * @param {object} db
 * @param {import('express').Request} req used for audit user/ip context
 * @param {object} opts
 * @param {number} opts.productId
 * @param {number|null} opts.oldPrice
 * @param {number} opts.newPrice
 * @param {string|null} [opts.reason]
 * @returns {Promise<{ historyId: number }>}
 */
export async function recordPriceChange(db, req, { productId, oldPrice, newPrice, reason = null }) {
  const pid = Number(productId);
  const oldP = oldPrice == null ? null : Number(oldPrice);
  const newP = Number(newPrice);
  const userId = req?.user?.id ?? null;
  const cleanReason = reason != null && String(reason).trim() !== "" ? String(reason).trim() : null;

  const ins = await db.run(
    `INSERT INTO product_price_history
       (product_id, old_price, new_price, changed_by_user_id, reason)
     VALUES (?, ?, ?, ?, ?)`,
    [pid, oldP, newP, userId, cleanReason]
  );

  await logAudit(
    db,
    req,
    AUDIT_ACTIONS.PRICE_CHANGE,
    "products",
    pid,
    { price: oldP },
    { price: newP, reason: cleanReason }
  );

  return { historyId: ins.lastID };
}
