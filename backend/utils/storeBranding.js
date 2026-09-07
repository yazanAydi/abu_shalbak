import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const STORE_NAME_AR = "مخبز و سوبر ماركت الطيرة";
export const STORE_PHONE = "022980903";
export const STORE_LICENSE_LINE = "مشتغل مرخص 562536680";
export const STORE_LOGO_PATH = "/store-logo.png";

/**
 * Resolve store print fields from app settings, falling back to hardcoded defaults.
 * Address is hidden unless print_show_address is explicitly true.
 * @param {object} [settings]
 */
export function resolvePrintBranding(settings = {}) {
  const name = String(settings.store_name_ar || settings.store_name || "").trim() || STORE_NAME_AR;
  const phone = String(settings.store_phone || "").trim() || STORE_PHONE;
  const address = String(settings.store_address || "").trim();
  const license = String(settings.store_license || "").trim() || STORE_LICENSE_LINE;
  return {
    name,
    phone,
    address,
    license,
    showLogo: settings.print_show_logo !== false,
    showName: settings.print_show_name !== false,
    showPhone: settings.print_show_phone !== false,
    showAddress: settings.print_show_address === true,
    showLicense: settings.print_show_license !== false && settings.includeLicense !== false,
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let cachedLogoDataUri = null;
let cachedLogoDataUriAttempted = false;

/** Inline logo for HTML served via blob: URLs (refund receipts). */
export function getStoreLogoDataUri() {
  if (cachedLogoDataUriAttempted) return cachedLogoDataUri;
  cachedLogoDataUriAttempted = true;
  try {
    const logoPath = path.join(__dirname, "../assets/store-logo.png");
    const buf = fs.readFileSync(logoPath);
    cachedLogoDataUri = `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    cachedLogoDataUri = "";
  }
  return cachedLogoDataUri;
}
