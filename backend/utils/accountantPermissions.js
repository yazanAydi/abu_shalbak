import { CACHE_KEYS, cacheGet, cacheSet } from "./cache.js";
import { HttpError } from "./httpError.js";

export const PERMISSIONS_CORRUPT_MESSAGE =
  "صلاحيات هذا الحساب تالفة ولا يمكن الاعتماد عليها. صحّح خريطة الصلاحيات من حساب مدير.";

const CORRUPT_PERMISSIONS = Symbol("corrupt-permissions");

export function isCorruptPermissions(value) {
  return value === CORRUPT_PERMISSIONS;
}

export function permissionsCorruptError() {
  return new HttpError(403, PERMISSIONS_CORRUPT_MESSAGE, "PERMISSIONS_CORRUPT");
}

/**
 * Accountant permission catalog — topics are UI grouping only; leaf keys are enforced.
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
  { key: "bakery", labelAr: "المخبز", defaultEnabled: false },
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
  { key: "employee_payroll", labelAr: "كشف حساب ورواتب الموظفين", defaultEnabled: true },
  { key: "store_settings", labelAr: "الإعدادات", defaultEnabled: false },
  { key: "currencies", labelAr: "العملات", defaultEnabled: false },
  { key: "permissions", labelAr: "الصلاحيات", defaultEnabled: false },
];

/** @returns {string[]} */
export function allAccountantPermissionKeys() {
  return ACCOUNTANT_PERMISSION_DEFS.map((d) => d.key);
}

/** Defaults used when a key is missing from stored settings. */
export function defaultAccountantPermissions() {
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const def of ACCOUNTANT_PERMISSION_DEFS) {
    out[def.key] = def.defaultEnabled;
  }
  return out;
}

/** All known keys enabled — used for admin effective permissions and تحديد الكل. */
export function allAccountantPermissionsEnabled() {
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const key of allAccountantPermissionKeys()) {
    out[key] = true;
  }
  return out;
}

/** All known keys disabled — used for إلغاء الكل. */
export function allAccountantPermissionsDisabled() {
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const key of allAccountantPermissionKeys()) {
    out[key] = false;
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, boolean>}
 */
export function normalizeAccountantPermissions(raw) {
  const defaults = defaultAccountantPermissions();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaults;
  }
  /** @type {Record<string, boolean>} */
  const out = { ...defaults };
  for (const key of allAccountantPermissionKeys()) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      out[key] = raw[key] === true || raw[key] === "true" || raw[key] === 1 || raw[key] === "1";
    }
  }
  return out;
}

/**
 * @param {string} role
 * @param {Record<string, boolean>|undefined|null} permissions
 * @param {string} key
 */
export function hasAccountantPermission(role, permissions, key) {
  if (!isOfficePermissionRole(role)) return false;
  if (permissions == null) return role === "admin";
  try {
    return explicitPermissionMap(permissions)[key] === true;
  } catch {
    return false;
  }
}

/**
 * Sync counterpart of resolveUserPermissions (without reading settings).
 * Custom stored map wins for admin and accountant; otherwise admin is all-on
 * and accountant uses catalog defaults (caller should pass the global template).
 * @param {string} role
 * @param {Record<string, boolean>|undefined|null} storedPermissions
 * @returns {Record<string, boolean>}
 */
export function getEffectivePermissions(role, storedPermissions) {
  if (!isOfficePermissionRole(role)) return defaultAccountantPermissions();
  const parsed = parseUserPermissionsJson(storedPermissions);
  if (isCorruptPermissions(parsed)) throw permissionsCorruptError();
  if (parsed) return explicitPermissionMap(parsed);
  if (role === "admin") return allAccountantPermissionsEnabled();
  return defaultAccountantPermissions();
}

/**
 * A stored custom map: omitted known keys are off. Unknown keys are ignored.
 * A non-boolean known value is corrupt and must not grant access.
 * @param {unknown} raw
 * @returns {Record<string, boolean>}
 */
export function explicitPermissionMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw permissionsCorruptError();
  const known = new Set(allAccountantPermissionKeys());
  const out = allAccountantPermissionsDisabled();
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) continue;
    if (typeof value !== "boolean") throw permissionsCorruptError();
    out[key] = value;
  }
  return out;
}

