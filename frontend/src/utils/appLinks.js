/** URL of the POS app (cashier terminal). */
export function getPosUrl() {
  const env = process.env.REACT_APP_POS_URL;
  if (env != null && String(env).trim() !== "") {
    return String(env).trim().replace(/\/$/, "");
  }
  if (process.env.NODE_ENV === "development") {
    return "http://127.0.0.1:3002";
  }
  return `${window.location.origin}/pos`;
}

/** POS login URL — always requires credentials (clears any stale session). */
export function getPosLoginUrl() {
  return `${getPosUrl()}/login?signin=1`;
}

/** True when this role should use the POS app, not the admin panel. */
export function isPosOnlyRole(role) {
  return (
    role === "cashier" ||
    role === "shelves_employee" ||
    role === "bakery_employee"
  );
}

export function redirectToPos() {
  window.location.href = getPosLoginUrl();
}
