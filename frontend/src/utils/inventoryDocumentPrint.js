import { buildPrintBrandingHtml, buildPrintedByHtml, A4_PRINT_SHEET_CSS, PRINT_BRANDING_CSS, STORE_NAME_AR } from "./printBranding";
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
 * HTML for a goods-in / goods-out inventory document print window.
 * @param {object} doc
 * @param {object} [store]
 */
export function buildInventoryDocumentPrintHtml(doc, store = {}) {
  const isIssue = doc.document_type === "issue";
  const title = isIssue ? "سند إخراج بضاعة" : "سند إدخال بضاعة";
  const docNo = doc.document_number ?? doc.id;
  const storeName = store.store_name_ar || store.store_name || STORE_NAME_AR;
  const items = doc.items || [];
  const reason = doc.reason_label || doc.reason || "—";

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

  return `<!DOCTYPE html>
<html lang="ar-u-nu-latn" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)} #${escapeHtml(docNo)}</title>
  <style>
    @page { size: A4; }
    ${A4_PRINT_SHEET_CSS}
    ${PRINT_BRANDING_CSS}
    th { background: #1f3a5f; color: #fff; }
  </style>
</head>
<body>
  ${buildPrintBrandingHtml(store)}
  <h1>${escapeHtml(title)} رقم: ${escapeHtml(docNo)}</h1>
  <div class="meta">
    <div><strong>التاريخ:</strong> ${escapeHtml(dateOnly(doc.document_date))}</div>
    <div><strong>السبب:</strong> ${escapeHtml(reason)}</div>
    <div><strong>أنشأه:</strong> ${escapeHtml(doc.created_by_name || "—")}</div>
    <div><strong>الحالة:</strong> مكتمل</div>
    <div><strong>تاريخ الطباعة:</strong> <span class="when">${escapeHtml(formatTimestamp())}</span></div>
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
  ${buildPrintedByHtml()}
  ${doc.notes ? `<div class="notes"><strong>ملاحظات:</strong> ${escapeHtml(doc.notes)}</div>` : ""}
  <p class="footer">${escapeHtml(storeName)} — ${escapeHtml(title)}</p>
</body>
</html>`;
}

/**
 * Browser print window for a goods-in / goods-out inventory document.
 * @param {object} doc
 * @param {object} [store]
 */
export function printInventoryDocument(doc, store = {}) {
  if (!doc) return;
  const w = window.open("", "_blank", "width=900,height=840");
  if (!w) {
    window.alert("اسمح بفتح النافذة المنبثقة للطباعة.");
    return;
  }
  w.document.write(buildInventoryDocumentPrintHtml(doc, store));
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