/**
 * Full replacement body. Rejects unknown keys and non-booleans without writing.
 * Omitted known keys are off.
 * @param {unknown} raw
 */
export function assertPermissionReplacement(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "خريطة الصلاحيات غير صالحة", "INVALID_PERMISSIONS");
  }
  const known = new Set(allAccountantPermissionKeys());
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) {
      throw new HttpError(400, "تحتوي الصلاحيات على مفتاح غير معروف", "INVALID_PERMISSIONS");
    }
    if (typeof value !== "boolean") {
      throw new HttpError(400, "قيم الصلاحيات يجب أن تكون true أو false", "INVALID_PERMISSIONS");
    }
  }
  return explicitPermissionMap(raw);
}

/** True when every granted target key is also granted to the actor. */
export function permissionMapCovers(actorMap, targetMap) {
  for (const key of allAccountantPermissionKeys()) {
    if (targetMap?.[key] === true && actorMap?.[key] !== true) return false;
  }
  return true;
}

/**
 * Parse users.permissions_json.
 * null means no custom map. A plain object is a custom map.
 * Invalid JSON is corrupt and must not fall back to a broader template.
 * @param {unknown} raw
 * @returns {Record<string, unknown>|null|typeof CORRUPT_PERMISSIONS}
 */
export function parseUserPermissionsJson(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") {
    if (Array.isArray(raw)) return CORRUPT_PERMISSIONS;
    return raw;
  }
  const text = String(raw).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed == null) return null;
    if (typeof parsed !== "object" || Array.isArray(parsed)) return CORRUPT_PERMISSIONS;
    return parsed;
  } catch {
    return CORRUPT_PERMISSIONS;
  }
}

const USER_PERMISSION_ROW_SQL =
  "SELECT id, username, role, must_change_password, permissions_json, COALESCE(session_version, 0) AS session_version FROM users WHERE id = ?";

/**
 * Shared per-user row used by password-change checks and permission resolution.
 * @param {object} db
 * @param {number|string} userId
 */
export async function getCachedUserRow(db, userId) {
  const cacheKey = CACHE_KEYS.user(userId);
  let row = cacheGet(cacheKey);
  if (!row) {
    row = await db.get(USER_PERMISSION_ROW_SQL, [userId]);
    if (row) cacheSet(cacheKey, row, 60_000);
  }
  return row;
}

export function isOfficePermissionRole(role) {
  return role === "admin" || role === "accountant";
}

/**
 * Effective permission map for a signed-in user.
 * Admin without a custom set: all enabled. Accountant without a custom set: global settings.
 * Either role with users.permissions_json: that custom set.
 * @param {object} db
 * @param {{ id?: number, role?: string, permissions_json?: unknown }|null|undefined} user
 */
export async function resolveUserPermissions(db, user) {
  const role = user?.role;
  if (!isOfficePermissionRole(role)) return defaultAccountantPermissions();

  let stored = user?.permissions_json;
  if (stored === undefined && user?.id != null) {
    const row = await getCachedUserRow(db, user.id);
    stored = row?.permissions_json;
  }
  const parsed = parseUserPermissionsJson(stored);
  if (isCorruptPermissions(parsed)) throw permissionsCorruptError();
  if (parsed) return explicitPermissionMap(parsed);
  if (role === "admin") return allAccountantPermissionsEnabled();
  const { getAppSettings } = await import("./settings.js");
  const settings = await getAppSettings(db);
  return normalizeAccountantPermissions(settings.accountant_permissions);
}

/**
 * @param {object} db
 * @param {{ id?: number, role?: string, permissions_json?: unknown }|null|undefined} user
 * @param {string} key
 */
export async function userHasAccountantPermission(db, user, key) {
  if (!isOfficePermissionRole(user?.role)) return false;
  const permissions = await resolveUserPermissions(db, user);
  return permissions[key] === true;
}

/** Alias used by Office feature routes. Same live DB resolution as userHasAccountantPermission. */
export const userHasOfficePermission = userHasAccountantPermission;

