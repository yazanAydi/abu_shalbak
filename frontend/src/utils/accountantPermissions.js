/**
 * Mirror of backend/utils/accountantPermissions.js for UI labels and guards.
 * Existing keys default to enabled when missing (backward compatible).
 * Newly introduced keys default to disabled so accountants are not granted new pages.
 */

/** @typedef {{ key: string, labelAr: string, defaultEnabled: boolean }} PermissionDef */

/** @type {PermissionDef[]} */
export const ACCOUNTANT_PERMISSION_DEFS = [
  { key: "dashboard", labelAr: "لوحة التحكم", defaultEnabled: true },
  { key: "products", labelAr: "المنتجات", defaultEnabled: false },
  { key: "product_organization", labelAr: "تنظيم المنتجات", defaultEnabled: false },
  { key: "customers", labelAr: "العملاء", defaultEnabled: false },
  { key: "suppliers", labelAr: "الموردون", defaultEnabled: false },
  { key: "units", labelAr: "الوحدات", defaultEnabled: false },
  { key: "categories", labelAr: "التصنيفات", defaultEnabled: false },
  { key: "stock_count", labelAr: "جرد المخزون", defaultEnabled: false },
  { key: "bakery_supplies", labelAr: "مواد المخبز", defaultEnabled: false },
  { key: "warehouses", labelAr: "المستودعات", defaultEnabled: false },
  { key: "expiry", labelAr: "الصلاحية", defaultEnabled: true },
  { key: "finance", labelAr: "المالية", defaultEnabled: true },
  { key: "expenses", labelAr: "المصروفات", defaultEnabled: true },
  { key: "sales_reports", labelAr: "تقارير المبيعات", defaultEnabled: true },
  { key: "shift_audit", labelAr: "الورديات", defaultEnabled: true },
  { key: "sales_by_price", labelAr: "المبيعات حسب السعر", defaultEnabled: true },
  { key: "banks", labelAr: "البنوك والشيكات", defaultEnabled: true },
  { key: "account_statement", labelAr: "كشف حساب", defaultEnabled: true },
  { key: "vouchers", labelAr: "السندات", defaultEnabled: true },
  { key: "purchases", labelAr: "فاتورة مشتريات", defaultEnabled: false },
  { key: "sales_invoices", labelAr: "فاتورة مبيعات", defaultEnabled: false },
  { key: "inventory_receipts", labelAr: "سند إدخال بضاعة", defaultEnabled: false },
  { key: "inventory_issues", labelAr: "سند إخراج بضاعة", defaultEnabled: false },
  { key: "refunds", labelAr: "الاسترجاعات", defaultEnabled: true },
  { key: "refund_approvals", labelAr: "موافقات الاسترجاع", defaultEnabled: true },
  { key: "on_account_approvals", labelAr: "موافقات الذمة", defaultEnabled: true },
  { key: "advance_approvals", labelAr: "موافقات السلف", defaultEnabled: true },
  { key: "marketing", labelAr: "التسويق", defaultEnabled: false },
  { key: "deliveries", labelAr: "التوصيل", defaultEnabled: true },
  { key: "user_accounts", labelAr: "الحسابات", defaultEnabled: false },
  { key: "employee_payroll", labelAr: "الموظفون", defaultEnabled: true },
  { key: "store_settings", labelAr: "الإعدادات", defaultEnabled: false },
  { key: "currencies", labelAr: "العملات", defaultEnabled: false },
  { key: "permissions", labelAr: "الصلاحيات", defaultEnabled: false },
];

export function allAccountantPermissionKeys() {
  return ACCOUNTANT_PERMISSION_DEFS.map((d) => d.key);
}

export function defaultAccountantPermissions() {
  const out = {};
  for (const def of ACCOUNTANT_PERMISSION_DEFS) {
    out[def.key] = def.defaultEnabled;
  }
  return out;
}

export function allAccountantPermissionsEnabled() {
  const out = {};
  for (const key of allAccountantPermissionKeys()) {
    out[key] = true;
  }
  return out;
}

export function allAccountantPermissionsDisabled() {
  const out = {};
  for (const key of allAccountantPermissionKeys()) {
    out[key] = false;
  }
  return out;
}

export function normalizeAccountantPermissions(raw) {
  const defaults = defaultAccountantPermissions();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaults;
  }
  const out = { ...defaults };
  for (const key of allAccountantPermissionKeys()) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      out[key] = raw[key] === true || raw[key] === "true" || raw[key] === 1 || raw[key] === "1";
    }
  }
  return out;
}

