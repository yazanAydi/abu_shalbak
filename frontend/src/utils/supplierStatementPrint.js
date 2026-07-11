import { buildPrintBrandingHtml, PRINT_BRANDING_CSS, STORE_NAME_AR } from "./printBranding";
import { printDocumentWhenReady } from "./printDocument";

const MOVEMENT_TYPE_AR = {
  opening_balance: "رصيد افتتاحي",
  purchase_invoice: "فاتورة مشتريات",
  supplier_payment: "سند دفع",
  purchase_return: "مرتجع مشتريات",
  adjustment: "تسوية يدوية",
};

export function movementTypeLabel(type) {
  return MOVEMENT_TYPE_AR[type] || type;
}

/**
 * Final balance label for supplier (system sign: positive = we owe the supplier).
 * @param {number} balance
 */
export function balanceLabel(balance) {
  const n = Number(balance) || 0;
  if (Math.abs(n) < 0.009) return "لا يوجد رصيد";
  return n > 0 ? "علينا للمورد" : "لنا عند المورد";
}

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
 * Open a print window for the detailed supplier statement (Save as PDF from browser).
 * @param {object} report response of GET /api/suppliers/:id/statement-ledger
 */
export function printSupplierStatement(report) {
  if (!report) return;
  const movements = report.movements || [];

  const w = window.open("", "_blank", "width=1180,height=840");
  if (!w) {
    window.alert("اسمح بفتح النافذة المنبثقة للطباعة.");
    return;
  }

  const supplier = report.supplier || {};
  const summary = report.summary || {};
  const range =
    report.date_from && report.date_to
      ? `من ${report.date_from} إلى ${report.date_to}`
      : "كل الفترات";
  const finalBalance = Number(summary.finalBalance) || 0;

  const bodyRows = movements
    .map((m) => {
      const neg = Number(m.runningBalance) < 0 ? " balance-neg" : "";
      return `<tr>
        <td>${escapeHtml(m.date ? String(m.date).slice(0, 10) : "—")}</td>
        <td>${escapeHtml(movementTypeLabel(m.type))}</td>
        <td>${escapeHtml(m.documentNo || "—")}</td>
        <td>${escapeHtml(m.description || "")}</td>
        <td class="num">${amountCell(m.debit)}</td>
        <td class="num">${amountCell(m.credit)}</td>
        <td class="num${neg}">${amountCell(m.runningBalance)}</td>
        <td>${escapeHtml(m.paymentMethod || "—")}</td>
        <td>${escapeHtml(m.createdBy || "—")}</td>
      </tr>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(report.report_title || "كشف حساب المورد")}</title>
  <style>
    @page { size: A4 landscape; margin: 10mm; }
    body { font-family: "Segoe UI", Tahoma, Arial, sans-serif; font-size: 11px; color: #111; margin: 0; padding: 12px; }
    h1 { text-align: center; margin: 0 0 4px; font-size: 18px; }
    .store { text-align: center; font-weight: 700; margin-bottom: 8px; font-size: 14px; }
    .meta { display: flex; flex-wrap: wrap; gap: 6px 24px; margin: 6px 0 10px; }
    .meta div { font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border: 1px solid #999; padding: 5px 6px; text-align: right; vertical-align: top; }
    th { background: #1f3a5f; color: #fff; }
    td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .balance-neg { color: #c53030; font-weight: 600; }
    tfoot td { background: #eef2f7; font-weight: 700; }
    .final { margin-top: 12px; font-size: 13px; font-weight: 700; }
    .signatures { margin-top: 36px; display: flex; justify-content: space-between; }
    .signatures div { width: 30%; border-top: 1px solid #333; padding-top: 6px; text-align: center; font-size: 12px; }
    .footer { margin-top: 12px; font-size: 10px; color: #666; text-align: center; }
    ${PRINT_BRANDING_CSS}
    @media print { thead { display: table-header-group; } tr { page-break-inside: avoid; } }
  </style>
</head>
<body>
  ${buildPrintBrandingHtml()}
  <h1>${escapeHtml(report.report_title || "كشف حساب المورد")}</h1>
  <div class="meta">
    <div><strong>المورد:</strong> ${escapeHtml(supplier.name || "")}</div>
    ${supplier.phone ? `<div><strong>الهاتف:</strong> ${escapeHtml(supplier.phone)}</div>` : ""}
    ${supplier.address ? `<div><strong>العنوان:</strong> ${escapeHtml(supplier.address)}</div>` : ""}
    <div><strong>الفترة:</strong> ${escapeHtml(range)}</div>
    <div><strong>تاريخ الإصدار:</strong> ${escapeHtml(formatTimestamp(report.generated_at))}</div>
  </div>
  <table>
    <thead>
      <tr>
        <th>التاريخ</th><th>نوع الحركة</th><th>رقم المستند</th><th>البيان</th>
        <th>مدين</th><th>دائن</th><th>الرصيد</th><th>طريقة الدفع</th><th>المستخدم</th>
      </tr>
    </thead>
    <tbody>${bodyRows}</tbody>
    <tfoot>
      <tr>
        <td colspan="4">الإجمالي</td>
        <td class="num">${amountCell(summary.totalDebit)}</td>
        <td class="num">${amountCell(summary.totalCredit)}</td>
        <td class="num">${amountCell(summary.finalBalance)}</td>
        <td colspan="2"></td>
      </tr>
    </tfoot>
  </table>
  <div class="final">الرصيد النهائي: ${amountCell(Math.abs(finalBalance))} (${escapeHtml(balanceLabel(finalBalance))})</div>
  <div class="signatures">
    <div>توقيع المحاسب</div>
    <div>توقيع المورد</div>
    <div>الإدارة</div>
  </div>
  <p class="footer">${escapeHtml(report.store_name || STORE_NAME_AR)} — كشف حساب المورد</p>
</body>
</html>`;

  w.document.write(html);
  w.document.close();
  printDocumentWhenReady(w.document);
}

/**
 * Download the detailed supplier statement as Excel from the backend.
 * @param {import("axios").AxiosInstance} api
 * @param {number} supplierId
 * @param {{ from?: string, to?: string, type?: string, search?: string }} [params]
 */
export async function downloadSupplierStatementExcel(api, supplierId, params = {}) {
  const qs = new URLSearchParams();
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.type) qs.set("type", params.type);
  if (params.search) qs.set("search", params.search);
  const { data } = await api.get(
    `/api/suppliers/${supplierId}/statement-ledger/excel?${qs}`,
    { responseType: "blob" }
  );
  const url = URL.createObjectURL(new Blob([data]));
  const a = document.createElement("a");
  a.href = url;
  a.download = `supplier-statement-${supplierId}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
