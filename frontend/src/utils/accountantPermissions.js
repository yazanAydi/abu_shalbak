/**
 * Mirror of backend/utils/accountantPermissions.js for UI labels and guards.
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

export function allAccountantPermissionKeys() {
  const keys = [];
  for (const topic of ACCOUNTANT_PERMISSION_TOPICS) {
    for (const f of topic.features) {
      keys.push(f.key);
    }
  }
  return keys;
}

export function defaultAccountantPermissions() {
  const out = {};
  for (const key of allAccountantPermissionKeys()) {
    out[key] = true;
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

export function hasAccountantPermission(role, permissions, key) {
  if (role === "admin") return true;
  if (role !== "accountant") return false;
  const normalized = normalizeAccountantPermissions(permissions);
  return normalized[key] === true;
}

export function getEffectivePermissions(role, storedPermissions) {
  if (role === "admin") return defaultAccountantPermissions();
  if (role === "accountant") return normalizeAccountantPermissions(storedPermissions);
  return defaultAccountantPermissions();
}

/** First allowed office path for accountant after login. */
export function homePathForPermissions(role, permissions) {
  if (role === "admin" || role === "accountant") {
    const navOrder = [
      { path: "/reports", key: "dashboard" },
      { path: "/finance", key: "finance" },
      { path: "/expenses", key: "expenses" },
      { path: "/sales-reports", key: "sales_reports" },
      { path: "/shift-audit", key: "shift_audit" },
      { path: "/cashier-payroll", key: "employee_payroll" },
      { path: "/refunds", key: "refunds" },
      { path: "/refund-approvals", key: "refund_approvals" },
      { path: "/on-account-approvals", key: "on_account_approvals" },
      { path: "/advance-approvals", key: "advance_approvals" },
      { path: "/expiry", key: "expiry" },
      { path: "/sales-by-price", key: "sales_by_price" },
      { path: "/banks", key: "banks" },
      { path: "/account-statement", key: "account_statement" },
      { path: "/vouchers/receipt", key: "vouchers" },
      { path: "/deliveries", key: "deliveries" },
    ];
    for (const item of navOrder) {
      if (hasAccountantPermission(role, permissions, item.key)) {
        return item.path;
      }
    }
  }
  return "/reports";
}
