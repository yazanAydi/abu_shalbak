import {
  defaultAccountantPermissions,
  normalizeAccountantPermissions,
} from "./accountantPermissions.js";
import { CACHE_KEYS, cacheClone, cacheGet, cacheInvalidate, cacheSet } from "./cache.js";
import { STORE_LICENSE_LINE, STORE_NAME_AR, STORE_PHONE } from "./storeBranding.js";

export const OTHER_QUICK_CATEGORY = "أخرى";
export const DEFAULT_QUICK_CATEGORIES = ["معجنات", "بيتزا", OTHER_QUICK_CATEGORY];
export const DEFAULT_DAIRY_CATEGORIES = ["ألبان"];

export const SETTING_KEYS = {
  default_tax_rate: "default_tax_rate",
  tax_inclusive: "tax_inclusive",
  business_day_cutoff_hour: "business_day_cutoff_hour",
  receipt_show_tax: "receipt_show_tax",
  receipt_show_cashier: "receipt_show_cashier",
  receipt_logo_url: "receipt_logo_url",
  store_name_ar: "store_name_ar",
  store_phone: "store_phone",
  store_address: "store_address",
  store_license: "store_license",
  print_show_logo: "print_show_logo",
  print_show_name: "print_show_name",
  print_show_phone: "print_show_phone",
  print_show_address: "print_show_address",
  print_show_license: "print_show_license",
  pos_favorite_product_ids: "pos_favorite_product_ids",
  pos_quick_categories: "pos_quick_categories",
  pos_quick_buttons: "pos_quick_buttons",
  shift_variance_threshold: "shift_variance_threshold",
  default_opening_cash: "default_opening_cash",
  refund_telegram_manager_user_id: "refund_telegram_manager_user_id",
  expiry_alert_days: "expiry_alert_days",
  expiry_alert_days_dairy: "expiry_alert_days_dairy",
  expiry_dairy_categories: "expiry_dairy_categories",
  pos_shortcut_hold_cart: "pos_shortcut_hold_cart",
  pos_shortcut_suspended_carts: "pos_shortcut_suspended_carts",
  accountant_permissions: "accountant_permissions",
  product_delete_password: "product_delete_password",
  zero_all_stock_password: "zero_all_stock_password",
};

const MAX_POS_FAVORITES = 24;
const MAX_QUICK_CATEGORIES = 20;
const MAX_DAIRY_CATEGORIES = 20;
const MAX_POS_QUICK_BUTTONS = 48;

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

const RESERVED_SHORTCUT_ERROR =
  "هذا الاختصار محجوز للمتصفح (مثل F12 أو Ctrl+Shift+I). اختر مفتاحاً آخر مثل F8 أو Ctrl+Shift+L";

