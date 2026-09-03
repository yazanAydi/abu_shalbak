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
  if (role === "admin") return true;
  if (role !== "accountant") return false;
  const normalized = normalizeAccountantPermissions(permissions);
  return normalized[key] === true;
}

/**
 * @param {string} role
 * @param {Record<string, boolean>|undefined|null} storedPermissions
 * @returns {Record<string, boolean>}
 */
export function getEffectivePermissions(role, storedPermissions) {
  if (role === "admin") return allAccountantPermissionsEnabled();
  if (role === "accountant") return normalizeAccountantPermissions(storedPermissions);
  return defaultAccountantPermissions();
}

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
  "/cashier-payroll": "employee_payroll",
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
        "bakery_supplies",
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
      ["user_accounts", "employee_payroll", "store_settings", "currencies", "permissions"].includes(d.key)
    ),
  },
];
