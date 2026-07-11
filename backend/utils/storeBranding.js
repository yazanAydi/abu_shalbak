import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const STORE_NAME_AR = "مخبز و سوبر ماركت الطيرة";
export const STORE_PHONE = "022980903";
export const STORE_LICENSE_LINE = "مشتغل مرخص 562536680";
export const STORE_LOGO_PATH = "/store-logo.png";

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
