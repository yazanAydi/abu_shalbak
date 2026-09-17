import { buildPrintBrandingHtml, buildPartyBalanceHtml, buildPrintedByHtml, A4_PRINT_SHEET_CSS, PRINT_BRANDING_CSS, STORE_NAME_AR } from "./printBranding";
import { printDocumentWhenReady } from "./printDocument";
import { dateOnly, formatDateTimeShopAr } from "./format";
import { voucherPartyName } from "./partySearch";

const TYPE_AR = { receipt: "سند قبض", payment: "سند صرف" };
const STATUS_LABEL = { draft: "مسودة", posted: "مرحّل" };
const LINE_TYPE_AR = { cash: "نقدي", check: "شيك", bank: "بنك" };

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

function money(n) {
  return Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatTimestamp(value) {
  return formatDateTimeShopAr(value || new Date());
}

/**
 * HTML for a receipt/payment voucher print window.
 * @param {object} doc full voucher detail from GET /api/vouchers/:id
 * @param {object} [store]
 */
export function buildVoucherDocPrintHtml(doc, store = {}) {
  const title = TYPE_AR[doc.voucher_type] || "سند";
  const docNo = doc.voucher_no ?? doc.id;
  const docDate = dateOnly(doc.voucher_date);
  const total = Number(doc.total_amount) || 0;
  const storeName = store.store_name_ar || store.store_name || STORE_NAME_AR;
  const party = voucherPartyName(doc) || "";
  const lines = Array.isArray(doc.lines) ? doc.lines : [];

  const bodyRows = lines
    .map((L, i) => {
      const amount = L.amount_nis != null ? L.amount_nis : L.amount;
      return `<tr>
        <td class="num">${i + 1}</td>
        <td>${escapeHtml(LINE_TYPE_AR[L.line_type] || L.line_type || "—")}</td>
        <td class="num">${money(amount)}</td>
        <td>${escapeHtml(L.currency || "—")}</td>
        <td>${escapeHtml(L.line_type === "check" ? L.bank_name || "—" : "—")}</td>
        <td>${escapeHtml(L.description || "—")}</td>
      </tr>`;
    })
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
  <h1>${escapeHtml(title)} #${escapeHtml(docNo)}</h1>
  <div class="meta">
    ${party ? `<div><strong>الاسم:</strong> ${escapeHtml(party)}</div>` : ""}
    <div><strong>التاريخ:</strong> ${escapeHtml(docDate)}</div>
    <div><strong>الحالة:</strong> ${escapeHtml(STATUS_LABEL[doc.status] || doc.status || "—")}</div>
    ${doc.recorded_by_name ? `<div><strong>سجّله:</strong> ${escapeHtml(doc.recorded_by_name)}</div>` : ""}
    <div><strong>تاريخ الطباعة:</strong> <span class="when">${escapeHtml(formatTimestamp())}</span></div>
  </div>
  <table>
    <thead>
      <tr>
        <th class="num">#</th><th>النوع</th><th class="num">المبلغ</th><th>العملة</th><th>البنك</th><th>البيان</th>
      </tr>
    </thead>
    <tbody>${bodyRows || `<tr><td colspan="6" style="text-align:center">لا توجد أسطر</td></tr>`}</tbody>
  </table>
  <div class="totals-wrap">
    <table class="totals">
      <tr class="grand"><td>المجموع</td><td class="num">${money(total)}</td></tr>
    </table>
  </div>
  ${buildPartyBalanceHtml(doc.party_balance)}
  ${buildPrintedByHtml()}
  ${doc.notes ? `<div class="notes"><strong>ملاحظات:</strong> ${escapeHtml(doc.notes)}</div>` : ""}
  <div class="signatures">
    <div>المستلم</div>
    <div>المحاسب</div>
    <div>الإدارة</div>
  </div>
  <p class="footer">${escapeHtml(storeName)} — ${escapeHtml(title)}</p>
</body>
</html>`;
}

/**
 * Open a print window for a receipt/payment voucher.
 * @param {object} doc full voucher detail from GET /api/vouchers/:id
 * @param {object} [store]
 */
export function printVoucherDoc(doc, store = {}) {
  if (!doc) return;
  const w = window.open("", "_blank", "width=900,height=840");
  if (!w) {
    window.alert("اسمح بفتح النافذة المنبثقة للطباعة.");
    return;
  }
  w.document.write(buildVoucherDocPrintHtml(doc, store));
  w.document.close();
  printDocumentWhenReady(w.document);
}
