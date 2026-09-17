import { getDisplayRows } from "../components/AccountStatementView";
import { buildPrintBrandingHtml, A4_PRINT_SHEET_CSS, PRINT_BRANDING_CSS } from "./printBranding";
import { printDocumentWhenReady } from "./printDocument";
import { dateOnly, formatDateTimeShopAr } from "./format";

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

function formatPrintTimestamp() {
  return formatDateTimeShopAr(new Date());
}

function amountCell(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) < 0.009) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Open print window for account statement (Save as PDF from browser).
 * @param {object} report
 * @param {"supplier"|"customer"} partyType
 */
export function printAccountStatement(report, partyType) {
  const rows = getDisplayRows(report);
  if (!report || !rows.length) return;

  const w = window.open("", "_blank", "width=1100,height=800");
  if (!w) {
    window.alert("اسمح بفتح النافذة المنبثقة للطباعة.");
    return;
  }

  const partyLabel = partyType === "supplier" ? "المورد" : "العميل";
  const totals = report.totals || report.formatted?.totals;
  const range =
    report.date_from && report.date_to
      ? `من ${dateOnly(report.date_from)} إلى ${dateOnly(report.date_to)}`
      : "كل الفترات";

  const bodyRows = rows
    .map((r) => {
      const neg = r.balance_is_negative ? " balance-neg" : "";
      return `<tr>
        <td>${escapeHtml(r.line_no || "—")}</td>
        <td>${escapeHtml(r.description)}</td>
        <td>${escapeHtml(r.date ? dateOnly(r.date) : "—")}</td>
        <td class="num">${amountCell(r.debit)}</td>
        <td class="num">${amountCell(r.credit)}</td>
        <td class="num${neg}">${escapeHtml(r.balance_formatted)}</td>
        <td>${escapeHtml(r.notes || "—")}</td>
      </tr>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html lang="ar-u-nu-latn" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(report.report_title || "كشف حساب")}</title>
  <style>
    @page { size: A4 landscape; }
    ${A4_PRINT_SHEET_CSS}
    ${PRINT_BRANDING_CSS}
    th { background: #eee; }
    .balance-neg { color: #c53030; font-weight: 600; }
    tfoot td { background: #f7fafc; font-weight: 600; }
  </style>
</head>
<body>
  ${buildPrintBrandingHtml({
    store_name_ar: report.store_name || report.store_name_ar,
    store_phone: report.store_phone,
    store_license: report.store_license,
    store_address: report.store_address,
    receipt_logo_url: report.receipt_logo_url,
    print_show_logo: report.print_show_logo,
    print_show_name: report.print_show_name,
    print_show_phone: report.print_show_phone,
    print_show_address: report.print_show_address,
    print_show_license: report.print_show_license,
  })}
  <h1>${escapeHtml(report.report_title || "كشف حساب")}</h1>
  <p class="meta"><strong>${partyLabel}:</strong> ${escapeHtml(report.party?.name)}</p>
  <p class="meta"><strong>الفترة:</strong> ${escapeHtml(range)}</p>
  <p class="meta"><strong>تاريخ الطباعة:</strong> ${escapeHtml(formatPrintTimestamp())}</p>
  <table>
    <thead>
      <tr>
        <th>الرقم</th><th>البيان</th><th>التاريخ</th><th>مدين</th><th>دائن</th><th>الرصيد</th><th>ملاحظات</th>
      </tr>
    </thead>
    <tbody>${bodyRows}</tbody>
    <tfoot>
      <tr>
        <td colspan="3">الإجمالي</td>
        <td class="num">${amountCell(totals?.debit)}</td>
        <td class="num">${amountCell(totals?.credit)}</td>
        <td class="num">${escapeHtml(totals?.finalBalanceFormatted || totals?.final_balance_formatted || "")}</td>
        <td></td>
      </tr>
    </tfoot>
  </table>
  <p class="footer">صفحة 1</p>
</body>
</html>`;

  w.document.write(html);
  w.document.close();
  printDocumentWhenReady(w.document);
}

/**
 * Download Excel via backend endpoint.
 */
export async function downloadAccountStatementExcel(api, params) {
  const qs = new URLSearchParams({
    partyType: params.partyType,
    partyId: String(params.partyId),
  });
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  const { data } = await api.get(`/api/reports/account-statement/excel?${qs}`, {
    responseType: "blob",
  });
  const url = URL.createObjectURL(new Blob([data]));
  const a = document.createElement("a");
  a.href = url;
  a.download = `kashf-${params.partyType}-${params.partyId}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
