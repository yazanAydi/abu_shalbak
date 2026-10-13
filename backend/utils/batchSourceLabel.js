/** Display labels for batch_source. Keep in sync with frontend/src/utils/stockBatchLabels.js */

export const DATED_BATCH_LABEL = "دفعة بتاريخ صلاحية";
export const UNDATED_BATCH_LABEL = "بدون تاريخ صلاحية";

export function batchSourceLabelAr(source, expiryDate) {
  if (source === "undated") return UNDATED_BATCH_LABEL;
  if (source === "dated") {
    const date = expiryDate ? String(expiryDate).slice(0, 10) : "";
    return date ? `${DATED_BATCH_LABEL} — ${date}` : DATED_BATCH_LABEL;
  }
  return null;
}