function permissionFlag(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

export function isOfficePermissionRole(role) {
  return role === "admin" || role === "accountant";
}

/** Parse a stored permissions object. Returns a plain object or null (use defaults). */
export function parseUserPermissionsJson(raw) {
  if (raw == null) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  const text = String(raw).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function hasAccountantPermission(role, permissions, key) {
  if (role === "admin") {
    if (
      permissions &&
      typeof permissions === "object" &&
      !Array.isArray(permissions) &&
      Object.prototype.hasOwnProperty.call(permissions, key)
    ) {
      return permissionFlag(permissions[key]);
    }
    return true;
  }
  if (role !== "accountant") return false;
  const normalized = normalizeAccountantPermissions(permissions);
  return normalized[key] === true;
}

/**
 * Sync counterpart of backend resolveUserPermissions (without reading settings).
 * Custom stored map wins for admin and accountant; otherwise admin is all-on.
 */
export function getEffectivePermissions(role, storedPermissions) {
  if (!isOfficePermissionRole(role)) return defaultAccountantPermissions();
  const parsed = parseUserPermissionsJson(storedPermissions);
  if (parsed) return normalizeAccountantPermissions(parsed);
  if (role === "admin") return allAccountantPermissionsEnabled();
  return normalizeAccountantPermissions(storedPermissions);
}

/** Same check as hasAccountantPermission for a signed-in Office user object. */
export function userHasOfficePermission(user, key) {
  return hasAccountantPermission(user?.role, user?.permissions, key);
}

/** First allowed office path after login / denied-route redirect. */
export const HOME_PATH_NAV_ORDER = [
  { path: "/reports", key: "dashboard" },
  { path: "/manage-products", key: "products" },
  { path: "/product-organization", key: "product_organization" },
  { path: "/customers", key: "customers" },
  { path: "/suppliers", key: "suppliers" },
  { path: "/units", key: "units" },
  { path: "/categories", key: "categories" },
  { path: "/inventory", key: "stock_count" },
  { path: "/bakery-supplies", key: "bakery_supplies" },
  { path: "/warehouses", key: "warehouses" },
  { path: "/expiry", key: "expiry" },
  { path: "/finance", key: "finance" },
  { path: "/expenses", key: "expenses" },
  { path: "/sales-reports", key: "sales_reports" },
  { path: "/shift-audit", key: "shift_audit" },
  { path: "/sales-by-price", key: "sales_by_price" },
  { path: "/banks", key: "banks" },
  { path: "/account-statement", key: "account_statement" },
  { path: "/vouchers/receipt", key: "vouchers" },
  { path: "/purchases", key: "purchases" },
  { path: "/sales-invoices", key: "sales_invoices" },
  { path: "/inventory-receipts", key: "inventory_receipts" },
  { path: "/inventory-issues", key: "inventory_issues" },
  { path: "/refunds", key: "refunds" },
  { path: "/refund-approvals", key: "refund_approvals" },
  { path: "/on-account-approvals", key: "on_account_approvals" },
  { path: "/advance-approvals", key: "advance_approvals" },
  { path: "/marketing", key: "marketing" },
  { path: "/deliveries", key: "deliveries" },
  { path: "/manage-users", key: "user_accounts" },
  { path: "/cashier-payroll", key: "employee_payroll" },
  { path: "/settings", key: "store_settings" },
  { path: "/settings/currency", key: "currencies" },
  { path: "/permissions", key: "permissions" },
];

export function homePathForPermissions(role, permissions) {
  if (role === "admin" || role === "accountant") {
    for (const item of HOME_PATH_NAV_ORDER) {
      if (hasAccountantPermission(role, permissions, item.key)) {
        return item.path;
      }
    }
  }
  return "/reports";
}

export function permissionKeyForPath(pathname) {
  if (!pathname) return null;
  const exact = HOME_PATH_NAV_ORDER.find((item) => item.path === pathname);
  if (exact) return exact.key;
  if (pathname.startsWith("/products/")) return "products";
  if (pathname.startsWith("/suppliers/") && pathname.endsWith("/statement")) return "account_statement";
  if (pathname.startsWith("/vouchers/")) return "vouchers";
  if (pathname.startsWith("/inventory-receipts")) return "inventory_receipts";
  if (pathname.startsWith("/inventory-issues")) return "inventory_issues";
  return null;
}

export function canAccessOfficePath(role, permissions, pathname) {
  const key = permissionKeyForPath(pathname);
  if (!key) return role === "admin";
  return hasAccountantPermission(role, permissions, key);
}
