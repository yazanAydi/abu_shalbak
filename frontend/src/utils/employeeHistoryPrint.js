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

function rowsHtml(items, cells) {
  if (!items?.length) return `<tr><td colspan="${cells.length}">لا توجد حركات في الفترة</td></tr>`;
  return items
    .map(
      (item) =>
        `<tr>${cells
          .map((cell) => `<td class="${cell.num ? "num" : ""}">${escapeHtml(cell.value(item))}</td>`)
          .join("")}</tr>`
    )
    .join("");
}

export function printEmployeeHistoryStatement(report) {
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
  const salaries = report.salaries?.items || [];
  const advances = report.advances?.items || [];
  const debts = report.debts?.items || [];
  const repayments = report.repayments?.items || [];
  const outstandingAdvances = report.advances?.outstanding_items || [];
  const outstandingDebts = report.debts?.outstanding_items || [];

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(report.report_title || "كشف حساب موظف")}</title>
  <style>
    @page { size: A4; }
    ${A4_PRINT_SHEET_CSS}
    ${PRINT_BRANDING_CSS}
    th { background: #eee; }
  </style>
</head>
<body>
  ${buildPrintBrandingHtml({
    store_name: report.store_name,
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
  <p class="meta">هذا الكشف حركات مسجّلة (رواتب، سلف، ذمم). ليس محرّر استحقاق ولا رصيداً افتتاحياً.</p>
  <p class="meta">تاريخ الطباعة: ${escapeHtml(formatDateTimeShopAr(new Date()))}</p>

  <h2>الرواتب</h2>
  <p class="meta">إجمالي دفعات الراتب في الفترة: ${amountCell(report.salaries?.period_total)} ₪</p>
  <table>
    <thead><tr><th>التاريخ</th><th>المبلغ</th><th>الطريقة</th><th>مرجع</th></tr></thead>
    <tbody>${rowsHtml(salaries, [
      { value: (r) => r.date || "—" },
      { value: (r) => amountCell(r.amount), num: true },
      { value: (r) => r.payment_method_label || "—" },
      { value: (r) => r.reference || "—" },
    ])}</tbody>
  </table>

  <h2>السلف</h2>
  <p class="meta">إجمالي السلف في الفترة: ${amountCell(report.advances?.period_total)} ₪ — المسوّى منها في الفترة: ${amountCell(report.advances?.period_settled)} ₪ — القائم حتى نهاية الفترة: ${amountCell(report.advances?.outstanding_as_of)} ₪</p>
  <table>
    <thead><tr><th>التاريخ</th><th>المبلغ</th><th>المسوّى</th><th>المتبقي</th><th>السبب</th></tr></thead>
    <tbody>${rowsHtml(advances, [
      { value: (r) => r.date || "—" },
      { value: (r) => amountCell(r.amount), num: true },
      { value: (r) => amountCell(r.settled), num: true },
      { value: (r) => amountCell(r.remaining), num: true },
      { value: (r) => r.reason || "—" },
    ])}</tbody>
  </table>
  ${
    outstandingAdvances.length
      ? `<p class="meta">سلف ما زالت قائمة حتى نهاية الفترة (حتى لو تاريخها خارج الفلتر): ${outstandingAdvances
          .map((r) => `${escapeHtml(r.date)} ${amountCell(r.remaining)} ₪`)
          .join("؛ ")}</p>`
      : ""
  }

  <h2>الذمم</h2>
  <p class="meta">إجمالي فواتير الذمة في الفترة: ${amountCell(report.debts?.period_total)} ₪ — القائم حتى نهاية الفترة: ${amountCell(report.debts?.outstanding_as_of)} ₪</p>
  <table>
    <thead><tr><th>التاريخ</th><th>الفاتورة</th><th>الأصناف</th><th>ملاحظات</th><th>الأصل</th><th>المسوّى</th><th>المتبقي</th></tr></thead>
    <tbody>${rowsHtml(debts, [
      { value: (r) => r.date || "—" },
      { value: (r) => r.invoice_no || `#${r.source_id}` },
      { value: (r) => r.description || "—" },
      { value: (r) => r.notes || "—" },
      { value: (r) => amountCell(r.original), num: true },
      { value: (r) => amountCell(r.settled), num: true },
      { value: (r) => amountCell(r.remaining), num: true },
    ])}</tbody>
  </table>
  ${
    outstandingDebts.length
      ? `<p class="meta">ذمم ما زالت قائمة حتى نهاية الفترة (حتى لو تاريخها خارج الفلتر): ${outstandingDebts
          .map((r) => `${escapeHtml(r.date)} ${amountCell(r.remaining)} ₪`)
          .join("؛ ")}</p>`
      : ""
  }
  <h2>تسديدات الذمة</h2>
  <p class="meta">إجمالي سندات القبض في الفترة: ${amountCell(report.repayments?.period_total)} ₪</p>
  <table>
    <thead><tr><th>التاريخ</th><th>المبلغ</th><th>الطريقة</th><th>سند</th><th>ملاحظة</th></tr></thead>
    <tbody>${rowsHtml(repayments, [
      { value: (r) => r.date || "—" },
      { value: (r) => amountCell(r.amount), num: true },
      { value: (r) => r.payment_method_label || "—" },
      { value: (r) => (r.voucher_no != null ? String(r.voucher_no) : "—") },
      { value: (r) => r.notes || "—" },
    ])}</tbody>
  </table>
  <p class="footer">${escapeHtml(report.store_name || STORE_NAME_AR)} — كشف حساب موظف</p>
</body>
</html>`;
  w.document.write(html);
  w.document.close();
  printDocumentWhenReady(w.document);
}
