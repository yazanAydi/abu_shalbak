import { buildPrintBrandingHtml, buildPartyBalanceHtml, buildPrintedByHtml, A4_PRINT_SHEET_CSS, PRINT_BRANDING_CSS, STORE_NAME_AR } from "./printBranding";
import { printDocumentWhenReady } from "./printDocument";
import { deriveEffectiveUnitCost, formatDiscountPercent, formatTaxRatePercent, lineHasPurchaseDiscount } from "./purchaseTotals";
import { dateOnly, formatDateTimeShopAr } from "./format";

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

/** Print table columns (barcode is omitted from print only). */
export const PURCHASE_PRINT_COL_COUNT = 11;

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

function itemRowHtml(it, i) {
  return `<tr>
        <td class="num">${i + 1}</td>
        <td class="col-name">${escapeHtml(it.name || "")}</td>
        <td>${escapeHtml(it.unit_name || "—")}</td>
        <td class="num">${qty(it.quantity)}</td>
        <td class="num">${qty(it.bonus_quantity || 0)}</td>
        <td class="num">${qty(it.base_quantity != null ? it.base_quantity : it.quantity)}</td>
        <td class="num">${money(it.total_cost)}</td>
        <td class="num">${it.discount_pct ? `${escapeHtml(it.discount_pct)}%` : "—"}</td>
        <td class="num">${money(it.unit_cost)}</td>
        <td class="num">${lineHasPurchaseDiscount(it.discount_pct) ? money(deriveEffectiveUnitCost(it.line_total, it.quantity) || 0) : "—"}</td>
        <td class="num">${money(it.line_total)}</td>
      </tr>`;
}

/**
 * HTML for a purchase invoice / order / return print window.
 * Barcode is intentionally omitted from this template only.
 * @param {object} doc
 * @param {"invoices"|"orders"|"returns"} which
 * @param {object} [store]
 * @param {{ printedAt?: Date|string }} [opts]
 */
export function buildPurchaseDocPrintHtml(doc, which, store = {}, opts = {}) {
  const meta = DOC_META[which] || DOC_META.invoices;
  const items = doc.items || [];
  const docNo = doc[meta.noKey] ?? doc.id;
  const docDate = dateOnly(doc[meta.dateKey]);
  const total = Number(doc[meta.totalKey]) || 0;
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

  const bodyRows = items.map(itemRowHtml).join("");

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

  return `<!DOCTYPE html>
<html lang="ar-u-nu-latn" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(meta.title)} #${escapeHtml(docNo)}</title>
  <style>
    @page { size: A4; }
    ${A4_PRINT_SHEET_CSS}
    ${PRINT_BRANDING_CSS}
    table.items { table-layout: auto; }
    col.col-idx { width: 3%; }
    col.col-name { width: 32%; }
    col.col-unit { width: 7%; }
    col.col-qty { width: 6%; }
    col.col-disc { width: 5%; }
    col.col-money { width: 8%; }
    th { background: #1f3a5f; color: #fff; }
    th.col-name, td.col-name { width: 32%; min-width: 42mm; }
    td.col-name {
      white-space: normal;
      overflow-wrap: break-word;
      word-wrap: break-word;
    }
  </style>
</head>
<body>
  ${buildPrintBrandingHtml(store)}
  <h1>${escapeHtml(meta.title)} #${escapeHtml(docNo)}</h1>
  <div class="meta">
    <div><strong>المورد:</strong> ${escapeHtml(doc.supplier_name || "")}</div>
    <div><strong>التاريخ:</strong> ${escapeHtml(docDate)}</div>
    <div><strong>الحالة:</strong> ${escapeHtml(STATUS_LABEL[doc.status] || doc.status || "—")}</div>
    ${doc.ref_text ? `<div><strong>المرجع:</strong> ${escapeHtml(doc.ref_text)}</div>` : ""}
    <div><strong>تاريخ الطباعة:</strong> <span class="when">${escapeHtml(formatTimestamp(opts.printedAt))}</span></div>
  </div>
  <table class="items">
    <colgroup>
      <col class="col-idx" />
      <col class="col-name" />
      <col class="col-unit" />
      <col class="col-qty" />
      <col class="col-qty" />
      <col class="col-qty" />
      <col class="col-money" />
      <col class="col-disc" />
      <col class="col-money" />
      <col class="col-money" />
      <col class="col-money" />
    </colgroup>
    <thead>
      <tr>
        <th class="num">#</th>
        <th class="col-name">الصنف</th>
        <th>الوحدة</th>
        <th class="num">الكمية</th>
        <th class="num">بونص</th>
        <th class="num">كمية الأساس</th>
        <th class="num">إجمالي الكلفة</th>
        <th class="num">خصم</th>
        <th class="num">كلفة الوحدة</th>
        <th class="num">الكلفة الفعلية</th>
        <th class="num">الإجمالي</th>
      </tr>
    </thead>
    <tbody>${bodyRows || `<tr><td colspan="${PURCHASE_PRINT_COL_COUNT}" style="text-align:center">لا توجد أصناف</td></tr>`}</tbody>
  </table>
  <div class="totals-wrap">
    <table class="totals">${totalsRows}</table>
  </div>
  ${which === "orders" ? "" : buildPartyBalanceHtml(doc.party_balance)}
  ${buildPrintedByHtml()}
  ${doc.notes ? `<div class="notes"><strong>ملاحظات:</strong> ${escapeHtml(doc.notes)}</div>` : ""}
  <div class="closing">
    <div class="signatures">
      <div>توقيع المستلم</div>
      <div>توقيع المورد</div>
      <div>الإدارة</div>
    </div>
    <p class="footer">${escapeHtml(storeName)} — ${escapeHtml(meta.title)}</p>
  </div>
</body>
</html>`;
}

/**
 * Open a print window for a single purchase document (invoice / order / return).
 * @param {object} doc   full document detail (with items[]) from GET /api/purchases/:which/:id
 * @param {"invoices"|"orders"|"returns"} which
 * @param {object} [store] store settings ({ store_name, store_name_ar, store_address, store_phone })
 */
export function printPurchaseDoc(doc, which, store = {}) {
  if (!doc) return;
  const w = window.open("", "_blank", "width=900,height=840");
  if (!w) {
    window.alert("اسمح بفتح النافذة المنبثقة للطباعة.");
    return;
  }

  w.document.write(buildPurchaseDocPrintHtml(doc, which, store));
  w.document.close();
  printDocumentWhenReady(w.document);
}
