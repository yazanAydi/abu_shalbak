// /admin and /pos are the same origin in production, so localStorage is shared.
// Each portal keeps its own session. A leftover shared "token" is adopted only
// when the JWT role belongs to this app, then the shared keys are removed.
const TOKEN_KEY = "office.token";
const USER_KEY = "office.user";
const LEGACY_TOKEN_KEY = "token";
const LEGACY_USER_KEY = "user";

/** @type {Set<(user: object|null) => void>} */
const userListeners = new Set();

function notifyUser(user) {
  for (const fn of userListeners) {
    try {
      fn(user);
    } catch {
      /* ignore subscriber errors */
    }
  }
}

function decodeJwtRole(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
    const payload = JSON.parse(atob(padded));
    return typeof payload?.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

function roleBelongsHere(role) {
  return role === "admin" || role === "accountant";
}

function readLegacyUserForRole(role) {
  try {
    const raw = localStorage.getItem(LEGACY_USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.role === role ? raw : null;
  } catch {
    return null;
  }
}

/** Drop a leftover shared session only when it belongs to the office. */
function dropOwnedLegacy() {
  try {
    const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
    if (!legacy || !roleBelongsHere(decodeJwtRole(legacy))) return;
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    localStorage.removeItem(LEGACY_USER_KEY);
  } catch {
    /* ignore storage failures */
  }
}

/**
 * Move a pre-split office session into office.token / office.user.
 * Cashier (and any other) leftovers stay in the shared keys for POS.
 * @returns {string|null}
 */
function adoptLegacyToken() {
  try {
    const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
    if (!legacy) return null;
    const role = decodeJwtRole(legacy);
    if (!roleBelongsHere(role)) return null;
    localStorage.setItem(TOKEN_KEY, legacy);
    if (!localStorage.getItem(USER_KEY)) {
      const legacyUser = readLegacyUserForRole(role);
      if (legacyUser) localStorage.setItem(USER_KEY, legacyUser);
    }
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    localStorage.removeItem(LEGACY_USER_KEY);
    return legacy;
  } catch {
    return null;
  }
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || adoptLegacyToken();
  } catch {
    return null;
  }
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
  dropOwnedLegacy();
}

export function setUser(user) {
  const next = user ? JSON.stringify(user) : null;
  const prev = localStorage.getItem(USER_KEY);
  if (next) localStorage.setItem(USER_KEY, next);
  else localStorage.removeItem(USER_KEY);
  // Only wake subscribers when the payload actually changed, so periodic
  // /auth/me refreshes do not re-render the whole office shell.
  if (prev !== next) notifyUser(user ?? null);
}

export function getUser() {
  try {
    if (!localStorage.getItem(USER_KEY)) adoptLegacyToken();
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function subscribeUser(listener) {
  userListeners.add(listener);
  return () => userListeners.delete(listener);
}

export function removeToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  dropOwnedLegacy();
  notifyUser(null);
}

export function isAuthenticated() {
  return Boolean(getToken());
}

export function getAuthHeaders() {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}
