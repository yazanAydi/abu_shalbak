import { canViewReports, isAdminRole } from "../../utils/roles";
import { ACCOUNTANT_PERMISSION_DEFS, hasAccountantPermission } from "../../utils/accountantPermissions";

const PERMISSION_LABEL_AR = Object.fromEntries(
  ACCOUNTANT_PERMISSION_DEFS.map((def) => [def.key, def.labelAr])
);

/** @typedef {{ path: string, label: string, icon: string, section?: string, badgePath?: string, permissionKey?: string, visible: (role: string, permissions?: Record<string, boolean>|null) => boolean }} NavItem */

function canSeeNavItem(role, permissions, permissionKey) {
  if (!canViewReports(role)) return false;
  if (isAdminRole(role) && !permissionKey) return true;
  if (!permissionKey) return false;
  return hasAccountantPermission(role, permissions, permissionKey);
}

function navVisible(permissionKey) {
  return (role, permissions) => canSeeNavItem(role, permissions, permissionKey);
}

function canSeeBakeryWorkspace(role, permissions) {
  return canSeeNavItem(role, permissions, "bakery") || canSeeNavItem(role, permissions, "bakery_supplies");
}

function bakeryChildVisible(...keys) {
  return (role, permissions) =>
    canSeeBakeryWorkspace(role, permissions) && keys.some((key) => canSeeNavItem(role, permissions, key));
}

