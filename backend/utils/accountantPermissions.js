/**
 * Accountant permission catalog — topics are UI grouping only; leaf keys are enforced.
 */
export const ACCOUNTANT_PERMISSION_TOPICS = [
  {
    id: "overview",
    labelAr: "نظرة عامة",
    features: [{ key: "dashboard", labelAr: "لوحة التحكم" }],
  },
  {
    id: "finance",
    labelAr: "المالية والتقارير",
    features: [
      { key: "finance", labelAr: "المالية" },
      { key: "expenses", labelAr: "المصروفات" },
      { key: "sales_reports", labelAr: "تقارير المبيعات" },
      { key: "shift_audit", labelAr: "الورديات" },
      { key: "employee_payroll", labelAr: "رواتب الكاشير" },
      { key: "refunds", labelAr: "الاسترجاعات" },
      { key: "refund_approvals", labelAr: "موافقات الاسترجاع" },
      { key: "on_account_approvals", labelAr: "موافقات الذمة" },
      { key: "advance_approvals", labelAr: "موافقات السلف" },
      { key: "expiry", labelAr: "الصلاحية" },
      { key: "sales_by_price", labelAr: "المبيعات حسب السعر" },
      { key: "banks", labelAr: "البنوك والشيكات" },
      { key: "account_statement", labelAr: "كشف حساب" },
      { key: "vouchers", labelAr: "السندات" },
    ],
  },
  {
    id: "operations",
    labelAr: "العمليات",
    features: [{ key: "deliveries", labelAr: "التوصيل" }],
  },
];

/** @returns {string[]} */
export function allAccountantPermissionKeys() {
  const keys = [];
  for (const topic of ACCOUNTANT_PERMISSION_TOPICS) {
    for (const f of topic.features) {
      keys.push(f.key);
    }
  }
  return keys;
}

/** @returns {Record<string, boolean>} */
export function defaultAccountantPermissions() {
  /** @type {Record<string, boolean>} */
  const out = {};
  for (const key of allAccountantPermissionKeys()) {
    out[key] = true;
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
  if (role === "admin") return defaultAccountantPermissions();
  if (role === "accountant") return normalizeAccountantPermissions(storedPermissions);
  return defaultAccountantPermissions();
}

/** Map nav paths to permission keys for badge filtering. */
export const NAV_PATH_PERMISSION_KEYS = {
  "/reports": "dashboard",
  "/finance": "finance",
  "/expenses": "expenses",
  "/sales-reports": "sales_reports",
  "/shift-audit": "shift_audit",
  "/cashier-payroll": "employee_payroll",
  "/refunds": "refunds",
  "/refund-approvals": "refund_approvals",
  "/on-account-approvals": "on_account_approvals",
  "/advance-approvals": "advance_approvals",
  "/expiry": "expiry",
  "/sales-by-price": "sales_by_price",
  "/banks": "banks",
  "/account-statement": "account_statement",
  "/vouchers": "vouchers",
  "/deliveries": "deliveries",
  "/suppliers/:supplierId/statement": "account_statement",
};
