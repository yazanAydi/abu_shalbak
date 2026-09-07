import { canViewReports } from "./roles.js";

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
