import {
  resolveStoreLogoUrl,
  STORE_LICENSE_LINE,
  STORE_NAME_AR,
  STORE_PHONE,
} from "./storeBranding";
import { getUser } from "./auth";

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
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
  .print-branding {
    text-align: center;
    margin: 0 0 4px;
    padding-bottom: 4px;
    border-bottom: 1px solid #ddd;
  }
  .print-branding__logo {
    display: block;
    margin: 0 auto 2px;
    max-width: 96px;
    max-height: 58px;
    object-fit: contain;
  }
  .print-branding__name {
    font-weight: 700;
    font-size: 12pt;
    margin: 0;
    line-height: 1.2;
  }
  .print-branding__phone,
  .print-branding__address,
  .print-branding__license {
    margin: 0;
    font-size: 9pt;
    line-height: 1.2;
    color: #444;
  }
  .printed-by {
    margin: 8px 0 0;
    font-size: 10.5pt;
    text-align: start;
  }
  .party-balance {
    margin: 6px 0 0;
    font-size: 10.5pt;
    text-align: start;
  }
  .party-balance p {
    margin: 1px 0;
  }
`;

/** Shared A4 sheet chrome. Templates still set `@page { size: A4 }` or landscape. */
export const A4_PRINT_SHEET_CSS = `
  @page { margin: 9mm; }
  html, body { height: auto; min-height: 0; }
  body {
    font-family: "Segoe UI", Tahoma, Arial, sans-serif;
    font-size: 10.5pt;
    line-height: 1.25;
    color: #111;
    margin: 0;
    padding: 0;
    background: #fff;
  }
  @media screen {
    body { padding: 8px; }
  }
  p { margin: 0; }
  h1 {
    text-align: center;
    margin: 4px 0 3px;
    font-size: 13.5pt;
    font-weight: 700;
    line-height: 1.2;
  }
  h2, h2.section-title {
    margin: 8px 0 4px;
    font-size: 11.5pt;
    font-weight: 700;
    line-height: 1.2;
    border-bottom: 1px solid #ddd;
    padding-bottom: 2px;
  }
  .subtitle { margin: 0 0 4px; color: #444; font-size: 10.5pt; }
  .generated { margin: 0 0 6px; color: #666; font-size: 10pt; }
  .meta {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px 16px;
    margin: 0 0 6px;
    padding: 4px 8px;
    border: 1px solid #ddd;
    background: #f7f8fa;
    font-size: 10.5pt;
    line-height: 1.3;
  }
  .meta div, p.meta { font-size: 10.5pt; min-width: 0; }
  p.meta {
    display: block;
    border: none;
    background: transparent;
    padding: 0;
    margin: 1px 0;
  }
  .meta strong { margin-inline-end: 4px; }
  .meta .when { direction: ltr; unicode-bidi: isolate; white-space: nowrap; }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 4px;
    page-break-inside: auto;
    break-inside: auto;
  }
  th, td {
    border: 1px solid #999;
    padding: 2px 4px;
    text-align: right;
    vertical-align: top;
    line-height: 1.25;
    font-size: 10.5pt;
  }
  th {
    font-weight: 600;
    font-size: 9.5pt;
    line-height: 1.2;
    white-space: normal;
  }
  td.num, th.num { font-variant-numeric: tabular-nums; }
  td.num { white-space: nowrap; padding-inline: 4px; }
  .totals-wrap {
    margin-top: 4px;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .totals {
    width: 46%;
    margin: 0;
    margin-inline-start: auto;
    border-collapse: collapse;
  }
  .totals td { border: 1px solid #999; padding: 2px 6px; font-size: 10.5pt; }
  .totals .grand td { background: #eef2f7; font-weight: 700; font-size: 11pt; }
  .notes { margin-top: 6px; font-size: 10.5pt; }
  .signatures {
    margin-top: 28px;
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  .signatures div {
    width: 30%;
    border-top: 1px solid #333;
    padding-top: 4px;
    text-align: center;
    font-size: 10pt;
  }
  .footer {
    margin: 6px 0 0;
    font-size: 8.5pt;
    color: #666;
    text-align: center;
  }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 4px;
    margin: 0 0 8px;
  }
  .summary-item {
    border: 1px solid #ddd;
    border-radius: 4px;
    padding: 4px 6px;
    background: #fafafa;
  }
  .summary-label { display: block; color: #666; font-size: 9.5pt; margin-bottom: 1px; }
  .summary-value { display: block; font-weight: 600; font-size: 11pt; }
  @media print {
    thead { display: table-header-group; }
    tbody { display: table-row-group; }
    table { page-break-inside: auto; break-inside: auto; }
    tbody tr { page-break-inside: avoid; break-inside: avoid; }
    .totals-wrap, .totals { page-break-inside: avoid; break-inside: avoid; }
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

/**
 * "Printed by" line for the current logged-in office user.
 * @param {string} [name]
 */
export function buildPrintedByHtml(name) {
  const who = String(name || getUser()?.username || "").trim();
  if (!who) return "";
  return `<p class="printed-by"><strong>طُبع بواسطة:</strong> ${escapeHtml(who)}</p>`;
}

/**
 * Party balance before/after this document. Omit when the payload has no movement.
 * @param {object|null} [partyBalance]
 */
export function buildPartyBalanceHtml(partyBalance) {
  if (!partyBalance) return "";
  const before =
    partyBalance.before_display != null && String(partyBalance.before_display).trim() !== ""
      ? String(partyBalance.before_display)
      : partyBalance.before != null
        ? Number(partyBalance.before).toFixed(2)
        : "";
  const after =
    partyBalance.after_display != null && String(partyBalance.after_display).trim() !== ""
      ? String(partyBalance.after_display)
      : partyBalance.after != null
        ? Number(partyBalance.after).toFixed(2)
        : "";
  if (!before || !after) return "";
  return `<div class="party-balance">
    <p><strong>الرصيد قبل:</strong> ${escapeHtml(before)}</p>
    <p><strong>الرصيد بعد:</strong> ${escapeHtml(after)}</p>
  </div>`;
}

export { resolveStoreLogoUrl, STORE_LICENSE_LINE, STORE_NAME_AR, STORE_PHONE };
