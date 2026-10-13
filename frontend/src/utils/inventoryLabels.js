import { batchSourceLabel, DATED_BATCH_LABEL, UNDATED_BATCH_LABEL } from "./stockBatchLabels";

export { batchSourceLabel, DATED_BATCH_LABEL, UNDATED_BATCH_LABEL };

/** Ledger movement_type values stored on inventory_ledger. */
export const LEDGER_MOVEMENT_LABELS = {
  sale: "بيع",
  refund: "استرجاع",
  purchase_receive: "استلام شراء",
  supplier_return: "مرتجع مورد",
  manual_adjustment: "تعديل مخزون",
  warehouse_transfer_in: "تحويل وارد",
  warehouse_transfer_out: "تحويل صادر",
  stock_count_correction: "تسوية جرد",
  expiry_writeoff: "تالف",
};

/**
 * Older movement names. The ledger stores the mapped type; these labels
 * cover any row that still carries the pre-ledger name.
 */
const LEGACY_MOVEMENT_LABELS = {
  purchase: "استلام شراء",
  purchase_return: "مرتجع مورد",
  adjust_in: "تعديل مخزون",
  adjust_out: "تعديل مخزون",
  damage: "تالف",
  consumption: "استهلاك",
  correction: "تعديل مخزون",
  count: "تسوية جرد",
  transfer_in: "تحويل وارد",
  transfer_out: "تحويل صادر",
  opening: "إدخال مخزون",
};

export const MOVEMENT_TONE = {
  sale: "red",
  refund: "green",
  purchase_receive: "green",
  supplier_return: "orange",
  manual_adjustment: "neutral",
  warehouse_transfer_in: "blue",
  warehouse_transfer_out: "blue",
  stock_count_correction: "orange",
  expiry_writeoff: "red",
  purchase: "green",
  purchase_return: "orange",
  adjust_in: "green",
  adjust_out: "red",
  damage: "red",
  consumption: "orange",
  correction: "neutral",
  count: "orange",
  transfer_in: "blue",
  transfer_out: "blue",
  opening: "green",
};

export const ADJUSTMENT_TYPE_LABELS = {
  in: "إدخال مخزون",
  out: "إخراج مخزون",
  damage: "تالف",
  consumption: "استهلاك",
  correction: "تصحيح",
};

/** reference_type values written beside a ledger row. */
export const REFERENCE_TYPE_LABELS = {
  transaction: "فاتورة بيع",
  refund: "استرجاع",
  purchase_invoice: "فاتورة شراء",
  purchase_return: "مرتجع مورد",
  stock_adjustment: "تعديل مخزون",
  stock_count: "جرد مخزون",
  stock_count_session: "جلسة جرد",
  zero_all_stock: "تصفير المخزون",
  warehouse_transfer: "تحويل مستودع",
  inventory_receipt: "سند إدخال بضاعة",
  inventory_issue: "سند إخراج بضاعة",
  inventory_document: "سند مخزون",
  product_import: "استيراد منتجات",
  product_create: "إنشاء منتج",
  shop_consumption: "استهلاك المحل",
};

export const WAREHOUSE_TYPE_LABELS = {
  main: "المخزن الرئيسي",
  returns: "مرتجعات",
  store: "مستودع المتجر",
  damaged: "تالف",
};

const WAREHOUSE_NAME_ALIASES = {
  main: "main",
  "main warehouse": "main",
  returns: "returns",
  "returns warehouse": "returns",
  ret: "returns",
  store: "store",
  "store warehouse": "store",
  damaged: "damaged",
  "damaged warehouse": "damaged",
  dmg: "damaged",
};

export function movementLabel(type) {
  if (type == null || type === "") return "—";
  return LEDGER_MOVEMENT_LABELS[type] || LEGACY_MOVEMENT_LABELS[type] || "—";
}

export function movementTone(type) {
  return MOVEMENT_TONE[type] || "neutral";
}

export function adjustmentTypeLabel(type) {
  if (type == null || type === "") return "—";
  return ADJUSTMENT_TYPE_LABELS[type] || "—";
}

export function referenceTypeLabel(type) {
  if (type == null || type === "") return "—";
  return REFERENCE_TYPE_LABELS[type] || "—";
}

export function referenceDisplay(row) {
  if (!row) return "—";
  if (row.reference_label) return row.reference_label;
  if (row.notes) return row.notes;
  const type = row.reference_type || row.ref_type;
  if (!type) return "—";
  const label = referenceTypeLabel(type);
  if (label === "—") return "—";
  const id = row.reference_id ?? row.ref_id;
  return id != null && id !== "" ? `${label} #${id}` : label;
}

export function warehouseTypeLabel(type) {
  if (type == null || type === "") return "—";
  return WAREHOUSE_TYPE_LABELS[type] || "—";
}

/**
 * Historical warehouse names stay as stored when they are already readable.
 * Raw type tokens (main, store, …) become the Arabic type label.
 */
export function warehouseDisplayName(name, type) {
  const raw = String(name ?? "").trim();
  const key = raw.toLowerCase().replace(/\s+/g, " ");
  const alias = WAREHOUSE_NAME_ALIASES[key];
  if (alias) return WAREHOUSE_TYPE_LABELS[alias];
  if (raw) return raw;
  return warehouseTypeLabel(type);
}

/** Operational transfer choices are only the two live warehouses. */
export function warehouseChoiceLabel(warehouse) {
  const type = warehouse?.type;
  if (type === "main" || type === "returns") return WAREHOUSE_TYPE_LABELS[type];
  return warehouseDisplayName(warehouse?.name, type);
}
