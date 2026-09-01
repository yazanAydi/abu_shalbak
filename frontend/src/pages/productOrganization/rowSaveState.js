export const ROW_SAVE = {
  IDLE: "idle",
  SAVING: "saving",
  SAVED: "saved",
  ERROR: "error",
};

export function savingLabel() {
  return "جاري الحفظ...";
}

export function savedLabel() {
  return "تم الحفظ";
}

export function errorLabel() {
  return "تعذر حفظ التغيير";
}

export function applySuccessfulPatch(rows, productId, patch) {
  if (!Array.isArray(rows) || !patch) return rows || [];
  const id = Number(productId);
  return rows.map((row) => (Number(row.id) === id ? { ...row, ...patch } : row));
}

export function revertRow(rows, productId, previous) {
  return applySuccessfulPatch(rows, productId, previous);
}

export function rowSaveMessage(state) {
  if (!state || state.status === ROW_SAVE.IDLE) return "";
  if (state.status === ROW_SAVE.SAVING) return savingLabel();
  if (state.status === ROW_SAVE.SAVED) return savedLabel();
  if (state.status === ROW_SAVE.ERROR) return state.message || errorLabel();
  return "";
}
