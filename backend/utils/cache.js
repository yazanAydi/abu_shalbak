/**
 * Process-local cache with explicit invalidation.
 * Use for rarely-changing reference data (settings, currencies, catalogs).
 */

const store = new Map();

export const CACHE_KEYS = {
  SETTINGS: "settings",
  CURRENCIES_ALL: "currencies:all",
  CURRENCIES_ENABLED: "currencies:enabled",
  CATEGORIES_ALL: "categories:all",
  CATEGORIES_ACTIVE: "categories:active",
  UNIT_NAMES_ALL: "unit_names:all",
  UNIT_NAMES_ACTIVE: "unit_names:active",
  PROMOTIONS: "promotions",
  user(id) {
    return `user:${id}`;
  },
};

/**
 * @param {string} key
 * @returns {unknown}
 */
export function cacheGet(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

/**
 * @param {string} key
 * @param {unknown} value
 * @param {number} [ttlMs] 0 / omitted = until explicit invalidation
 */
export function cacheSet(key, value, ttlMs = 0) {
  store.set(key, {
    value,
    expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0,
  });
  return value;
}

/**
 * @param {...string} keys
 */
export function cacheInvalidate(...keys) {
  if (!keys.length) {
    store.clear();
    return;
  }
  for (const key of keys) store.delete(key);
}

/**
 * @param {string} prefix
 */
export function cacheInvalidatePrefix(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

export function cacheClone(value) {
  if (value == null || typeof value !== "object") return value;
  return structuredClone(value);
}
