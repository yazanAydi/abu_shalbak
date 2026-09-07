import { buildPrintBrandingHtml, buildPartyBalanceHtml, buildPrintedByHtml, PRINT_BRANDING_CSS, STORE_NAME_AR } from "./printBranding";
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
 * Open a print window for a receipt/payment voucher.
 * @param {object} doc full voucher detail from GET /api/vouchers/:id
 * @param {object} [store]
 */
export function printVoucherDoc(doc, store = {}) {
  if (!doc) return;
  const title = TYPE_AR[doc.voucher_type] || "سند";
  const docNo = doc.voucher_no ?? doc.id;
  const docDate = dateOnly(doc.voucher_date);
  const total = Number(doc.total_amount) || 0;
  const storeName = store.store_name_ar || store.store_name || STORE_NAME_AR;
  const party = voucherPartyName(doc) || "";
  const lines = Array.isArray(doc.lines) ? doc.lines : [];

  const w = window.open("", "_blank", "width=900,height=840");
  if (!w) {
    window.alert("اسمح بفتح النافذة المنبثقة للطباعة.");
    return;
  }

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
  ${buildPrintBrandingHtml(store)}
  <h1>${escapeHtml(title)} #${escapeHtml(docNo)}</h1>
  <div class="meta">
    ${party ? `<div><strong>الاسم:</strong> ${escapeHtml(party)}</div>` : ""}
    <div><strong>التاريخ:</strong> ${escapeHtml(docDate)}</div>
    <div><strong>الحالة:</strong> ${escapeHtml(STATUS_LABEL[doc.status] || doc.status || "—")}</div>
    ${doc.recorded_by_name ? `<div><strong>سجّله:</strong> ${escapeHtml(doc.recorded_by_name)}</div>` : ""}
    <div><strong>تاريخ الطباعة:</strong> ${escapeHtml(formatTimestamp())}</div>
  </div>
  <table>
    <thead>
      <tr>
        <th class="num">#</th><th>النوع</th><th class="num">المبلغ</th><th>العملة</th><th>البنك</th><th>البيان</th>
      </tr>
    </thead>
    <tbody>${bodyRows || `<tr><td colspan="6" style="text-align:center">لا توجد أسطر</td></tr>`}</tbody>
  </table>
  <table class="totals">
    <tr class="grand"><td>المجموع</td><td class="num">${money(total)}</td></tr>
  </table>
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

  w.document.write(html);
  w.document.close();
  printDocumentWhenReady(w.document);
}
