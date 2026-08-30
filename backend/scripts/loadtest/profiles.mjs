export const THINK_TIME = {
  pos: [800, 2500],
  office: [2000, 6000],
  admin: [5000, 15000],
};

export const POS_OPS = [
  { op: "pos_search", weight: 25 },
  { op: "pos_barcode", weight: 30 },
  { op: "checkout_cash", weight: 20 },
  { op: "checkout_split", weight: 8 },
  { op: "checkout_credit", weight: 5 },
  { op: "suspend", weight: 4 },
  { op: "refund_request", weight: 3 },
  { op: "shift_current", weight: 5 },
];

export const OFFICE_OPS = [
  { op: "product_search", weight: 25 },
  { op: "product_list", weight: 15 },
  { op: "product_put", weight: 15 },
  { op: "change_price", weight: 5 },
  { op: "inventory_adjust", weight: 10 },
  { op: "customer_op", weight: 10 },
  { op: "supplier_op", weight: 5 },
  { op: "report_daily", weight: 10 },
  { op: "report_stock", weight: 5 },
];

export const ADMIN_OPS = [
  { op: "report_range", weight: 40 },
  { op: "settings", weight: 20 },
  { op: "admin_users", weight: 20 },
  { op: "account_statement", weight: 20 },
];

/**
 * What a named profile is supposed to do. Used for fail-closed gates so we
 * do not require checkouts/receipts on office-only or admin-only workloads.
 */
export function profileExpectations(profile) {
  const name = String(profile || "mixed").toLowerCase();
  if (name === "office") {
    return { expectCheckouts: false, expectReceipts: false, hasPos: false };
  }
  if (name === "admin") {
    return { expectCheckouts: false, expectReceipts: false, hasPos: false };
  }
  if (name === "pos") {
    return { expectCheckouts: true, expectReceipts: true, hasPos: true };
  }
  // mixed (default) and any unknown POS-inclusive profile
  return { expectCheckouts: true, expectReceipts: true, hasPos: true };
}

export function allocateRoles(vus, profile = "mixed") {
  const name = String(profile || "mixed").toLowerCase();
  const expect = profileExpectations(name);
  if (!expect.hasPos && name === "office") {
    return { pos: 0, office: Math.max(1, vus), admin: 0 };
  }
  if (!expect.hasPos && name === "admin") {
    return { pos: 0, office: 0, admin: Math.max(1, vus) };
  }
  if (name === "pos") {
    return { pos: Math.max(1, vus), office: 0, admin: 0 };
  }
  const pos = Math.max(1, Math.round(vus * 0.6));
  const office = Math.max(1, Math.round(vus * 0.3));
  let admin = vus - pos - office;
  if (admin < 1) {
    admin = 1;
  }
  while (pos + office + admin > vus) {
    if (pos > 1) return { pos: pos - 1, office, admin };
    if (office > 1) return { pos, office: office - 1, admin };
    break;
  }
  while (pos + office + admin < vus) {
    return { pos: pos + (vus - pos - office - admin), office, admin };
  }
  return { pos, office, admin };
}

export function pickWeighted(rng, items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rng() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item.op;
  }
  return items[items.length - 1].op;
}

export function thinkMs(rng, role, multiplier = 1) {
  const [lo, hi] = THINK_TIME[role] || THINK_TIME.pos;
  return Math.round((lo + rng() * (hi - lo)) * multiplier);
}
