export const INVENTORY_DOCUMENT_TYPES = ["receipt", "issue"];

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

export const RECEIPT_REASON_CODES = RECEIPT_REASONS.map((r) => r.code);
export const ISSUE_REASON_CODES = ISSUE_REASONS.map((r) => r.code);

const RECEIPT_LABELS = Object.fromEntries(RECEIPT_REASONS.map((r) => [r.code, r.labelAr]));
const ISSUE_LABELS = Object.fromEntries(ISSUE_REASONS.map((r) => [r.code, r.labelAr]));

export function reasonsForType(documentType) {
  return documentType === "issue" ? ISSUE_REASONS : RECEIPT_REASONS;
}

export function reasonCodesForType(documentType) {
  return documentType === "issue" ? ISSUE_REASON_CODES : RECEIPT_REASON_CODES;
}

export function isValidReason(documentType, reason) {
  return reasonCodesForType(documentType).includes(String(reason || ""));
}

export function reasonLabelAr(documentType, reason) {
  const map = documentType === "issue" ? ISSUE_LABELS : RECEIPT_LABELS;
  return map[reason] || reason || "—";
}

export function documentTypeTitleAr(documentType) {
  return documentType === "issue" ? "سند إخراج بضاعة" : "سند إدخال بضاعة";
}

export function documentTypeListTitleAr(documentType) {
  return documentType === "issue" ? "سندات إخراج البضاعة" : "سندات إدخال البضاعة";
}

export function ledgerNoteForDocument(documentType, documentNumber) {
  return `${documentTypeTitleAr(documentType)} #${documentNumber}`;
}

export function sequenceNameForType(documentType) {
  return documentType === "issue" ? "inventory_issue" : "inventory_receipt";
}

export function documentNumberPrefix(documentType) {
  return documentType === "issue" ? "GOUT" : "GIN";
}
