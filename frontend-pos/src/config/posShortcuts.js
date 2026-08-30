export const POS_SHORTCUTS = {
  undoLastScan: { key: "F2", label: "حذف آخر صنف" },
  newInvoice: { key: "F4", label: "فاتورة جديدة" },
  completeSale: { key: "F9", label: "إتمام البيع" },
  submitPayment: { key: "F9", label: "ترحيل" },
  holdCart: { key: "", label: "تعليق الفاتورة" },
  suspendedCarts: { key: "", label: "الفواتير المعلقة" },
};

/**
 * Browser-reserved shortcuts that Chromium (Edge/Chrome) handles before
 * the page can cancel them. Binding these opens DevTools, History, etc.
 */
export const RESERVED_BROWSER_KEYS = new Set([
  "f1",
  "f6",
  "f7",
  "f11",
  "f12",
  "ctrl+shift+i",
  "ctrl+shift+j",
  "ctrl+shift+c",
  "ctrl+n",
  "ctrl+t",
  "ctrl+w",
  "ctrl+h",
  "ctrl+l",
  "ctrl+p",
  "ctrl+s",
]);

export function normalizeShortcutKey(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  const parts = trimmed.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const modifiers = [];
  let key = "";
  for (const part of parts) {
    const mod = part === "control" ? "ctrl" : part;
    if (mod === "ctrl" || mod === "shift" || mod === "alt") {
      if (!modifiers.includes(mod)) modifiers.push(mod);
    } else {
      key = part;
    }
  }
  const order = { ctrl: 0, alt: 1, shift: 2 };
  modifiers.sort((a, b) => (order[a] ?? 9) - (order[b] ?? 9));
  return [...modifiers, key].filter(Boolean).join("+");
}

export function isReservedBrowserShortcut(raw) {
  const normalized = normalizeShortcutKey(raw);
  return Boolean(normalized) && RESERVED_BROWSER_KEYS.has(normalized);
}

function safeConfiguredKey(raw) {
  const key = String(raw ?? "").trim();
  if (!key || isReservedBrowserShortcut(key)) return "";
  return key;
}

/** Merge server-configured shortcut keys when set in app settings. */
export function mergePosShortcutsFromSettings(settings) {
  const merged = { ...POS_SHORTCUTS };
  const holdKey = safeConfiguredKey(settings?.pos_shortcut_hold_cart);
  if (holdKey) {
    merged.holdCart = { ...merged.holdCart, key: holdKey };
  }
  const suspendedKey = safeConfiguredKey(settings?.pos_shortcut_suspended_carts);
  if (suspendedKey) {
    merged.suspendedCarts = {
      ...merged.suspendedCarts,
      key: suspendedKey,
    };
  }
  return merged;
}

export function formatShortcutHint(shortcut) {
  if (!shortcut.key) return shortcut.label;
  return `${shortcut.label}: ${shortcut.key}`;
}
