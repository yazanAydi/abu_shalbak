import { buildPrintBrandingHtml, PRINT_BRANDING_CSS, STORE_NAME_AR } from "./printBranding";
import { printDocumentWhenReady } from "./printDocument";
import { dateOnly, formatDateTimeShopAr, qty as fmtQty } from "./format";

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

function formatTimestamp(value) {
  return formatDateTimeShopAr(value || new Date());
}

/**
 * Browser print window for a goods-in / goods-out inventory document.
 * @param {object} doc
 * @param {object} [store]
 */
export function printInventoryDocument(doc, store = {}) {
  if (!doc) return;
  const isIssue = doc.document_type === "issue";
  const title = isIssue ? "سند إخراج بضاعة" : "سند إدخال بضاعة";
  const docNo = doc.document_number ?? doc.id;
  const storeName = store.store_name_ar || store.store_name || STORE_NAME_AR;
  const items = doc.items || [];
  const reason = doc.reason_label || doc.reason || "—";

  const w = window.open("", "_blank", "width=900,height=840");
  if (!w) {
    window.alert("اسمح بفتح النافذة المنبثقة للطباعة.");
    return;
  }

  const bodyRows = items
    .map(
      (it, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td>${escapeHtml(it.product_name || it.product_name_snapshot || "")}</td>
        <td>${escapeHtml(it.sku || it.sku_snapshot || "—")}</td>
        <td>${escapeHtml(it.barcode || it.barcode_snapshot || "—")}</td>
        <td>${escapeHtml(it.unit_name || it.unit_name_snapshot || "—")}</td>
        <td class="num">${escapeHtml(fmtQty(it.quantity))}</td>
        <td class="num">${escapeHtml(fmtQty(it.base_quantity != null ? it.base_quantity : it.quantity))} ${escapeHtml(it.unit_name || "")}</td>
      </tr>`
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="ar-u-nu-latn" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)} #${escapeHtml(docNo)}</title>
  <style>
    @page { size: A4; margin: 12mm; }
    body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; font-size: 12px; color: #111; margin: 0; padding: 12px; }
    h1 { text-align: center; margin: 6px 0 10px; font-size: 18px; }
    .meta { display: flex; flex-wrap: wrap; gap: 6px 24px; margin: 8px 0 12px; }
    .meta div { font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border: 1px solid #999; padding: 6px 8px; text-align: right; vertical-align: top; }
    th { background: #1f3a5f; color: #fff; }
    td.num, th.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .notes { margin-top: 12px; font-size: 12px; }
    .footer { margin-top: 16px; font-size: 10px; color: #666; text-align: center; }
    ${PRINT_BRANDING_CSS}
    @media print { thead { display: table-header-group; } tr { page-break-inside: avoid; } }
  </style>
</head>
<body>
  ${buildPrintBrandingHtml()}
  <h1>${escapeHtml(title)} رقم: ${escapeHtml(docNo)}</h1>
  <div class="meta">
    <div><strong>التاريخ:</strong> ${escapeHtml(dateOnly(doc.document_date))}</div>
    <div><strong>السبب:</strong> ${escapeHtml(reason)}</div>
    <div><strong>أنشأه:</strong> ${escapeHtml(doc.created_by_name || "—")}</div>
    <div><strong>الحالة:</strong> مكتمل</div>
    <div><strong>تاريخ الطباعة:</strong> ${escapeHtml(formatTimestamp())}</div>
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
        <th class="num">الكمية الأساسية</th>
      </tr>
    </thead>
    <tbody>${bodyRows || `<tr><td colspan="7" style="text-align:center">لا توجد أصناف</td></tr>`}</tbody>
  </table>
  ${doc.notes ? `<div class="notes"><strong>ملاحظات:</strong> ${escapeHtml(doc.notes)}</div>` : ""}
  <p class="footer">${escapeHtml(storeName)} — ${escapeHtml(title)}</p>
</body>
</html>`;

  w.document.write(html);
  w.document.close();
  printDocumentWhenReady(w.document);
}

/** Open a print window from server-rendered HTML (GET .../print). */
export function printInventoryDocumentHtml(html) {
  if (!html) return;
  const w = window.open("", "_blank", "width=900,height=840");
  if (!w) {
    window.alert("اسمح بفتح النافذة المنبثقة للطباعة.");
    return;
  }
  w.document.write(html);
  w.document.close();
  printDocumentWhenReady(w.document);
}