/** @type {NavItem[]} */
export const OFFICE_NAV = [
  {
    path: "/reports",
    label: "لوحة التحكم",
    icon: "dashboard",
    section: "overview",
    permissionKey: "dashboard",
    visible: navVisible("dashboard"),
  },
  {
    path: "/bakery",
    label: "نظرة عامة",
    icon: "inventory",
    section: "bakery",
    permissionKey: "bakery",
    visible: navVisible("bakery"),
  },
  {
    path: "/bakery/products",
    label: "الأصناف والمخزون",
    icon: "products",
    section: "bakery",
    badgePath: "/bakery/products",
    permissionKey: "bakery_supplies",
    visible: bakeryChildVisible("bakery", "bakery_supplies"),
  },
  {
    path: "/bakery/purchases",
    label: "المشتريات",
    icon: "purchases",
    section: "bakery",
    permissionKey: "purchases",
    omitFromPermissionTopics: true,
    visible: bakeryChildVisible("purchases", "bakery_supplies"),
  },
  {
    path: "/bakery/returns",
    label: "مرتجعات الموردين",
    icon: "refunds",
    section: "bakery",
    permissionKey: "purchases",
    omitFromPermissionTopics: true,
    visible: bakeryChildVisible("purchases"),
  },
  {
    path: "/bakery/warehouses",
    label: "المستودعات",
    icon: "warehouses",
    section: "bakery",
    permissionKey: "warehouses",
    omitFromPermissionTopics: true,
    visible: bakeryChildVisible("warehouses", "bakery_supplies"),
  },
  {
    path: "/bakery/expiry",
    label: "الصلاحيات والتشغيلات",
    icon: "expiry",
    section: "bakery",
    permissionKey: "expiry",
    omitFromPermissionTopics: true,
    visible: bakeryChildVisible("expiry"),
  },
  {
    path: "/bakery/sales",
    label: "المبيعات",
    icon: "finance",
    section: "bakery",
    permissionKey: "bakery",
    omitFromPermissionTopics: true,
    visible: navVisible("bakery"),
  },
  {
    path: "/bakery/movements",
    label: "حركة المخزون",
    icon: "inventory",
    section: "bakery",
    permissionKey: "stock_count",
    omitFromPermissionTopics: true,
    visible: bakeryChildVisible("stock_count", "bakery_supplies"),
  },
  {
    path: "/manage-products",
    label: "المنتجات",
    icon: "products",
    section: "catalog",
    permissionKey: "products",
    visible: navVisible("products"),
  },
  {
    path: "/product-organization",
    label: "تنظيم المنتجات",
    icon: "products",
    section: "catalog",
    permissionKey: "product_organization",
    visible: navVisible("product_organization"),
  },
  {
    path: "/customers",
    label: "العملاء",
    icon: "customers",
    section: "catalog",
    permissionKey: "customers",
    visible: navVisible("customers"),
  },
  {
    path: "/suppliers",
    label: "الموردون",
    icon: "suppliers",
    section: "catalog",
    permissionKey: "suppliers",
    visible: navVisible("suppliers"),
  },
  {
    path: "/units",
    label: "الوحدات",
    icon: "products",
    section: "catalog",
    permissionKey: "units",
    visible: navVisible("units"),
  },
  {
    path: "/categories",
    label: "التصنيفات",
    icon: "products",
    section: "catalog",
    permissionKey: "categories",
    visible: navVisible("categories"),
  },
  {
    path: "/inventory",
    label: "جرد المخزون",
    icon: "inventory",
    section: "catalog",
    badgePath: "/inventory",
    permissionKey: "stock_count",
    visible: navVisible("stock_count"),
  },
  {
    path: "/warehouses",
    label: "المستودعات",
    icon: "warehouses",
    section: "catalog",
    permissionKey: "warehouses",
    visible: navVisible("warehouses"),
  },
  {
    path: "/expiry",
    label: "الصلاحية",
    icon: "expiry",
    section: "catalog",
    badgePath: "/expiry",
    permissionKey: "expiry",
    visible: navVisible("expiry"),
  },
  {
    path: "/finance",
    label: "المراقبة المالية",
    icon: "finance",
    section: "finance",
    permissionKey: "finance",
    visible: navVisible("finance"),
  },
  {
    path: "/expenses",
    label: "المصروفات",
    icon: "expenses",
    section: "finance",
    permissionKey: "expenses",
    visible: navVisible("expenses"),
  },
  {
    path: "/employee-statements",
    label: "كشف حساب الموظفين",
    icon: "vouchers",
    section: "finance",
    permissionKey: "employee_payroll",
    visible: navVisible("employee_payroll"),
  },
  {
    path: "/employee-salaries",
    label: "رواتب الموظفين",
    icon: "shifts",
    section: "finance",
    permissionKey: "employee_payroll",
    visible: navVisible("employee_payroll"),
  },
  {
    path: "/cashier-payroll",
    label: "أجور الساعة والدوام",
    icon: "shifts",
    section: "finance",
    permissionKey: "employee_payroll",
    omitFromPermissionTopics: true,
    visible: navVisible("employee_payroll"),
  },
  {
    path: "/sales-reports",
    label: "تقارير المبيعات",
    icon: "finance",
    section: "finance",
    permissionKey: "sales_reports",
    visible: navVisible("sales_reports"),
  },
  {
    path: "/shift-audit",
    label: "الورديات",
    icon: "shifts",
    section: "finance",
    badgePath: "/shift-audit",
    permissionKey: "shift_audit",
    visible: navVisible("shift_audit"),
  },
  {
    path: "/sales-by-price",
    label: "المبيعات حسب السعر",
    icon: "finance",
    section: "finance",
    permissionKey: "sales_by_price",
    visible: navVisible("sales_by_price"),
  },
  {
    path: "/banks",
    label: "البنوك والشيكات",
    icon: "banks",
    section: "finance",
    permissionKey: "banks",
    visible: navVisible("banks"),
  },
  {
    path: "/account-statement",
    label: "كشف حساب",
    icon: "vouchers",
    section: "finance",
    permissionKey: "account_statement",
    visible: navVisible("account_statement"),
  },
  {
    path: "/import-supplier-balances",
    label: "استيراد أرصدة الموردين",
    icon: "suppliers",
    section: "finance",
    visible: (role) => isAdminRole(role),
  },
  {
    path: "/vouchers/receipt",
    label: "سند قبض",
    icon: "vouchers",
    section: "invoices",
    permissionKey: "vouchers",
    visible: navVisible("vouchers"),
  },
  {
    path: "/vouchers/payment",
    label: "سند صرف",
    icon: "vouchers",
    section: "invoices",
    permissionKey: "vouchers",
    visible: navVisible("vouchers"),
  },
  {
    path: "/purchases",
    label: "فتورة مشتريات",
    icon: "purchases",
    section: "invoices",
    permissionKey: "purchases",
    visible: navVisible("purchases"),
  },
  {
    path: "/sales-invoices",
    label: "فتورة مبيعات",
    icon: "customers",
    section: "invoices",
    permissionKey: "sales_invoices",
    visible: navVisible("sales_invoices"),
  },
  {
    path: "/inventory-receipts",
    label: "سند إدخال بضاعة",
    icon: "inventory",
    section: "invoices",
    permissionKey: "inventory_receipts",
    visible: navVisible("inventory_receipts"),
  },
  {
    path: "/inventory-issues",
    label: "سند إخراج بضاعة",
    icon: "inventory",
    section: "invoices",
    permissionKey: "inventory_issues",
    visible: navVisible("inventory_issues"),
  },
  {
    path: "/refunds",
    label: "الاسترجاعات",
    icon: "refunds",
    section: "operations",
    permissionKey: "refunds",
    visible: navVisible("refunds"),
  },
  {
    path: "/refund-approvals",
    label: "موافقات الاسترجاع",
    icon: "refunds",
    section: "operations",
    badgePath: "/refund-approvals",
    permissionKey: "refund_approvals",
    visible: navVisible("refund_approvals"),
  },
  {
    path: "/on-account-approvals",
    label: "موافقات الذمة",
    icon: "vouchers",
    section: "operations",
    badgePath: "/on-account-approvals",
    permissionKey: "on_account_approvals",
    visible: navVisible("on_account_approvals"),
  },
  {
    path: "/advance-approvals",
    label: "موافقات السلف",
    icon: "vouchers",
    section: "operations",
    badgePath: "/advance-approvals",
    permissionKey: "advance_approvals",
    visible: navVisible("advance_approvals"),
  },
  {
    path: "/marketing",
    label: "التسويق",
    icon: "marketing",
    section: "operations",
    permissionKey: "marketing",
    visible: navVisible("marketing"),
  },
  {
    path: "/deliveries",
    label: "التوصيل",
    icon: "deliveries",
    section: "operations",
    permissionKey: "deliveries",
    visible: navVisible("deliveries"),
  },
  {
    path: "/manage-users",
    label: "الحسابات",
    icon: "users",
    section: "admin",
    permissionKey: "user_accounts",
    visible: navVisible("user_accounts"),
  },
  {
    path: "/settings",
    label: "الإعدادات",
    icon: "settings",
    section: "admin",
    permissionKey: "store_settings",
    visible: navVisible("store_settings"),
  },
  {
    path: "/settings/currency",
    label: "العملات",
    icon: "settings",
    section: "admin",
    permissionKey: "currencies",
    visible: navVisible("currencies"),
  },
  {
    path: "/permissions",
    label: "الصلاحيات",
    icon: "settings",
    section: "admin",
    permissionKey: "permissions",
    visible: navVisible("permissions"),
  },
];

