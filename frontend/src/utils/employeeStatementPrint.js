import { buildPrintBrandingHtml, A4_PRINT_SHEET_CSS, PRINT_BRANDING_CSS, STORE_NAME_AR } from "./printBranding";
import { printDocumentWhenReady } from "./printDocument";
import { dateOnly, formatDateTimeShopAr } from "./format";

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

function amountCell(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) < 0.009) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function closingLabel(owed, excess) {
  if (Number(excess) > 0.009) return `راتب مدفوع مقدماً ${amountCell(excess)} ₪`;
  if (Number(owed) > 0.009) return `المتبقي للموظف ${amountCell(owed)} ₪`;
  return "لا يوجد رصيد";
}

/**
 * Print كشف حساب موظف from GET /api/employees/:id/statement
 * @param {object} report
 */
export function printEmployeeStatement(report) {
  if (!report) return;
  const w = window.open("", "_blank", "width=1100,height=800");
  if (!w) {
    window.alert("اسمح بفتح النافذة المنبثقة للطباعة.");
    return;
  }

  const range =
    report.date_from && report.date_to
      ? `من ${dateOnly(report.date_from)} إلى ${dateOnly(report.date_to)}`
      : "كل الفترات";
  const kindLabel = report.kind === "cashier" ? "كاشير" : "موظف";
  const rows = (report.movements || [])
    .map((r) => {
      const neg = Number(r.balance) < 0 ? " balance-neg" : "";
      return `<tr>
        <td>${escapeHtml(r.date ? dateOnly(r.date) : "—")}</td>
        <td>${escapeHtml(r.description || r.kind_label || "")}</td>
        <td class="num">${amountCell(r.debit)}</td>
        <td class="num">${amountCell(r.credit)}</td>
        <td class="num${neg}">${amountCell(r.balance)}</td>
      </tr>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html lang="ar-u-nu-latn" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(report.report_title || "كشف حساب موظف")}</title>
  <style>
    @page { size: A4 portrait; }
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
  <h1>${escapeHtml(report.report_title || "كشف حساب موظف")}</h1>
  <p class="meta"><strong>الموظف:</strong> ${escapeHtml(report.name)} (${escapeHtml(kindLabel)})</p>
  <p class="meta"><strong>الفترة:</strong> ${escapeHtml(range)}</p>
  <p class="meta"><strong>الرصيد الافتتاحي:</strong> ${amountCell(report.opening_balance)} ₪</p>
  <p class="meta"><strong>الاستحقاق في الفترة:</strong> ${amountCell(report.period_entitled)} ₪</p>
  <p class="meta"><strong>دفعات الراتب:</strong> ${amountCell(report.period_salary_payments)} ₪ — <strong>سلف:</strong> ${amountCell(report.period_advances)} ₪</p>
  <p class="meta"><strong>الإقفال:</strong> ${escapeHtml(closingLabel(report.amount_owed, report.excess_prepaid))}</p>
  <p class="meta">أرقام هذا الكشف هي الاستحقاقات والدفعات المسجّلة. معاينة الساعات ليست راتباً مرحّلاً.${
    Number(report.period_entitled || 0) === 0 ? " لم يُرحَّل استحقاق راتب في هذه الفترة." : ""
  }</p>
  <p class="meta"><strong>تاريخ الطباعة:</strong> ${escapeHtml(formatDateTimeShopAr(new Date()))}</p>
  <table>
    <thead>
      <tr>
        <th>التاريخ</th><th>البيان</th><th>مستحق للموظف</th><th>مدفوع للموظف</th><th>الرصيد</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr>
        <td colspan="2">الإجمالي / الإقفال</td>
        <td class="num">${amountCell(report.period_entitled)}</td>
        <td class="num">${amountCell(report.period_paid)}</td>
        <td class="num">${amountCell(report.closing_balance)}</td>
      </tr>
    </tfoot>
  </table>
  <p class="footer">${escapeHtml(report.store_name || STORE_NAME_AR)} — كشف حساب موظف</p>
</body>
</html>`;

  w.document.write(html);
  w.document.close();
  printDocumentWhenReady(w.document);
}
