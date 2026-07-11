import { buildPrintBrandingHtml, PRINT_BRANDING_CSS, STORE_NAME_AR } from "./printBranding";
import { printDocumentWhenReady } from "./printDocument";
import { formatDiscountPercent, formatTaxRatePercent } from "./saleInvoiceTotals";

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
  const d = value ? new Date(value) : new Date();
  return d.toLocaleString("ar-EG", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * @param {object} doc full sales invoice with items[]
 * @param {object} [store]
 */
export function printSalesInvoiceDoc(doc, store = {}) {
  if (!doc) return;
  const items = doc.items || [];
  const docNo = doc.invoice_no ?? doc.id;
  const docDate = doc.invoice_date ? String(doc.invoice_date).slice(0, 10) : "—";
  const total = Number(doc.total) || 0;
  const vat = doc.tax != null ? Number(doc.tax) : null;
  const vatPercent = formatTaxRatePercent(store.default_tax_rate);
  const storeName = store.store_name_ar || store.store_name || STORE_NAME_AR;

  const listGrossTotal = items.reduce((s, it) => s + (Number(it.total_price) || 0), 0);
  const afterDiscount = total;
  const discountSaved = Math.round((listGrossTotal - afterDiscount) * 100) / 100;
  const effectiveDiscountPct = listGrossTotal > 0
    ? Math.round((discountSaved / listGrossTotal) * 10000) / 100
    : 0;
  const hasDiscount = discountSaved > 0.005;

  const w = window.open("", "_blank", "width=900,height=840");
  if (!w) {
    window.alert("اسمح بفتح النافذة المنبثقة للطباعة.");
    return;
  }

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
    `<tr><td>المجموع (يشمل ض.ق.م)</td><td class="num">${money(listGrossTotal)}</td></tr>`,
    ...(hasDiscount
      ? [
          `<tr><td>الخصم ${formatDiscountPercent(effectiveDiscountPct)}%</td><td class="num">${money(discountSaved)}</td></tr>`,
          `<tr><td>بعد الخصم</td><td class="num">${money(afterDiscount)}</td></tr>`,
        ]
      : []),
    ...(vat != null ? [`<tr><td>ضريبة ${vatPercent}%</td><td class="num">${money(vat)}</td></tr>`] : []),
    `<tr class="grand"><td>الصافي</td><td class="num">${money(afterDiscount)}</td></tr>`,
  ].join("");

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>فتورة مبيعات #${escapeHtml(docNo)}</title>
  <style>
    @page { size: A4; margin: 12mm; }
    body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; font-size: 12px; color: #111; margin: 0; padding: 12px; }
    h1 { text-align: center; margin: 6px 0 10px; font-size: 18px; }
    .meta { display: flex; flex-wrap: wrap; gap: 6px 24px; margin: 8px 0 12px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border: 1px solid #999; padding: 6px 8px; text-align: right; }
    th { background: #1f3a5f; color: #fff; }
    td.num { font-variant-numeric: tabular-nums; }
    .totals { width: 50%; margin-top: 12px; margin-inline-start: auto; }
    .totals .grand td { background: #eef2f7; font-weight: 700; }
    ${PRINT_BRANDING_CSS}
  </style>
</head>
<body>
  ${buildPrintBrandingHtml()}
  <h1>فتورة مبيعات #${escapeHtml(docNo)}</h1>
  <div class="meta">
    <div><strong>العميل:</strong> ${escapeHtml(doc.customer_name || "")}</div>
    <div><strong>التاريخ:</strong> ${escapeHtml(docDate)}</div>
    <div><strong>الحالة:</strong> ${escapeHtml(STATUS_LABEL[doc.status] || doc.status || "—")}</div>
    ${doc.ref_text ? `<div><strong>المرجع:</strong> ${escapeHtml(doc.ref_text)}</div>` : ""}
    <div><strong>تاريخ الطباعة:</strong> ${escapeHtml(formatTimestamp())}</div>
  </div>
  <table>
    <thead>
      <tr>
        <th class="num">#</th><th>الصنف</th><th>الباركود</th><th>الوحدة</th><th class="num">الكمية</th><th class="num">بونص</th><th class="num">سعر الوحدة</th><th class="num">خصم</th><th class="num">الإجمالي</th>
      </tr>
    </thead>
    <tbody>${bodyRows || `<tr><td colspan="9" style="text-align:center">لا توجد أصناف</td></tr>`}</tbody>
  </table>
  <table class="totals">${totalsRows}</table>
  ${doc.notes ? `<div class="notes"><strong>ملاحظات:</strong> ${escapeHtml(doc.notes)}</div>` : ""}
  <p class="footer">${escapeHtml(storeName)} — فتورة مبيعات</p>
</body>
</html>`;

  w.document.write(html);
  w.document.close();
  printDocumentWhenReady(w.document);
}