export const NAV_SECTION_LABELS = {
  overview: "نظرة عامة",
  bakery: "المخبز",
  catalog: "المخزون والمنتجات",
  invoices: "فواتير",
  finance: "المالية والتقارير",
  operations: "العمليات",
  admin: "الإدارة",
};

export const SECTION_ORDER = ["overview", "bakery", "catalog", "invoices", "finance", "operations", "admin"];

export function filterOfficeNav(role, permissions) {
  return OFFICE_NAV.filter((item) => item.visible(role, permissions));
}

export function groupOfficeNav(items) {
  const groups = [];
  let currentSection = null;
  let currentItems = [];

  for (const item of items) {
    const sec = item.section || "other";
    if (sec !== currentSection) {
      if (currentItems.length) {
        groups.push({ section: currentSection, items: currentItems });
      }
      currentSection = sec;
      currentItems = [item];
    } else {
      currentItems.push(item);
    }
  }
  if (currentItems.length) {
    groups.push({ section: currentSection, items: currentItems });
  }

  return groups.sort(
    (a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section)
  );
}

/**
 * Permission settings topics derived from Office nav (one row per unique permissionKey).
 */
export function permissionTopicsFromNav() {
  const seen = new Set();
  /** @type {Record<string, { id: string, labelAr: string, features: { key: string, labelAr: string }[] }>} */
  const bySection = {};

  for (const item of OFFICE_NAV) {
    if (item.omitFromPermissionTopics) continue;
    if (!item.permissionKey || seen.has(item.permissionKey)) continue;
    seen.add(item.permissionKey);
    const section = item.section || "other";
    if (!bySection[section]) {
      bySection[section] = {
        id: section,
        labelAr: NAV_SECTION_LABELS[section] || section,
        features: [],
      };
    }
    bySection[section].features.push({
      key: item.permissionKey,
      labelAr: PERMISSION_LABEL_AR[item.permissionKey] || item.label,
    });
  }

  return SECTION_ORDER.map((id) => bySection[id]).filter(Boolean);
}

