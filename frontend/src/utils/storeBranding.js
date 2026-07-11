import bundledStoreLogo from "../assets/store-logo.png";

export const STORE_NAME_AR = "مخبز و سوبر ماركت الطيرة";
export const STORE_PHONE = "022980903";
export const STORE_LICENSE_LINE = "مشتغل مرخص 562536680";
export const STORE_LOGO_PATH = `${process.env.PUBLIC_URL || ""}/store-logo.png`.replace(/\/{2,}/g, "/");
export const STORE_LOGO_URL = bundledStoreLogo;

function inferPublicBase() {
  const envBase = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
  if (envBase) return envBase;
  if (typeof window === "undefined") return "";
  const { pathname } = window.location;
  if (pathname.startsWith("/admin")) return "/admin";
  if (pathname.startsWith("/pos")) return "/pos";
  return "";
}

/**
 * Resolve a logo path for print windows (about:blank needs absolute URLs).
 * @param {string} [logoUrl]
 */
export function resolveStoreLogoUrl(logoUrl) {
  const trimmed = logoUrl?.trim();
  const configured = trimmed || STORE_LOGO_URL || `${inferPublicBase()}/store-logo.png`;
  if (!configured) return "";
  if (/^https?:\/\//i.test(configured) || configured.startsWith("data:")) {
    return configured;
  }
  if (typeof window !== "undefined" && window.location?.origin) {
    const path = configured.startsWith("/") ? configured : `/${configured}`;
    return `${window.location.origin}${path}`;
  }
  return configured;
}
