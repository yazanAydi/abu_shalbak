import { Router } from "express";
import { requireAuth, requireOfficeRole } from "../middleware/auth.js";
import { getAppSettings } from "../utils/settings.js";
import {
  fetchNearExpiryItems,
  resolveExpiryAlertDays,
} from "../services/expiryAlertService.js";
import {
  hasAccountantPermission,
  NAV_PATH_PERMISSION_KEYS,
} from "../utils/accountantPermissions.js";
import { isAdmin } from "../utils/roles.js";

const LOW_STOCK_THRESHOLD = 5;

async function countLowStockByScope(db, scope, threshold = LOW_STOCK_THRESHOLD) {
  const t = Math.max(0, Number(threshold) || LOW_STOCK_THRESHOLD);
  const row = await db.get(
    `SELECT COUNT(*) AS total FROM products
     WHERE (
       (min_stock IS NOT NULL AND stock <= min_stock)
       OR (min_stock IS NULL AND stock <= ?)
     )
     AND COALESCE(inventory_scope, 'retail') = ?`,
    [t, scope]
  );
  return Number(row?.total) || 0;
}

async function countNegativeStockRetail(db) {
  const row = await db.get(
    `SELECT COUNT(*) AS total FROM products
     WHERE COALESCE(stock, 0) < 0
       AND COALESCE(inventory_scope, 'retail') = 'retail'`
  );
  return Number(row?.total) || 0;
}

async function countNearExpiry(db) {
  const days = await resolveExpiryAlertDays(db);
  const { products, batches } = await fetchNearExpiryItems(db, days);
  return products.length + batches.length;
}

async function countExpiryPageAlerts(db) {
  const days = await resolveExpiryAlertDays(db);
  const { products, batches } = await fetchNearExpiryItems(db, days);
  const nearExpiry = products.length + batches.length;

  const t = Math.max(0, Number(LOW_STOCK_THRESHOLD) || LOW_STOCK_THRESHOLD);
  const row = await db.get(
    `SELECT COUNT(*) AS total FROM products
     WHERE (
       (min_stock IS NOT NULL AND stock <= min_stock)
       OR (min_stock IS NULL AND stock <= ?)
     )
     AND COALESCE(inventory_scope, 'retail') = 'retail'
     AND NOT (
       expiry_date IS NOT NULL AND expiry_date != ''
       AND stock > 0
       AND julianday(expiry_date) <= julianday('now', '+' || ? || ' days')
     )`,
    [t, days]
  );
  const lowStockOnly = Number(row?.total) || 0;
  return nearExpiry + lowStockOnly;
}

async function countPendingRefunds(db) {
  const row = await db.get(
    `SELECT COUNT(*) AS count FROM refund_requests WHERE status = 'pending'`
  );
  return Number(row?.count) || 0;
}

async function countPendingOnAccountRequests(db) {
  const row = await db.get(
    `SELECT COUNT(*) AS count FROM on_account_requests WHERE status = 'pending'`
  );
  return Number(row?.count) || 0;
}

async function countPendingAdvanceRequests(db) {
  const row = await db.get(
    `SELECT COUNT(*) AS count FROM advance_requests WHERE status = 'pending'`
  );
  return Number(row?.count) || 0;
}

async function countPendingShiftCount(db) {
  const row = await db.get(
    `SELECT COUNT(*) AS count FROM cashier_shifts WHERE status = 'pending_count'`
  );
  return Number(row?.count) || 0;
}

function filterBadgesForUser(role, permissions, byPath) {
  if (isAdmin(role)) return byPath;
  /** @type {Record<string, number>} */
  const filtered = {};
  for (const [path, count] of Object.entries(byPath)) {
    const key = NAV_PATH_PERMISSION_KEYS[path];
    if (key && !hasAccountantPermission(role, permissions, key)) {
      filtered[path] = 0;
    } else {
      filtered[path] = count;
    }
  }
  return filtered;
}

export function createOfficeRouter(db) {
  const router = Router();

  router.get("/nav-badges", requireAuth, requireOfficeRole(), async (req, res) => {
    const [
      retailLowStock,
      bakeryLowStock,
      nearExpiry,
      expiryPageAlerts,
      negativeStock,
      pendingRefunds,
      pendingOnAccount,
      pendingAdvances,
      pendingShiftCount,
    ] = await Promise.all([
      countLowStockByScope(db, "retail"),
      countLowStockByScope(db, "bakery"),
      countNearExpiry(db),
      countExpiryPageAlerts(db),
      countNegativeStockRetail(db),
      countPendingRefunds(db),
      countPendingOnAccountRequests(db),
      countPendingAdvanceRequests(db),
      countPendingShiftCount(db),
    ]);

    const rawByPath = {
      "/expiry": expiryPageAlerts,
      "/bakery-supplies": bakeryLowStock,
      "/inventory": negativeStock,
      "/refund-approvals": pendingRefunds,
      "/on-account-approvals": pendingOnAccount,
      "/advance-approvals": pendingAdvances,
      "/shift-audit": pendingShiftCount,
    };

    const settings = await getAppSettings(db);
    const permissions = settings.accountant_permissions;
    const byPath = filterBadgesForUser(req.user?.role, permissions, rawByPath);
    const total = Object.values(byPath).reduce((sum, n) => sum + n, 0);

    res.json({
      retail_low_stock: retailLowStock,
      bakery_low_stock: bakeryLowStock,
      near_expiry: nearExpiry,
      expiry_page_alerts: expiryPageAlerts,
      negative_stock: negativeStock,
      pending_refunds: pendingRefunds,
      pending_on_account: pendingOnAccount,
      pending_advances: pendingAdvances,
      pending_shift_count: pendingShiftCount,
      by_path: byPath,
      total,
    });
  });

  return router;
}