export const ROUTE_TITLES = {
  "/reports": "لوحة التحكم",
  "/manage-products": "إدارة المنتجات",
  "/product-organization": "تنظيم المنتجات",
  "/manage-users": "إدارة الحسابات",
  "/finance": "المراقبة المالية",
  "/sales-reports": "تقارير المبيعات",
  "/shift-audit": "تدقيق الورديات",
  "/cashier-payroll": "أجور الساعة والدوام",
  "/employee-statements": "كشف حساب الموظفين",
  "/employee-salaries": "رواتب الموظفين",
  "/refunds": "الاسترجاعات",
  "/refund-approvals": "موافقات الاسترجاع",
  "/on-account-approvals": "موافقات الذمة",
  "/advance-approvals": "موافقات السلف",
  "/settings": "إعدادات المتجر",
  "/settings/currency": "إعدادات العملات",
  "/permissions": "الصلاحيات",
  "/inventory": "جرد المخزون",
  "/bakery-supplies": "مواد المخبز",
  "/bakery": "نظرة عامة — المخبز",
  "/bakery/products": "أصناف المخبز",
  "/bakery/purchases": "مشتريات المخبز",
  "/bakery/returns": "مرتجعات موردين المخبز",
  "/bakery/warehouses": "مستودعات المخبز",
  "/bakery/expiry": "صلاحيات وتشغيلات المخبز",
  "/bakery/sales": "مبيعات المخبز",
  "/bakery/movements": "حركة مخزون المخبز",
  "/expiry": "تقارير الصلاحية",
  "/sales-by-price": "المبيعات حسب سعر البيع",
  "/customers": "إدارة العملاء",
  "/suppliers": "إدارة الموردين",
  "/purchases": "فتورة مشتريات",
  "/sales-invoices": "فتورة مبيعات",
  "/inventory-receipts": "سند إدخال بضاعة",
  "/inventory-receipts/new": "سند إدخال بضاعة",
  "/inventory-issues": "سند إخراج بضاعة",
  "/inventory-issues/new": "سند إخراج بضاعة",
  "/units": "الوحدات",
  "/categories": "التصنيفات",
  "/expenses": "المصروفات",
  "/banks": "البنوك والشيكات",
  "/vouchers/receipt": "سند قبض",
  "/vouchers/payment": "سند صرف",
  "/deliveries": "التوصيل والاستلام",
  "/marketing": "التسويق والعروض",
  "/warehouses": "المستودعات",
  "/account-statement": "كشف حساب",
  "/import-supplier-balances": "استيراد أرصدة الموردين",
};

/** Map route paths to permission keys for route guards. */
export const ROUTE_PERMISSION_KEYS = {
  "/reports": "dashboard",
  "/manage-products": "products",
  "/product-organization": "product_organization",
  "/products/:id": "products",
  "/customers": "customers",
  "/suppliers": "suppliers",
  "/units": "units",
  "/categories": "categories",
  "/inventory": "stock_count",
  "/bakery-supplies": "bakery_supplies",
  "/bakery": "bakery",
  "/bakery/products": "bakery_supplies",
  "/bakery/purchases": "purchases",
  "/bakery/returns": "purchases",
  "/bakery/warehouses": "warehouses",
  "/bakery/expiry": "expiry",
  "/bakery/sales": "bakery",
  "/bakery/movements": "stock_count",
  "/warehouses": "warehouses",
  "/finance": "finance",
  "/sales-reports": "sales_reports",
  "/shift-audit": "shift_audit",
  "/cashier-payroll": "employee_payroll",
  "/employee-statements": "employee_payroll",
  "/employee-salaries": "employee_payroll",
  "/refunds": "refunds",
  "/refund-approvals": "refund_approvals",
  "/on-account-approvals": "on_account_approvals",
  "/advance-approvals": "advance_approvals",
  "/expiry": "expiry",
  "/sales-by-price": "sales_by_price",
  "/expenses": "expenses",
  "/deliveries": "deliveries",
  "/banks": "banks",
  "/account-statement": "account_statement",
  "/vouchers/receipt": "vouchers",
  "/vouchers/payment": "vouchers",
  "/purchases": "purchases",
  "/sales-invoices": "sales_invoices",
  "/inventory-receipts": "inventory_receipts",
  "/inventory-issues": "inventory_issues",
  "/marketing": "marketing",
  "/manage-users": "user_accounts",
  "/settings": "store_settings",
  "/settings/currency": "currencies",
  "/permissions": "permissions",
  "/suppliers/:supplierId/statement": "account_statement",
};
