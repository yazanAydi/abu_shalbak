/**
 * Audit logging for sensitive operations.
 */

export const AUDIT_ACTIONS = {
  PRODUCT_CREATE: "PRODUCT_CREATE",
  PRODUCT_UPDATE: "PRODUCT_UPDATE",
  PRODUCT_DELETE: "PRODUCT_DELETE",
  PRICE_CHANGE: "PRICE_CHANGE",
  USER_CREATE: "USER_CREATE",
  USER_UPDATE: "USER_UPDATE",
  USER_DELETE: "USER_DELETE",
  PERMISSION_CHANGE: "PERMISSION_CHANGE",
  REFUND_CREATE: "REFUND_CREATE",
  REFUND_REQUEST_CREATE: "REFUND_REQUEST_CREATE",
  REFUND_REQUEST_APPROVE: "REFUND_REQUEST_APPROVE",
  REFUND_REQUEST_REJECT: "REFUND_REQUEST_REJECT",
  SHIFT_OPEN: "SHIFT_OPEN",
  SHIFT_CLOSE: "SHIFT_CLOSE",
  SHIFT_ADJUST: "SHIFT_ADJUST",
  SHIFT_APPROVE: "SHIFT_APPROVE",
  SHIFT_RECONCILE: "SHIFT_RECONCILE",
  CASH_MOVEMENT: "CASH_MOVEMENT",
  INVENTORY_ADJUST: "INVENTORY_ADJUST",
  INVENTORY_COUNT: "INVENTORY_COUNT",
  PURCHASE_RECEIVE: "PURCHASE_RECEIVE",
  WAREHOUSE_TRANSFER: "WAREHOUSE_TRANSFER",
  SETTINGS_UPDATE: "SETTINGS_UPDATE",
  SUPPLIER_BALANCE: "SUPPLIER_BALANCE",
  CUSTOMER_BALANCE: "CUSTOMER_BALANCE",
  VOUCHER_POST: "VOUCHER_POST",
  VOUCHER_DELETE: "VOUCHER_DELETE",
  BACKUP_CREATE: "BACKUP_CREATE",
  TRANSACTION_VOID: "TRANSACTION_VOID",
};

function safeJson(value) {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "unserializable" });
  }
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

/**
 * @param {object} db
 * @param {import('express').Request} req
 * @param {string} action
 * @param {string|null} entityType
 * @param {number|string|null} entityId
 * @param {object|null} oldValue
 * @param {object|null} newValue
 */
export async function logAudit(
  db,
  req,
  action,
  entityType = null,
  entityId = null,
  oldValue = null,
  newValue = null
) {
  const user = req.user || {};
  await db.run(
    `INSERT INTO audit_logs
       (user_id, username, role, action, entity_type, entity_id, old_value, new_value, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user.id ?? null,
      user.username ?? null,
      user.role ?? null,
      action,
      entityType,
      entityId != null ? Number(entityId) : null,
      safeJson(oldValue),
      safeJson(newValue),
      clientIp(req),
      req.headers["user-agent"] ?? null,
    ]
  );
}

/**
 * @param {object} db
 * @param {{ id?: number, username?: string, role?: string }} user
 */
export async function logAuditUser(
  db,
  user,
  action,
  entityType = null,
  entityId = null,
  oldValue = null,
  newValue = null
) {
  await db.run(
    `INSERT INTO audit_logs
       (user_id, username, role, action, entity_type, entity_id, old_value, new_value, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user?.id ?? null,
      user?.username ?? null,
      user?.role ?? null,
      action,
      entityType,
      entityId != null ? Number(entityId) : null,
      safeJson(oldValue),
      safeJson(newValue),
      null,
      null,
    ]
  );
}
