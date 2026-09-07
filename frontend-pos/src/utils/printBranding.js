import {
  resolveStoreLogoUrl,
  STORE_LICENSE_LINE,
  STORE_NAME_AR,
  STORE_PHONE,
} from "./storeBranding";

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

export const PRINT_BRANDING_CSS = `
  html {
    -webkit-locale: "en";
    font-language-override: "eng";
    font-feature-settings: "locl" 0;
  }
  .print-branding {
    text-align: center;
    margin: 0 0 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid #ddd;
  }
  .print-branding__logo {
    display: block;
    margin: 0 auto 8px;
    max-width: 140px;
    max-height: 90px;
    object-fit: contain;
  }
  .print-branding__name {
    font-weight: 700;
    font-size: 16px;
    margin: 0 0 2px;
  }
  .print-branding__phone,
  .print-branding__address,
  .print-branding__license {
    margin: 0;
    font-size: 12px;
    color: #444;
  }
`;

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

/**
 * Centered store branding block for HTML print windows.
 * @param {object} [store] settings from GET /api/settings (also accepts legacy { includeLicense, logoUrl })
 */
export function buildPrintBrandingHtml(store = {}) {
  const branding = resolvePrintBranding(store);
  const logoUrl = store.logoUrl || store.receipt_logo_url;
  const src = branding.showLogo ? resolveStoreLogoUrl(logoUrl) : "";
  const logoHtml = src
    ? `<img class="print-branding__logo" src="${escapeHtml(src)}" alt="" />`
    : "";
  const nameHtml = branding.showName
    ? `<p class="print-branding__name">${escapeHtml(branding.name)}</p>`
    : "";
  const phoneHtml = branding.showPhone
    ? `<p class="print-branding__phone">${escapeHtml(branding.phone)}</p>`
    : "";
  const addressHtml =
    branding.showAddress && branding.address
      ? `<p class="print-branding__address">${escapeHtml(branding.address)}</p>`
      : "";
  const licenseHtml = branding.showLicense
    ? `<p class="print-branding__license">${escapeHtml(branding.license)}</p>`
    : "";
  return `<div class="print-branding">
    ${logoHtml}
    ${nameHtml}
    ${phoneHtml}
    ${addressHtml}
    ${licenseHtml}
  </div>`;
}

export { resolveStoreLogoUrl, STORE_LICENSE_LINE, STORE_NAME_AR, STORE_PHONE };
