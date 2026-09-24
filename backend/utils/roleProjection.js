import { resolveUserPermissions } from "./accountantPermissions.js";
import { canViewReports } from "./roles.js";

export const PRODUCT_COST_PERMISSIONS = ["products", "purchases", "bakery_supplies"];
export const PRODUCT_LOOKUP_PERMISSIONS = [
  "products",
  "product_organization",
  "bakery",
  "bakery_supplies",
  "purchases",
  "inventory_receipts",
  "inventory_issues",
  "sales_invoices",
  "marketing",
  "expiry",
  "stock_count",
  "store_settings",
];

export const CUSTOMER_LOOKUP_PERMISSIONS = [
  "customers",
  "sales_invoices",
  "deliveries",
  "vouchers",
  "account_statement",
  "on_account_approvals",
  "finance",
];

const CUSTOMER_LOOKUP_KEYS = [
  "id",
  "name",
  "phone",
  "balance",
  "credit_limit",
  "price_category",
  "no_credit",
  "customer_code",
  "balance_group_label",
  "balance_group_slug",
];

const PRODUCT_COST_KEYS = new Set([
  "cost",
  "unit_cost",
  "unit_cost_at_sale",
  "gross_profit",
  "margin",
  "avg_cost",
  "last_cost",
]);

export function isOfficeRole(role) {
  return canViewReports(role);
}

export function projectProductForRole(row, role) {
  if (!row || typeof row !== "object" || isOfficeRole(role)) return row;
  if (Array.isArray(row)) return row.map((item) => projectProductForRole(item, role));
  const out = { ...row };
  for (const key of PRODUCT_COST_KEYS) delete out[key];
  if (out.product && typeof out.product === "object") {
    out.product = projectProductForRole(out.product, role);
  }
  if (Array.isArray(out.availableUnits)) {
    out.availableUnits = out.availableUnits.map((u) => projectProductForRole(u, role));
  }
  if (Array.isArray(out.units)) {
    out.units = out.units.map((u) => projectProductForRole(u, role));
  }
  if (Array.isArray(out.items)) {
    out.items = out.items.map((u) => projectProductForRole(u, role));
  }
  return out;
}

const CUSTOMER_POS_KEYS = [
  "id",
  "name",
  "phone",
  "balance",
  "credit_limit",
  "price_category",
  "no_credit",
];

export function projectCustomerForRole(row, role) {
  if (!row || typeof row !== "object" || isOfficeRole(role)) return row;
  if (Array.isArray(row)) return row.map((item) => projectCustomerForRole(item, role));
  const out = {};
  for (const key of CUSTOMER_POS_KEYS) {
    if (key in row) out[key] = row[key];
  }
  return out;
}

function projectLookupCustomer(row) {
  if (Array.isArray(row)) return row.map((item) => projectLookupCustomer(item));
  if (!row || typeof row !== "object") return row;
  const out = {};
  for (const key of CUSTOMER_LOOKUP_KEYS) {
    if (key in row) out[key] = row[key];
  }
  return out;
}

async function officePermissionMap(db, user) {
  if (!isOfficeRole(user?.role)) return null;
  return resolveUserPermissions(db, user);
}

function mapAllows(map, keys) {
  return keys.some((key) => map?.[key] === true);
}

/**
 * Cashiers keep the selling projection (no purchase cost).
 * Office callers need a catalog/workflow key; cost stays on purchasing and product maintenance.
 */
export async function productReadScope(db, user) {
  if (user?.role === "cashier") return { allow: true, includeCost: false };
  const map = await officePermissionMap(db, user);
  if (!map) return { allow: false, includeCost: false };
  const includeCost = mapAllows(map, PRODUCT_COST_PERMISSIONS);
  return { allow: includeCost || mapAllows(map, PRODUCT_LOOKUP_PERMISSIONS), includeCost };
}

export function projectProductRead(row, scope) {
  if (scope?.includeCost) return row;
  return projectProductForRole(row, "cashier");
}

/**
 * Full customer rows require the customers key.
 * Invoice, voucher, delivery, and finance workflows get a lookup without notes or address.
 * Cashiers keep the ذمة selling projection.
 */
export async function customerReadScope(db, user) {
  if (user?.role === "cashier") return { allow: true, mode: "pos" };
  const map = await officePermissionMap(db, user);
  if (!map) return { allow: false, mode: "deny" };
  if (map.customers === true) return { allow: true, mode: "full" };
  if (mapAllows(map, CUSTOMER_LOOKUP_PERMISSIONS)) return { allow: true, mode: "lookup" };
  return { allow: false, mode: "deny" };
}

export function projectCustomerRead(row, scope) {
  if (!scope?.allow) return row;
  if (scope.mode === "full") return row;
  if (scope.mode === "pos") return projectCustomerForRole(row, "cashier");
  return projectLookupCustomer(row);
}
