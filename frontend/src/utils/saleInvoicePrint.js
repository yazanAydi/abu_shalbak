import { buildPrintBrandingHtml, buildPartyBalanceHtml, buildPrintedByHtml, A4_PRINT_SHEET_CSS, PRINT_BRANDING_CSS, STORE_NAME_AR } from "./printBranding";
import { printDocumentWhenReady } from "./printDocument";
import { formatDiscountPercent } from "./saleInvoiceTotals";
import { dateOnly, formatDateTimeShopAr } from "./format";

const STATUS_LABEL = { draft: "مسودة", posted: "مرحّلة" };

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

function money(n) {
  return Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function qty(n) {
  const v = Number(n || 0);
  return Number.isInteger(v) ? String(v) : v.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function formatTimestamp(value) {
  return formatDateTimeShopAr(value || new Date());
}

/**
 * @param {object} doc full sales invoice with items[]
 * @param {object} [store]
 */
export function buildSalesInvoicePrintHtml(doc, store = {}) {
  const items = doc.items || [];
  const docNo = doc.invoice_no ?? doc.id;
  const docDate = dateOnly(doc.invoice_date);
  const total = Number(doc.total) || 0;
  const storeName = store.store_name_ar || store.store_name || STORE_NAME_AR;

  const listGrossTotal = items.reduce((s, it) => s + (Number(it.total_price) || 0), 0);
  const afterDiscount = total;
  const discountSaved = Math.round((listGrossTotal - afterDiscount) * 100) / 100;
  const effectiveDiscountPct = listGrossTotal > 0
    ? Math.round((discountSaved / listGrossTotal) * 10000) / 100
    : 0;
  const hasDiscount = discountSaved > 0.005;

  const bodyRows = items
    .map(
      (it, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td>${escapeHtml(it.name || "")}</td>
        <td>${escapeHtml(it.barcode || "—")}</td>
        <td>${escapeHtml(it.unit_name || "—")}</td>
        <td class="num">${qty(it.quantity)}</td>
        <td class="num">${qty(it.bonus_quantity || 0)}</td>
        <td class="num">${money(it.unit_price)}</td>
        <td class="num">${it.discount_pct ? `${it.discount_pct}%` : "—"}</td>
        <td class="num">${money(it.line_total)}</td>
      </tr>`
    )
    .join("");

  const totalsRows = [
    `<tr><td>المجموع</td><td class="num">${money(listGrossTotal)}</td></tr>`,
    ...(hasDiscount
      ? [
          `<tr><td>الخصم ${formatDiscountPercent(effectiveDiscountPct)}%</td><td class="num">${money(discountSaved)}</td></tr>`,
          `<tr><td>بعد الخصم</td><td class="num">${money(afterDiscount)}</td></tr>`,
        ]
      : []),
    `<tr class="grand"><td>الصافي</td><td class="num">${money(afterDiscount)}</td></tr>`,
  ].join("");

  return `<!DOCTYPE html>
<html lang="ar-u-nu-latn" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>فتورة مبيعات #${escapeHtml(docNo)}</title>
  <style>
    @page { size: A4; }
    ${A4_PRINT_SHEET_CSS}
    ${PRINT_BRANDING_CSS}
    th { background: #1f3a5f; color: #fff; }
  </style>
</head>
<body>
  ${buildPrintBrandingHtml(store)}
  <h1>فتورة مبيعات #${escapeHtml(docNo)}</h1>
  <div class="meta">
    <div><strong>العميل:</strong> ${escapeHtml(doc.customer_name || "")}</div>
    <div><strong>التاريخ:</strong> ${escapeHtml(docDate)}</div>
    <div><strong>الحالة:</strong> ${escapeHtml(STATUS_LABEL[doc.status] || doc.status || "—")}</div>
    ${doc.ref_text ? `<div><strong>المرجع:</strong> ${escapeHtml(doc.ref_text)}</div>` : ""}
    <div><strong>تاريخ الطباعة:</strong> <span class="when">${escapeHtml(formatTimestamp())}</span></div>
  </div>
  <table>
    <thead>
      <tr>
        <th class="num">#</th><th>الصنف</th><th>الباركود</th><th>الوحدة</th><th class="num">الكمية</th><th class="num">بونص</th><th class="num">سعر الوحدة</th><th class="num">خصم</th><th class="num">الإجمالي</th>
      </tr>
    </thead>
    <tbody>${bodyRows || `<tr><td colspan="9" style="text-align:center">لا توجد أصناف</td></tr>`}</tbody>
  </table>
  <div class="totals-wrap"><table class="totals">${totalsRows}</table></div>
  ${buildPartyBalanceHtml(doc.party_balance)}
  ${buildPrintedByHtml()}
  ${doc.notes ? `<div class="notes"><strong>ملاحظات:</strong> ${escapeHtml(doc.notes)}</div>` : ""}
  <p class="footer">${escapeHtml(storeName)} — فتورة مبيعات</p>
</body>
</html>`;
}

/**
 * @param {object} doc full sales invoice with items[]
 * @param {object} [store]
 */
export function printSalesInvoiceDoc(doc, store = {}) {
  if (!doc) return;
  const w = window.open("", "_blank", "width=900,height=840");
  if (!w) {
    window.alert("اسمح بفتح النافذة المنبثقة للطباعة.");
    return;
  }
  w.document.write(buildSalesInvoicePrintHtml(doc, store));
  w.document.close();
  printDocumentWhenReady(w.document);
}