/** Map nav paths to permission keys for badge filtering. */
export const NAV_PATH_PERMISSION_KEYS = {
  "/reports": "dashboard",
  "/manage-products": "products",
  "/product-organization": "product_organization",
  "/customers": "customers",
  "/suppliers": "suppliers",
  "/units": "units",
  "/categories": "categories",
  "/inventory": "stock_count",
  "/bakery-supplies": "bakery_supplies",
  "/bakery": "bakery",
  "/bakery/products": "bakery_supplies",
  "/bakery/sales": "bakery",
  "/bakery/purchases": "purchases",
  "/bakery/returns": "purchases",
  "/bakery/expiry": "expiry",
  "/bakery/movements": "stock_count",
  "/warehouses": "warehouses",
  "/expiry": "expiry",
  "/finance": "finance",
  "/expenses": "expenses",
  "/sales-reports": "sales_reports",
  "/shift-audit": "shift_audit",
  "/sales-by-price": "sales_by_price",
  "/banks": "banks",
  "/account-statement": "account_statement",
  "/vouchers": "vouchers",
  "/vouchers/receipt": "vouchers",
  "/vouchers/payment": "vouchers",
  "/purchases": "purchases",
  "/sales-invoices": "sales_invoices",
  "/inventory-receipts": "inventory_receipts",
  "/inventory-issues": "inventory_issues",
  "/refunds": "refunds",
  "/refund-approvals": "refund_approvals",
  "/on-account-approvals": "on_account_approvals",
  "/advance-approvals": "advance_approvals",
  "/marketing": "marketing",
  "/deliveries": "deliveries",
  "/manage-users": "user_accounts",
  "/employee-statements": "employee_payroll",
  "/employee-salaries": "employee_payroll",
  "/cashier-payroll": "employee_payroll",
  "/employee-attendance": "employee_payroll",
  "/settings": "store_settings",
  "/settings/currency": "currencies",
  "/permissions": "permissions",
  "/suppliers/:supplierId/statement": "account_statement",
};

/** @deprecated Topics are derived from Office nav on the frontend. Kept for tests/docs. */
export const ACCOUNTANT_PERMISSION_TOPICS = [
  {
    id: "overview",
    labelAr: "نظرة عامة",
    features: ACCOUNTANT_PERMISSION_DEFS.filter((d) => d.key === "dashboard"),
  },
  {
    id: "bakery",
    labelAr: "المخبز",
    features: ACCOUNTANT_PERMISSION_DEFS.filter((d) =>
      ["bakery", "bakery_supplies"].includes(d.key)
    ),
  },
  {
    id: "catalog",
    labelAr: "المخزون والمنتجات",
    features: ACCOUNTANT_PERMISSION_DEFS.filter((d) =>
      [
        "products",
        "product_organization",
        "customers",
        "suppliers",
        "units",
        "categories",
        "stock_count",
        "warehouses",
        "expiry",
      ].includes(d.key)
    ),
  },
  {
    id: "invoices",
    labelAr: "فواتير",
    features: ACCOUNTANT_PERMISSION_DEFS.filter((d) =>
      ["vouchers", "purchases", "sales_invoices", "inventory_receipts", "inventory_issues"].includes(d.key)
    ),
  },
  {
    id: "finance",
    labelAr: "المالية والتقارير",
    features: ACCOUNTANT_PERMISSION_DEFS.filter((d) =>
      [
        "finance",
        "expenses",
        "employee_payroll",
        "sales_reports",
        "shift_audit",
        "sales_by_price",
        "banks",
        "account_statement",
      ].includes(d.key)
    ),
  },
  {
    id: "operations",
    labelAr: "العمليات",
    features: ACCOUNTANT_PERMISSION_DEFS.filter((d) =>
      ["refunds", "refund_approvals", "on_account_approvals", "advance_approvals", "marketing", "deliveries"].includes(
        d.key
      )
    ),
  },
  {
    id: "admin",
    labelAr: "الإدارة",
    features: ACCOUNTANT_PERMISSION_DEFS.filter((d) =>
      ["user_accounts", "store_settings", "currencies", "permissions"].includes(d.key)
    ),
  },
];
