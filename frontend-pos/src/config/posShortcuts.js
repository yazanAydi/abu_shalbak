export const POS_SHORTCUTS = {
  undoLastScan: { key: "F2", label: "حذف آخر صنف" },
  newInvoice: { key: "F4", label: "فاتورة جديدة" },
  completeSale: { key: "F12", label: "إتمام البيع" },
  submitPayment: { key: "F12", label: "ترحيل" },
  holdCart: { key: "", label: "تعليق الفاتورة" },
  suspendedCarts: { key: "", label: "الفواتير المعلقة" },
};

/** Merge server-configured shortcut keys when set in app settings. */
export function mergePosShortcutsFromSettings(settings) {
  const merged = { ...POS_SHORTCUTS };
  if (settings?.pos_shortcut_hold_cart) {
    merged.holdCart = { ...merged.holdCart, key: String(settings.pos_shortcut_hold_cart).trim() };
  }
  if (settings?.pos_shortcut_suspended_carts) {
    merged.suspendedCarts = {
      ...merged.suspendedCarts,
      key: String(settings.pos_shortcut_suspended_carts).trim(),
    };
  }
  return merged;
}

export function formatShortcutHint(shortcut) {
  if (!shortcut.key) return shortcut.label;
  return `${shortcut.label}: ${shortcut.key}`;
}
