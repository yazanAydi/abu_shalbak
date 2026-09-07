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
    html { -webkit-locale: "en"; font-language-override: "eng"; font-feature-settings: "locl" 0; }
    @page { size: A4; margin: 12mm; }
    body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; font-size: 12px; color: #111; margin: 0; padding: 12px; }
    h1 { text-align: center; margin: 6px 0 10px; font-size: 18px; }
    .print-branding { text-align: center; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 1px solid #ddd; }
    .print-branding img { display: block; margin: 0 auto 8px; max-width: 140px; max-height: 90px; }
    .meta { display: flex; flex-wrap: wrap; gap: 6px 24px; margin: 8px 0 12px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border: 1px solid #999; padding: 6px 8px; text-align: right; vertical-align: top; }
    th { background: #1f3a5f; color: #fff; }
    td.num, th.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .notes { margin-top: 12px; font-size: 12px; }
    .printed-by { margin: 14px 0 0; font-size: 12px; text-align: start; }
    .footer { margin-top: 16px; font-size: 10px; color: #666; text-align: center; }
    @media print { thead { display: table-header-group; } tr { page-break-inside: avoid; } }
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
