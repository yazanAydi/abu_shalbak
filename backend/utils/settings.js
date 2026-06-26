export const OTHER_QUICK_CATEGORY = "أخرى";
export const DEFAULT_QUICK_CATEGORIES = ["معجنات", "بيتزا", OTHER_QUICK_CATEGORY];

export const SETTING_KEYS = {
  default_tax_rate: "default_tax_rate",
  tax_inclusive: "tax_inclusive",
  business_day_cutoff_hour: "business_day_cutoff_hour",
  receipt_show_tax: "receipt_show_tax",
  receipt_show_cashier: "receipt_show_cashier",
  receipt_logo_url: "receipt_logo_url",
  pos_favorite_product_ids: "pos_favorite_product_ids",
  pos_quick_categories: "pos_quick_categories",
  pos_quick_buttons: "pos_quick_buttons",
  shift_variance_threshold: "shift_variance_threshold",
  default_opening_cash: "default_opening_cash",
  refund_telegram_manager_user_id: "refund_telegram_manager_user_id",
  expiry_alert_days: "expiry_alert_days",
  pos_shortcut_hold_cart: "pos_shortcut_hold_cart",
  pos_shortcut_suspended_carts: "pos_shortcut_suspended_carts",
};

const MAX_POS_FAVORITES = 24;
const MAX_QUICK_CATEGORIES = 20;
const MAX_POS_QUICK_BUTTONS = 48;

const DEFAULTS = {
  [SETTING_KEYS.default_tax_rate]: 0.16,
  [SETTING_KEYS.tax_inclusive]: true,
  [SETTING_KEYS.business_day_cutoff_hour]: 0,
  [SETTING_KEYS.receipt_show_tax]: true,
  [SETTING_KEYS.receipt_show_cashier]: true,
  [SETTING_KEYS.receipt_logo_url]: "",
  [SETTING_KEYS.pos_favorite_product_ids]: [],
  [SETTING_KEYS.pos_quick_categories]: [...DEFAULT_QUICK_CATEGORIES],
  [SETTING_KEYS.pos_quick_buttons]: [],
  [SETTING_KEYS.shift_variance_threshold]: 50,
  [SETTING_KEYS.default_opening_cash]: 0,
  [SETTING_KEYS.refund_telegram_manager_user_id]: 0,
  [SETTING_KEYS.expiry_alert_days]: 7,
  [SETTING_KEYS.pos_shortcut_hold_cart]: "",
  [SETTING_KEYS.pos_shortcut_suspended_carts]: "",
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
    case SETTING_KEYS.expiry_alert_days: {
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULTS[key];
    }
    default:
      if (key === SETTING_KEYS.pos_shortcut_hold_cart || key === SETTING_KEYS.pos_shortcut_suspended_carts) {
        return String(raw ?? "");
      }
      return String(raw);
  }
}

export async function getAppSettings(db) {
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
    pos_shortcut_hold_cart: parseValue(
      SETTING_KEYS.pos_shortcut_hold_cart,
      map[SETTING_KEYS.pos_shortcut_hold_cart]
    ),
    pos_shortcut_suspended_carts: parseValue(
      SETTING_KEYS.pos_shortcut_suspended_carts,
      map[SETTING_KEYS.pos_shortcut_suspended_carts]
    ),
  };
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
    [SETTING_KEYS.receipt_logo_url]: (v) => String(v ?? ""),
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
    [SETTING_KEYS.pos_shortcut_hold_cart]: (v) => String(v ?? "").trim().slice(0, 40),
    [SETTING_KEYS.pos_shortcut_suspended_carts]: (v) => String(v ?? "").trim().slice(0, 40),
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
    [SETTING_KEYS.pos_favorite_product_ids, "[]"],
    [SETTING_KEYS.pos_quick_categories, JSON.stringify(DEFAULT_QUICK_CATEGORIES)],
    [SETTING_KEYS.pos_quick_buttons, "[]"],
    [SETTING_KEYS.shift_variance_threshold, "50"],
    [SETTING_KEYS.default_opening_cash, "0"],
    [SETTING_KEYS.refund_telegram_manager_user_id, "0"],
    [SETTING_KEYS.expiry_alert_days, "7"],
    [SETTING_KEYS.pos_shortcut_hold_cart, ""],
    [SETTING_KEYS.pos_shortcut_suspended_carts, ""],
  ];
  for (const [key, value] of defaults) {
    const ex = await db.get("SELECT 1 AS x FROM app_settings WHERE key = ? LIMIT 1", [key]);
    if (!ex) {
      await db.run("INSERT INTO app_settings (key, value) VALUES (?, ?)", [key, value]);
    }
  }
}