export function normalizeShortcutKey(raw) {
  const trimmed = String(raw ?? "").trim().slice(0, 40);
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

function formatShortcutKey(normalized) {
  if (!normalized) return "";
  return normalized
    .split("+")
    .map((part) => {
      if (part === "ctrl") return "Ctrl";
      if (part === "shift") return "Shift";
      if (part === "alt") return "Alt";
      if (/^f\d+$/.test(part)) return part.toUpperCase();
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join("+");
}

export function sanitizePosShortcut(raw) {
  const normalized = normalizeShortcutKey(raw);
  if (!normalized) return "";
  if (RESERVED_BROWSER_KEYS.has(normalized)) {
    throw new Error(RESERVED_SHORTCUT_ERROR);
  }
  return formatShortcutKey(normalized);
}

function parsePosShortcut(raw) {
  const normalized = normalizeShortcutKey(raw);
  if (!normalized || RESERVED_BROWSER_KEYS.has(normalized)) return "";
  return formatShortcutKey(normalized);
}

const DEFAULTS = {
  [SETTING_KEYS.default_tax_rate]: 0.16,
  [SETTING_KEYS.tax_inclusive]: true,
  [SETTING_KEYS.business_day_cutoff_hour]: 0,
  [SETTING_KEYS.receipt_show_tax]: true,
  [SETTING_KEYS.receipt_show_cashier]: true,
  [SETTING_KEYS.receipt_logo_url]: "",
  [SETTING_KEYS.store_name_ar]: STORE_NAME_AR,
  [SETTING_KEYS.store_phone]: STORE_PHONE,
  [SETTING_KEYS.store_address]: "",
  [SETTING_KEYS.store_license]: STORE_LICENSE_LINE,
  [SETTING_KEYS.print_show_logo]: true,
  [SETTING_KEYS.print_show_name]: true,
  [SETTING_KEYS.print_show_phone]: true,
  [SETTING_KEYS.print_show_address]: false,
  [SETTING_KEYS.print_show_license]: true,
  [SETTING_KEYS.pos_favorite_product_ids]: [],
  [SETTING_KEYS.pos_quick_categories]: [...DEFAULT_QUICK_CATEGORIES],
  [SETTING_KEYS.pos_quick_buttons]: [],
  [SETTING_KEYS.shift_variance_threshold]: 50,
  [SETTING_KEYS.default_opening_cash]: 0,
  [SETTING_KEYS.refund_telegram_manager_user_id]: 0,
  [SETTING_KEYS.expiry_alert_days]: 7,
  [SETTING_KEYS.expiry_alert_days_dairy]: 3,
  [SETTING_KEYS.expiry_dairy_categories]: [...DEFAULT_DAIRY_CATEGORIES],
  [SETTING_KEYS.pos_shortcut_hold_cart]: "",
  [SETTING_KEYS.pos_shortcut_suspended_carts]: "",
  [SETTING_KEYS.accountant_permissions]: defaultAccountantPermissions(),
};

function parseFavoriteIds(raw) {
  if (raw === undefined || raw === null || raw === "") return [];
  try {
    const arr = JSON.parse(String(raw));
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => Math.floor(Number(x)))
      .filter((id) => Number.isFinite(id) && id > 0)
      .slice(0, MAX_POS_FAVORITES);
  } catch {
    return [];
  }
}

function serializeFavoriteIds(ids) {
  const arr = Array.isArray(ids) ? ids : [];
  const clean = arr
    .map((x) => Math.floor(Number(x)))
    .filter((id) => Number.isFinite(id) && id > 0)
    .slice(0, MAX_POS_FAVORITES);
  return JSON.stringify(clean);
}

export function normalizeQuickCategories(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_QUICK_CATEGORIES];
  const seen = new Set();
  const clean = [];
  for (const item of raw) {
    const name = String(item ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    clean.push(name);
    if (clean.length >= MAX_QUICK_CATEGORIES) break;
  }
  if (!clean.includes(OTHER_QUICK_CATEGORY)) clean.push(OTHER_QUICK_CATEGORY);
  return clean.length ? clean : [...DEFAULT_QUICK_CATEGORIES];
}

function parseQuickCategories(raw) {
  if (raw === undefined || raw === null || raw === "") return [...DEFAULT_QUICK_CATEGORIES];
  try {
    const arr = JSON.parse(String(raw));
    return normalizeQuickCategories(arr);
  } catch {
    return [...DEFAULT_QUICK_CATEGORIES];
  }
}

function serializeQuickCategories(categories) {
  return JSON.stringify(normalizeQuickCategories(categories));
}

export function normalizeDairyCategories(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_DAIRY_CATEGORIES];
  const seen = new Set();
  const clean = [];
  for (const item of raw) {
    const name = String(item ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    clean.push(name);
    if (clean.length >= MAX_DAIRY_CATEGORIES) break;
  }
  return clean;
}

function parseDairyCategories(raw) {
  if (raw === undefined || raw === null || raw === "") return [...DEFAULT_DAIRY_CATEGORIES];
  try {
    const arr = JSON.parse(String(raw));
    return normalizeDairyCategories(arr);
  } catch {
    return [...DEFAULT_DAIRY_CATEGORIES];
  }
}

function serializeDairyCategories(categories) {
  return JSON.stringify(normalizeDairyCategories(categories));
}

export function normalizeQuickButtons(raw, categories) {
  const cats = normalizeQuickCategories(categories);
  const catSet = new Set(cats);
  const fallback = cats.includes(OTHER_QUICK_CATEGORY) ? OTHER_QUICK_CATEGORY : cats[cats.length - 1];
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const clean = [];
  for (const item of raw) {
    const productId = Math.floor(Number(item?.product_id ?? item?.productId));
    if (!Number.isFinite(productId) || productId <= 0 || seen.has(productId)) continue;
    let category = String(item?.category ?? "").trim();
    if (!catSet.has(category)) category = fallback;
    seen.add(productId);
    clean.push({ product_id: productId, category });
    if (clean.length >= MAX_POS_QUICK_BUTTONS) break;
  }
  return clean;
}

export function moveButtonsFromRemovedCategories(buttons, oldCategories, newCategories) {
  const newSet = new Set(normalizeQuickCategories(newCategories));
  const fallback = newSet.has(OTHER_QUICK_CATEGORY) ? OTHER_QUICK_CATEGORY : [...newSet].pop();
  const removed = new Set(
    normalizeQuickCategories(oldCategories).filter((c) => !newSet.has(c))
  );
  if (removed.size === 0) return buttons;
  return buttons.map((b) =>
    removed.has(b.category) ? { ...b, category: fallback } : b
  );
}

function parseQuickButtons(raw, categories) {
  if (raw === undefined || raw === null || raw === "") return [];
  try {
    const arr = JSON.parse(String(raw));
    return normalizeQuickButtons(arr, categories);
  } catch {
    return [];
  }
}

function serializeQuickButtons(buttons, categories) {
  return JSON.stringify(normalizeQuickButtons(buttons, categories));
}

function migrateLegacyFavorites(favoriteIds, quickButtons) {
  if (quickButtons.length > 0) return quickButtons;
  const ids = favoriteIds || [];
  return ids.map((id) => ({ product_id: id, category: OTHER_QUICK_CATEGORY }));
}

function parseValue(key, raw, context = {}) {
  if (raw === undefined || raw === null) return DEFAULTS[key];
  switch (key) {
    case SETTING_KEYS.default_tax_rate: {
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULTS[key];
    }
    case SETTING_KEYS.tax_inclusive:
    case SETTING_KEYS.receipt_show_tax:
    case SETTING_KEYS.receipt_show_cashier:
    case SETTING_KEYS.print_show_logo:
    case SETTING_KEYS.print_show_name:
    case SETTING_KEYS.print_show_phone:
    case SETTING_KEYS.print_show_address:
    case SETTING_KEYS.print_show_license:
      return raw === "1" || raw === "true" || raw === true;
    case SETTING_KEYS.business_day_cutoff_hour: {
      const h = Math.floor(Number(raw));
      return Number.isFinite(h) && h >= 0 && h <= 23 ? h : DEFAULTS[key];
    }
    case SETTING_KEYS.pos_favorite_product_ids:
      return parseFavoriteIds(raw);
    case SETTING_KEYS.pos_quick_categories:
      return parseQuickCategories(raw);
    case SETTING_KEYS.pos_quick_buttons:
      return parseQuickButtons(raw, context.categories || DEFAULT_QUICK_CATEGORIES);
    case SETTING_KEYS.shift_variance_threshold:
    case SETTING_KEYS.default_opening_cash:
    case SETTING_KEYS.refund_telegram_manager_user_id:
    case SETTING_KEYS.expiry_alert_days:
    case SETTING_KEYS.expiry_alert_days_dairy: {
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULTS[key];
    }
    case SETTING_KEYS.expiry_dairy_categories:
      return parseDairyCategories(raw);
    case SETTING_KEYS.accountant_permissions: {
      if (raw === undefined || raw === null || raw === "") {
        return defaultAccountantPermissions();
      }
      try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        return normalizeAccountantPermissions(parsed);
      } catch {
        return defaultAccountantPermissions();
      }
    }
    default:
      if (key === SETTING_KEYS.pos_shortcut_hold_cart || key === SETTING_KEYS.pos_shortcut_suspended_carts) {
        return parsePosShortcut(raw);
      }
      return String(raw);
  }
}

export async function getAppSettings(db) {
  const cached = cacheGet(CACHE_KEYS.SETTINGS);
  if (cached) return cacheClone(cached);
  const rows = await db.all("SELECT key, value FROM app_settings");
  const map = {};
  for (const r of rows) map[r.key] = r.value;

  const pos_favorite_product_ids = parseValue(
    SETTING_KEYS.pos_favorite_product_ids,
    map[SETTING_KEYS.pos_favorite_product_ids]
  );
  const pos_quick_categories = parseValue(
    SETTING_KEYS.pos_quick_categories,
    map[SETTING_KEYS.pos_quick_categories]
  );
  let pos_quick_buttons = parseValue(SETTING_KEYS.pos_quick_buttons, map[SETTING_KEYS.pos_quick_buttons], {
    categories: pos_quick_categories,
  });
  pos_quick_buttons = migrateLegacyFavorites(pos_favorite_product_ids, pos_quick_buttons);

  return {
    default_tax_rate: parseValue(SETTING_KEYS.default_tax_rate, map[SETTING_KEYS.default_tax_rate]),
    tax_inclusive: parseValue(SETTING_KEYS.tax_inclusive, map[SETTING_KEYS.tax_inclusive]),
    business_day_cutoff_hour: parseValue(SETTING_KEYS.business_day_cutoff_hour, map[SETTING_KEYS.business_day_cutoff_hour]),
    receipt_show_tax: parseValue(SETTING_KEYS.receipt_show_tax, map[SETTING_KEYS.receipt_show_tax]),
    receipt_show_cashier: parseValue(SETTING_KEYS.receipt_show_cashier, map[SETTING_KEYS.receipt_show_cashier]),
    receipt_logo_url: parseValue(SETTING_KEYS.receipt_logo_url, map[SETTING_KEYS.receipt_logo_url]),
    store_name_ar: parseValue(SETTING_KEYS.store_name_ar, map[SETTING_KEYS.store_name_ar]),
    store_phone: parseValue(SETTING_KEYS.store_phone, map[SETTING_KEYS.store_phone]),
    store_address: parseValue(SETTING_KEYS.store_address, map[SETTING_KEYS.store_address]),
    store_license: parseValue(SETTING_KEYS.store_license, map[SETTING_KEYS.store_license]),
    print_show_logo: parseValue(SETTING_KEYS.print_show_logo, map[SETTING_KEYS.print_show_logo]),
    print_show_name: parseValue(SETTING_KEYS.print_show_name, map[SETTING_KEYS.print_show_name]),
    print_show_phone: parseValue(SETTING_KEYS.print_show_phone, map[SETTING_KEYS.print_show_phone]),
    print_show_address: parseValue(SETTING_KEYS.print_show_address, map[SETTING_KEYS.print_show_address]),
    print_show_license: parseValue(SETTING_KEYS.print_show_license, map[SETTING_KEYS.print_show_license]),
    pos_favorite_product_ids,
    pos_quick_categories,
    pos_quick_buttons,
    shift_variance_threshold: parseValue(
      SETTING_KEYS.shift_variance_threshold,
      map[SETTING_KEYS.shift_variance_threshold]
    ),
    default_opening_cash: parseValue(
      SETTING_KEYS.default_opening_cash,
      map[SETTING_KEYS.default_opening_cash]
    ),
    refund_telegram_manager_user_id: parseValue(
      SETTING_KEYS.refund_telegram_manager_user_id,
      map[SETTING_KEYS.refund_telegram_manager_user_id]
    ),
    expiry_alert_days: (() => {
      const n = parseValue(SETTING_KEYS.expiry_alert_days, map[SETTING_KEYS.expiry_alert_days]);
      return n >= 1 && n <= 365 ? n : DEFAULTS[SETTING_KEYS.expiry_alert_days];
    })(),
    expiry_alert_days_dairy: (() => {
      const n = parseValue(
        SETTING_KEYS.expiry_alert_days_dairy,
        map[SETTING_KEYS.expiry_alert_days_dairy]
      );
      return n >= 1 && n <= 365 ? n : DEFAULTS[SETTING_KEYS.expiry_alert_days_dairy];
    })(),
    expiry_dairy_categories: parseValue(
      SETTING_KEYS.expiry_dairy_categories,
      map[SETTING_KEYS.expiry_dairy_categories]
    ),
    pos_shortcut_hold_cart: parseValue(
      SETTING_KEYS.pos_shortcut_hold_cart,
      map[SETTING_KEYS.pos_shortcut_hold_cart]
    ),
    pos_shortcut_suspended_carts: parseValue(
      SETTING_KEYS.pos_shortcut_suspended_carts,
      map[SETTING_KEYS.pos_shortcut_suspended_carts]
    ),
    accountant_permissions: parseValue(
      SETTING_KEYS.accountant_permissions,
      map[SETTING_KEYS.accountant_permissions]
    ),
    product_delete_password_set: Boolean(
      String(map[SETTING_KEYS.product_delete_password] ?? "").trim()
    ),
    zero_all_stock_password_set: Boolean(
      String(map[SETTING_KEYS.zero_all_stock_password] ?? "").trim()
    ),
  };
  cacheSet(CACHE_KEYS.SETTINGS, settings);
  return cacheClone(settings);
}

export async function getProductDeletePasswordHash(db) {
  const row = await db.get("SELECT value FROM app_settings WHERE key = ?", [
    SETTING_KEYS.product_delete_password,
  ]);
  const hash = String(row?.value ?? "").trim();
  return hash || null;
}

export async function setProductDeletePasswordHash(db, hash) {
  const value = String(hash ?? "").trim();
  if (!value) {
    throw new Error("تجزئة كلمة مرور الحذف مطلوبة");
  }
  await db.run(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [SETTING_KEYS.product_delete_password, value]
  );
  cacheInvalidate(CACHE_KEYS.SETTINGS);
}

export async function clearProductDeletePassword(db) {
  await db.run("DELETE FROM app_settings WHERE key = ?", [SETTING_KEYS.product_delete_password]);
  cacheInvalidate(CACHE_KEYS.SETTINGS);
}

export async function getZeroAllStockPasswordHash(db) {
  const row = await db.get("SELECT value FROM app_settings WHERE key = ?", [
    SETTING_KEYS.zero_all_stock_password,
  ]);
  const hash = String(row?.value ?? "").trim();
  return hash || null;
}

export async function setZeroAllStockPasswordHash(db, hash) {
  const value = String(hash ?? "").trim();
  if (!value) {
    throw new Error("تجزئة كلمة مرور تصفير الكميات مطلوبة");
  }
  await db.run(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [SETTING_KEYS.zero_all_stock_password, value]
  );
  cacheInvalidate(CACHE_KEYS.SETTINGS);
}

export async function clearZeroAllStockPassword(db) {
  await db.run("DELETE FROM app_settings WHERE key = ?", [SETTING_KEYS.zero_all_stock_password]);
  cacheInvalidate(CACHE_KEYS.SETTINGS);
}

export async function updateAppSettings(db, patch) {
  const current = await getAppSettings(db);

  let nextCategories = current.pos_quick_categories;
  let nextButtons = current.pos_quick_buttons;

  if (patch[SETTING_KEYS.pos_quick_categories] !== undefined) {
    const incoming = normalizeQuickCategories(patch[SETTING_KEYS.pos_quick_categories]);
    nextButtons = moveButtonsFromRemovedCategories(nextButtons, nextCategories, incoming);
    nextCategories = incoming;
  }

  if (patch[SETTING_KEYS.pos_quick_buttons] !== undefined) {
    if (!Array.isArray(patch[SETTING_KEYS.pos_quick_buttons])) {
      throw new Error("أزرار الكاشير يجب أن تكون قائمة");
    }
    nextButtons = normalizeQuickButtons(patch[SETTING_KEYS.pos_quick_buttons], nextCategories);
    if (nextButtons.length > MAX_POS_QUICK_BUTTONS) {
      throw new Error(`الحد الأقصى ${MAX_POS_QUICK_BUTTONS} منتجاً في أزرار الكاشير`);
    }
  } else if (patch[SETTING_KEYS.pos_quick_categories] !== undefined) {
    nextButtons = normalizeQuickButtons(nextButtons, nextCategories);
  }

  const effectivePatch = { ...patch };
  if (
    patch[SETTING_KEYS.pos_quick_categories] !== undefined ||
    patch[SETTING_KEYS.pos_quick_buttons] !== undefined
  ) {
    effectivePatch[SETTING_KEYS.pos_quick_categories] = nextCategories;
    effectivePatch[SETTING_KEYS.pos_quick_buttons] = nextButtons;
  }

  const allowed = {
    [SETTING_KEYS.default_tax_rate]: (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error("نسبة الضريبة يجب أن تكون بين 0 و 1");
      return String(n);
    },
    [SETTING_KEYS.tax_inclusive]: (v) => (v ? "1" : "0"),
    [SETTING_KEYS.business_day_cutoff_hour]: (v) => {
      const h = Math.floor(Number(v));
      if (!Number.isFinite(h) || h < 0 || h > 23) throw new Error("ساعة بداية اليوم يجب أن تكون 0-23");
      return String(h);
    },
    [SETTING_KEYS.receipt_show_tax]: (v) => (v ? "1" : "0"),
    [SETTING_KEYS.receipt_show_cashier]: (v) => (v ? "1" : "0"),
    [SETTING_KEYS.receipt_logo_url]: (v) => String(v ?? "").trim().slice(0, 500),
    [SETTING_KEYS.store_name_ar]: (v) => String(v ?? "").trim().slice(0, 120),
    [SETTING_KEYS.store_phone]: (v) => String(v ?? "").trim().slice(0, 40),
    [SETTING_KEYS.store_address]: (v) => String(v ?? "").trim().slice(0, 200),
    [SETTING_KEYS.store_license]: (v) => String(v ?? "").trim().slice(0, 80),
    [SETTING_KEYS.print_show_logo]: (v) => (v ? "1" : "0"),
    [SETTING_KEYS.print_show_name]: (v) => (v ? "1" : "0"),
    [SETTING_KEYS.print_show_phone]: (v) => (v ? "1" : "0"),
    [SETTING_KEYS.print_show_address]: (v) => (v ? "1" : "0"),
    [SETTING_KEYS.print_show_license]: (v) => (v ? "1" : "0"),
    [SETTING_KEYS.pos_favorite_product_ids]: (v) => {
      if (!Array.isArray(v)) throw new Error("أزرار الكاشير يجب أن تكون قائمة معرفات");
      if (v.length > MAX_POS_FAVORITES) {
        throw new Error(`الحد الأقصى ${MAX_POS_FAVORITES} منتجاً في أزرار الكاشير`);
      }
      return serializeFavoriteIds(v);
    },
    [SETTING_KEYS.pos_quick_categories]: (v) => serializeQuickCategories(v),
    [SETTING_KEYS.pos_quick_buttons]: (v, categories) => serializeQuickButtons(v, categories),
    [SETTING_KEYS.shift_variance_threshold]: (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error("حد الفارق يجب أن يكون رقماً موجباً");
      return String(n);
    },
    [SETTING_KEYS.default_opening_cash]: (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error("النقد الافتتاحي يجب أن يكون رقماً موجباً");
      return String(n);
    },
    [SETTING_KEYS.refund_telegram_manager_user_id]: (v) => {
      const n = Math.floor(Number(v));
      if (!Number.isFinite(n) || n < 0) throw new Error("معرّف مدير التيليجرام غير صالح");
      return String(n);
    },
    [SETTING_KEYS.expiry_alert_days]: (v) => {
      const n = Math.floor(Number(v));
      if (!Number.isFinite(n) || n < 1 || n > 365) {
        throw new Error("أيام تنبيه الصلاحية يجب أن تكون بين 1 و 365");
      }
      return String(n);
    },
    [SETTING_KEYS.expiry_alert_days_dairy]: (v) => {
      const n = Math.floor(Number(v));
      if (!Number.isFinite(n) || n < 1 || n > 365) {
        throw new Error("أيام تنبيه الألبان يجب أن تكون بين 1 و 365");
      }
      return String(n);
    },
    [SETTING_KEYS.expiry_dairy_categories]: (v) => serializeDairyCategories(v),
    [SETTING_KEYS.pos_shortcut_hold_cart]: (v) => sanitizePosShortcut(v),
    [SETTING_KEYS.pos_shortcut_suspended_carts]: (v) => sanitizePosShortcut(v),
    [SETTING_KEYS.accountant_permissions]: (v) => {
      if (v === undefined || v === null) {
        return JSON.stringify(defaultAccountantPermissions());
      }
      return JSON.stringify(normalizeAccountantPermissions(v));
    },
  };

  for (const [key, converter] of Object.entries(allowed)) {
    if (effectivePatch[key] === undefined) continue;
    const value =
      key === SETTING_KEYS.pos_quick_buttons
        ? converter(effectivePatch[key], nextCategories)
        : converter(effectivePatch[key]);
    await db.run(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value]
    );
  }
  cacheInvalidate(CACHE_KEYS.SETTINGS);
  return getAppSettings(db);
}

