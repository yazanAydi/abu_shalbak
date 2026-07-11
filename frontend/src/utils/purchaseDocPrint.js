import { buildPrintBrandingHtml, PRINT_BRANDING_CSS, STORE_NAME_AR } from "./printBranding";
import { printDocumentWhenReady } from "./printDocument";
import { formatDiscountPercent, formatTaxRatePercent } from "./purchaseTotals";
const STATUS_LABEL = {
  draft: "مسودة",
  posted: "مرحّلة",
  confirmed: "مؤكد",
  received: "مستلم",
  cancelled: "ملغي",
};

const DOC_META = {
  invoices: { title: "فاتورة شراء", noKey: "invoice_no", dateKey: "invoice_date", totalKey: "total" },
  orders: { title: "أمر شراء", noKey: "order_no", dateKey: "order_date", totalKey: "total_amount" },
  returns: { title: "مرتجع شراء", noKey: "return_no", dateKey: "return_date", totalKey: "total" },
};

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
 * Open a print window for a single purchase document (invoice / order / return).
 * @param {object} doc   full document detail (with items[]) from GET /api/purchases/:which/:id
 * @param {"invoices"|"orders"|"returns"} which
 * @param {object} [store] store settings ({ store_name, store_name_ar, store_address, store_phone })
 */
export function printPurchaseDoc(doc, which, store = {}) {
  if (!doc) return;
  const meta = DOC_META[which] || DOC_META.invoices;
  const items = doc.items || [];
  const docNo = doc[meta.noKey] ?? doc.id;
  const docDate = doc[meta.dateKey] ? String(doc[meta.dateKey]).slice(0, 10) : "—";
  const total = Number(doc[meta.totalKey]) || 0;
  const subtotal = doc.subtotal != null ? Number(doc.subtotal) : null;
  const vat = doc.vat != null ? Number(doc.vat) : null;
  const vatPercent = formatTaxRatePercent(store.default_tax_rate);
  const storeName = store.store_name_ar || store.store_name || STORE_NAME_AR;

  const listGrossTotal = items.reduce((s, it) => s + (Number(it.total_cost) || 0), 0);
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
        <td class="num">${qty(it.base_quantity != null ? it.base_quantity : it.quantity)}</td>
        <td class="num">${money(it.total_cost)}</td>
        <td class="num">${it.discount_pct ? `${it.discount_pct}%` : "—"}</td>
        <td class="num">${money(it.unit_cost)}</td>
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
    ...(which === "invoices" && vat != null
      ? [`<tr><td>ضريبة ${vatPercent}%</td><td class="num">${money(vat)}</td></tr>`]
      : []),
    `<tr class="grand"><td>الصافي</td><td class="num">${money(afterDiscount)}</td></tr>`,
  ].join("");

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(meta.title)} #${escapeHtml(docNo)}</title>
  <style>
    @page { size: A4; margin: 12mm; }
    body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; font-size: 12px; color: #111; margin: 0; padding: 12px; }
    .store { text-align: center; font-weight: 700; font-size: 18px; }
    .store-sub { text-align: center; font-size: 11px; color: #555; margin-bottom: 6px; }
    h1 { text-align: center; margin: 6px 0 10px; font-size: 18px; }
    .meta { display: flex; flex-wrap: wrap; gap: 6px 24px; margin: 8px 0 12px; }
    .meta div { font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border: 1px solid #999; padding: 6px 8px; text-align: right; vertical-align: top; }
    th { background: #1f3a5f; color: #fff; }
    td.num, th.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .totals { width: 50%; margin-top: 12px; margin-inline-start: auto; }
    .totals td { border: 1px solid #999; padding: 6px 8px; }
    .totals .grand td { background: #eef2f7; font-weight: 700; font-size: 14px; }
    .notes { margin-top: 12px; font-size: 12px; }
    .signatures { margin-top: 40px; display: flex; justify-content: space-between; }
    .signatures div { width: 30%; border-top: 1px solid #333; padding-top: 6px; text-align: center; font-size: 12px; }
    .footer { margin-top: 16px; font-size: 10px; color: #666; text-align: center; }
    ${PRINT_BRANDING_CSS}
    @media print { thead { display: table-header-group; } tr { page-break-inside: avoid; } }
  </style>
</head>
<body>
  ${buildPrintBrandingHtml()}
  <h1>${escapeHtml(meta.title)} #${escapeHtml(docNo)}</h1>
  <div class="meta">
    <div><strong>المورد:</strong> ${escapeHtml(doc.supplier_name || "")}</div>
    <div><strong>التاريخ:</strong> ${escapeHtml(docDate)}</div>
    <div><strong>الحالة:</strong> ${escapeHtml(STATUS_LABEL[doc.status] || doc.status || "—")}</div>
    ${doc.ref_text ? `<div><strong>المرجع:</strong> ${escapeHtml(doc.ref_text)}</div>` : ""}
    <div><strong>تاريخ الطباعة:</strong> ${escapeHtml(formatTimestamp())}</div>
  </div>
  <table>
    <thead>
      <tr>
        <th class="num">#</th><th>الصنف</th><th>الباركود</th><th>الوحدة</th><th class="num">الكمية</th><th class="num">بونص</th><th class="num">بالحبة</th><th class="num">إجمالي الكلفة</th><th class="num">خصم</th><th class="num">كلفة الوحدة</th><th class="num">الإجمالي</th>
      </tr>
    </thead>
    <tbody>${bodyRows || `<tr><td colspan="11" style="text-align:center">لا توجد أصناف</td></tr>`}</tbody>
  </table>
  <table class="totals">${totalsRows}</table>
  ${doc.notes ? `<div class="notes"><strong>ملاحظات:</strong> ${escapeHtml(doc.notes)}</div>` : ""}
  <div class="signatures">
    <div>توقيع المستلم</div>
    <div>توقيع المورد</div>
    <div>الإدارة</div>
  </div>
  <p class="footer">${escapeHtml(storeName)} — ${escapeHtml(meta.title)}</p>
</body>
</html>`;

  w.document.write(html);
  w.document.close();
  printDocumentWhenReady(w.document);
}
