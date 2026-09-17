import { getStoreLogoDataUri, resolvePrintBranding } from "./storeBranding.js";
import { documentTypeTitleAr, reasonLabelAr } from "./inventoryDocumentReasons.js";

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtQty(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return String(Math.round(x * 1000) / 1000);
}

/**
 * Server-side HTML for goods-in / goods-out print (not a sale receipt).
 * @param {object} doc
 * @param {object} [store]
 */
export function buildInventoryDocumentPrintHtml(doc, store = {}, extras = {}) {
  const title = documentTypeTitleAr(doc.document_type);
  const docNo = doc.document_number ?? doc.id;
  const branding = resolvePrintBranding(store);
  const storeName = branding.name;
  const reason = doc.reason_label || reasonLabelAr(doc.document_type, doc.reason);
  const items = Array.isArray(doc.items) ? doc.items : [];
  const logo = branding.showLogo ? getStoreLogoDataUri() : "";
  const brandingLines = [
    logo ? `<img src="${logo}" alt="" />` : "",
    branding.showName ? `<div><strong>${escapeHtml(branding.name)}</strong></div>` : "",
    branding.showPhone ? `<div>${escapeHtml(branding.phone)}</div>` : "",
    branding.showAddress && branding.address ? `<div>${escapeHtml(branding.address)}</div>` : "",
    branding.showLicense ? `<div>${escapeHtml(branding.license)}</div>` : "",
  ].filter(Boolean).join("\n    ");

  const bodyRows = items
    .map((it, i) => {
      const unitName = it.unit_name || it.unit_name_snapshot || "";
      return `<tr>
        <td class="num">${i + 1}</td>
        <td>${escapeHtml(it.product_name || it.product_name_snapshot || "")}</td>
        <td>${escapeHtml(it.sku || it.sku_snapshot || "—")}</td>
        <td>${escapeHtml(it.barcode || it.barcode_snapshot || "—")}</td>
        <td>${escapeHtml(unitName || "—")}</td>
        <td class="num">${escapeHtml(fmtQty(it.quantity))}</td>
        <td class="num">${escapeHtml(fmtQty(it.conversion_used ?? it.conversion_to_base))}</td>
        <td class="num">${escapeHtml(fmtQty(it.base_quantity))}</td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="ar-u-nu-latn" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)} #${escapeHtml(docNo)}</title>
  <style>
    html {
      -webkit-locale: "en";
      font-language-override: "eng";
      font-feature-settings: "locl" 0;
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }
    @page { size: A4; margin: 9mm; }
    html, body { height: auto; min-height: 0; }
    body {
      font-family: "Segoe UI", Tahoma, Arial, sans-serif;
      font-size: 10.5pt;
      line-height: 1.25;
      color: #111;
      margin: 0;
      padding: 0;
    }
    p { margin: 0; }
    h1 { text-align: center; margin: 4px 0 3px; font-size: 13.5pt; font-weight: 700; line-height: 1.2; }
    .print-branding { text-align: center; margin: 0 0 4px; padding-bottom: 4px; border-bottom: 1px solid #ddd; }
    .print-branding img { display: block; margin: 0 auto 2px; max-width: 96px; max-height: 58px; object-fit: contain; }
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
    table { width: 100%; border-collapse: collapse; margin-top: 4px; page-break-inside: auto; }
    th, td { border: 1px solid #999; padding: 2px 4px; text-align: right; vertical-align: top; line-height: 1.25; font-size: 10.5pt; }
    th { background: #1f3a5f; color: #fff; font-weight: 600; font-size: 9.5pt; }
    td.num, th.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .notes { margin-top: 6px; font-size: 10.5pt; }
    .printed-by { margin: 8px 0 0; font-size: 10.5pt; text-align: start; }
    .footer { margin: 6px 0 0; font-size: 8.5pt; color: #666; text-align: center; }
    @media print {
      thead { display: table-header-group; }
      tbody tr { page-break-inside: avoid; break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="print-branding">
    ${brandingLines}
  </div>
  <h1>${escapeHtml(title)} رقم: ${escapeHtml(docNo)}</h1>
  <div class="meta">
    <div><strong>التاريخ:</strong> ${escapeHtml(doc.document_date || "")}</div>
    <div><strong>السبب:</strong> ${escapeHtml(reason)}</div>
    <div><strong>أنشأه:</strong> ${escapeHtml(doc.created_by_name || "—")}</div>
    <div><strong>الحالة:</strong> مكتمل</div>
  </div>
  <table>
    <thead>
      <tr>
        <th class="num">#</th>
        <th>المنتج</th>
        <th>الرقم</th>
        <th>الباركود</th>
        <th>الوحدة</th>
        <th class="num">الكمية</th>
        <th class="num">التحويل</th>
        <th class="num">الكمية الأساسية</th>
      </tr>
    </thead>
    <tbody>${bodyRows || `<tr><td colspan="8" style="text-align:center">لا توجد أصناف</td></tr>`}</tbody>
  </table>
  ${extras.printedBy ? `<p class="printed-by"><strong>طُبع بواسطة:</strong> ${escapeHtml(extras.printedBy)}</p>` : ""}
  ${doc.notes ? `<div class="notes"><strong>ملاحظات:</strong> ${escapeHtml(doc.notes)}</div>` : ""}
  <p class="footer">${escapeHtml(storeName)} — ${escapeHtml(title)}</p>
</body>
</html>`;
}
