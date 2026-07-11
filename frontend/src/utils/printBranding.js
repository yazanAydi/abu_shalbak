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
  .print-branding__license {
    margin: 0;
    font-size: 12px;
    color: #444;
  }
`;

/**
 * Centered store branding block for HTML print windows.
 * @param {{ includeLicense?: boolean, logoUrl?: string }} [opts]
 */
export function buildPrintBrandingHtml({ includeLicense = true, logoUrl } = {}) {
  const src = resolveStoreLogoUrl(logoUrl);
  const logoHtml = src
    ? `<img class="print-branding__logo" src="${escapeHtml(src)}" alt="" />`
    : "";
  const licenseLine = includeLicense
    ? `<p class="print-branding__license">${escapeHtml(STORE_LICENSE_LINE)}</p>`
    : "";
  return `<div class="print-branding">
    ${logoHtml}
    <p class="print-branding__name">${escapeHtml(STORE_NAME_AR)}</p>
    <p class="print-branding__phone">${escapeHtml(STORE_PHONE)}</p>
    ${licenseLine}
  </div>`;
}

export { resolveStoreLogoUrl, STORE_LICENSE_LINE, STORE_NAME_AR, STORE_PHONE };
