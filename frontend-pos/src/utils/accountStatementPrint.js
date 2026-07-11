import { getDisplayRows } from "../components/AccountStatementView";
import { buildPrintBrandingHtml, PRINT_BRANDING_CSS } from "./printBranding";
import { printDocumentWhenReady } from "./printDocument";
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

function formatPrintTimestamp() {
  return new Date().toLocaleString("ar-EG", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
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
      ? `من ${report.date_from} إلى ${report.date_to}`
      : "كل الفترات";

  const bodyRows = rows
    .map((r) => {
      const neg = r.balance_is_negative ? " balance-neg" : "";
      return `<tr>
        <td>${escapeHtml(r.line_no || "—")}</td>
        <td>${escapeHtml(r.description)}</td>
        <td>${escapeHtml(r.date || "—")}</td>
        <td class="num">${amountCell(r.debit)}</td>
        <td class="num">${amountCell(r.credit)}</td>
        <td class="num${neg}">${escapeHtml(r.balance_formatted)}</td>
        <td>${escapeHtml(r.notes || "—")}</td>
      </tr>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(report.report_title || "كشف حساب")}</title>
  <style>
    @page { size: A4 landscape; margin: 10mm; }
    body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; font-size: 11px; color: #111; margin: 0; padding: 12px; }
    h1 { text-align: center; margin: 0 0 4px; font-size: 18px; }
    .store { text-align: center; font-weight: 700; margin-bottom: 8px; }
    .meta { margin: 4px 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border: 1px solid #999; padding: 5px 6px; text-align: right; vertical-align: top; }
    th { background: #eee; }
    td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .balance-neg { color: #c53030; font-weight: 600; }
    tfoot td { background: #f7fafc; font-weight: 600; }
    .footer { margin-top: 12px; font-size: 10px; color: #666; text-align: center; }
    ${PRINT_BRANDING_CSS}
    @media print { thead { display: table-header-group; } tr { page-break-inside: avoid; } }
  </style>
</head>
<body>
  ${buildPrintBrandingHtml()}
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
