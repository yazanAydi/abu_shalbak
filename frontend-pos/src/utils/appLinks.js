/** URL of this POS app. */
export function getPosUrl() {
  const env = process.env.REACT_APP_POS_URL;
  if (env != null && String(env).trim() !== "") {
    return String(env).trim().replace(/\/$/, "");
  }
  if (process.env.NODE_ENV === "development") {
    return "http://127.0.0.1:3002";
  }
  return typeof window !== "undefined" ? `${window.location.origin}/pos` : "";
}

/** POS login URL — always requires credentials (clears any stale session). */
export function getPosLoginUrl() {
  return `${getPosUrl()}/login?signin=1`;
}

/** URL of the admin (office) app. */
export function getAdminUrl() {
  const env = process.env.REACT_APP_ADMIN_URL;
  if (env != null && String(env).trim() !== "") {
    return String(env).trim().replace(/\/$/, "");
  }
  if (process.env.NODE_ENV === "development") {
    return "http://127.0.0.1:3001";
  }
  return typeof window !== "undefined" ? `${window.location.origin}/admin` : "";
}

/** Admin login URL — always requires credentials (clears any stale session). */
export function getAdminLoginUrl() {
  return `${getAdminUrl()}/login?signin=1`;
}

/** Roles that belong on the admin app, not POS. */
export function isOfficeOnlyRole(role) {
  return role === "admin" || role === "accountant";
}

export function redirectToAdmin() {
  window.location.href = getAdminLoginUrl();
}
