const TOKEN_KEY = "token";
const USER_KEY = "user";

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

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
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
  notifyUser(null);
}

export function isAuthenticated() {
  return Boolean(getToken());
}

export function getAuthHeaders() {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}