export async function seedDefaultSettings(db) {
  const defaults = [
    [SETTING_KEYS.default_tax_rate, "0.16"],
    [SETTING_KEYS.tax_inclusive, "1"],
    [SETTING_KEYS.business_day_cutoff_hour, "0"],
    [SETTING_KEYS.receipt_show_tax, "1"],
    [SETTING_KEYS.receipt_show_cashier, "1"],
    [SETTING_KEYS.receipt_logo_url, ""],
    [SETTING_KEYS.store_name_ar, STORE_NAME_AR],
    [SETTING_KEYS.store_phone, STORE_PHONE],
    [SETTING_KEYS.store_address, ""],
    [SETTING_KEYS.store_license, STORE_LICENSE_LINE],
    [SETTING_KEYS.print_show_logo, "1"],
    [SETTING_KEYS.print_show_name, "1"],
    [SETTING_KEYS.print_show_phone, "1"],
    [SETTING_KEYS.print_show_address, "0"],
    [SETTING_KEYS.print_show_license, "1"],
    [SETTING_KEYS.pos_favorite_product_ids, "[]"],
    [SETTING_KEYS.pos_quick_categories, JSON.stringify(DEFAULT_QUICK_CATEGORIES)],
    [SETTING_KEYS.pos_quick_buttons, "[]"],
    [SETTING_KEYS.shift_variance_threshold, "50"],
    [SETTING_KEYS.default_opening_cash, "0"],
    [SETTING_KEYS.refund_telegram_manager_user_id, "0"],
    [SETTING_KEYS.expiry_alert_days, "7"],
    [SETTING_KEYS.expiry_alert_days_dairy, "3"],
    [SETTING_KEYS.expiry_dairy_categories, JSON.stringify(DEFAULT_DAIRY_CATEGORIES)],
    [SETTING_KEYS.pos_shortcut_hold_cart, ""],
    [SETTING_KEYS.pos_shortcut_suspended_carts, ""],
    [SETTING_KEYS.accountant_permissions, JSON.stringify(defaultAccountantPermissions())],
  ];
  for (const [key, value] of defaults) {
    const ex = await db.get("SELECT 1 AS x FROM app_settings WHERE key = ? LIMIT 1", [key]);
    if (!ex) {
      await db.run("INSERT INTO app_settings (key, value) VALUES (?, ?)", [key, value]);
    }
  }
}
