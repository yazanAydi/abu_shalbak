export const DOC_TYPE = {
  receipt: "receipt",
  issue: "issue",
};

export const RECEIPT_REASONS = [
  { code: "opening", labelAr: "إدخال مخزون" },
  { code: "correction", labelAr: "تصحيح مخزون" },
  { code: "free", labelAr: "بضاعة مجانية" },
  { code: "branch_return", labelAr: "مرتجع من فرع" },
  { code: "other", labelAr: "أخرى" },
];

export const ISSUE_REASONS = [
  { code: "damaged", labelAr: "تالف" },
  { code: "internal", labelAr: "استهلاك داخلي" },
  { code: "samples", labelAr: "عينات" },
  { code: "giveaway", labelAr: "هدايا" },
  { code: "transfer", labelAr: "تحويل" },
  { code: "correction", labelAr: "تصحيح مخزون" },
  { code: "other", labelAr: "أخرى" },
];

export function docConfig(docType) {
  const isIssue = docType === DOC_TYPE.issue;
  return {
    type: isIssue ? DOC_TYPE.issue : DOC_TYPE.receipt,
    title: isIssue ? "سند إخراج بضاعة" : "سند إدخال بضاعة",
    listTitle: isIssue ? "سندات إخراج البضاعة" : "سندات إدخال البضاعة",
    apiBase: isIssue ? "/api/inventory-issues" : "/api/inventory-receipts",
    pathBase: isIssue ? "/inventory-issues" : "/inventory-receipts",
    reasons: isIssue ? ISSUE_REASONS : RECEIPT_REASONS,
    defaultReason: isIssue ? "damaged" : "opening",
  };
}

export function reasonLabel(docType, code) {
  const reasons = docType === DOC_TYPE.issue ? ISSUE_REASONS : RECEIPT_REASONS;
  return reasons.find((r) => r.code === code)?.labelAr || code || "—";
}

export function inventorySelectableUnits(units) {
  const list = Array.isArray(units) ? units : [];
  const enabled = list.filter(
    (u) => u.sale_enabled !== false || u.purchase_enabled !== false
  );
  return enabled.length ? enabled : list;
}

export function pickDefaultInventoryUnit(units) {
  if (!Array.isArray(units) || units.length === 0) return null;
  const enabled = units.filter(
    (u) => u.sale_enabled !== false || u.purchase_enabled !== false
  );
  const pool = enabled.length ? enabled : units;
  return (
    pool.find((u) => u.unit_name === "كغم") ||
    pool.find((u) => Number(u.conversion_to_base) === 1 && u.unit_name !== "حبة") ||
    pool.find((u) => u.is_default) ||
    pool[0]
  );
}

export function lineBaseQuantity(quantity, conversion) {
  const qty = Number(quantity);
  const conv = Number(conversion);
  if (!Number.isFinite(qty) || !Number.isFinite(conv)) return 0;
  return Math.round(qty * conv * 1e6) / 1e6;
}
