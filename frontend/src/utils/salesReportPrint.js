import { cellValue } from "./reportExport";
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

const PRINT_CSS = `
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 16px;
    font-family: "Segoe UI", Tahoma, Arial, sans-serif;
    color: #111;
    background: #fff;
    font-size: 12px;
    line-height: 1.4;
  }
  h1 { margin: 0 0 4px; font-size: 20px; }
  h2.section-title { margin: 16px 0 8px; font-size: 15px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .subtitle { margin: 0 0 8px; color: #444; font-size: 13px; }
  .meta { margin: 0 0 4px; color: #666; font-size: 11px; }
  .generated { margin: 0 0 16px; color: #666; font-size: 11px; }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 8px;
    margin: 0 0 16px;
  }
  .summary-item {
    border: 1px solid #ddd;
    border-radius: 6px;
    padding: 8px 10px;
    background: #fafafa;
  }
  .summary-label { display: block; color: #666; font-size: 11px; margin-bottom: 2px; }
  .summary-value { display: block; font-weight: 600; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 16px; }
  th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: right; vertical-align: top; }
  th { background: #f0f0f0; font-weight: 600; }
  tr:nth-child(even) td { background: #fafafa; }
  ${PRINT_BRANDING_CSS}
  @media print {
    body { padding: 0; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
  }
`;

function buildSummaryHtml(items, heading) {
  if (!items?.length) return "";
  const headingHtml = heading ? `<h2 class="section-title">${escapeHtml(heading)}</h2>` : "";
  const grid = items
    .map(
      (item) =>
        `<div class="summary-item"><span class="summary-label">${escapeHtml(item.label)}</span><span class="summary-value">${escapeHtml(item.value)}</span></div>`
    )
    .join("");
  return `${headingHtml}<div class="summary-grid">${grid}</div>`;
}

function buildTableHtml(columns, rows, heading) {
  if (!columns?.length || !rows?.length) return "";
  const headingHtml = heading ? `<h2 class="section-title">${escapeHtml(heading)}</h2>` : "";
  const headers = columns
    .map((c) => `<th>${escapeHtml(c.header ?? c.key)}</th>`)
    .join("");
  const body = rows
    .map((row) => {
      const cells = columns
        .map((c) => `<td>${escapeHtml(cellValue(c, row))}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `${headingHtml}<table><thead><tr>${headers}</tr></thead><tbody>${body}</tbody></table>`;
}

function openPrintWindow(title, bodyHtml) {
  const w = window.open("", "_blank", "width=900,height=720");
  if (!w) {
    window.alert("اسمح بفتح النافذة المنبثقة للطباعة.");
    return;
  }
  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>${PRINT_CSS}</style>
</head>
<body>${buildPrintBrandingHtml()}${bodyHtml}</body>
</html>`;
  w.document.write(html);
  w.document.close();
  printDocumentWhenReady(w.document, { onAfterPrint: () => w.close() });
}

/**
 * @param {{ title?: string, date: string, summaryItems: { label: string, value: string }[], collectionItems?: { label: string, value: string }[], productColumns: object[], products: object[], storeName?: string }} opts
 */
export function printSalesDailyReport({
  title = "تقرير مبيعات يومي",
  date,
  summaryItems,
  collectionItems,
  productColumns,
  products,
}) {
  const meta = [`تاريخ التقرير: ${date}`];

  const body = `
  <h1>${escapeHtml(title)}</h1>
  <p class="subtitle">تقرير يوم ${escapeHtml(date)}</p>
  ${meta.map((line) => `<p class="meta">${escapeHtml(line)}</p>`).join("")}
  <p class="generated">تاريخ الطباعة: ${escapeHtml(formatPrintTimestamp())}</p>
  ${buildSummaryHtml(summaryItems, "ملخص المبيعات")}
  ${buildSummaryHtml(collectionItems, "تحصيلات حسب العملة")}
  ${buildTableHtml(productColumns, products, "أفضل المنتجات")}
  `;

  openPrintWindow(title, body);
}

/**
 * @param {{ title?: string, from: string, to: string, summaryItems: { label: string, value: string }[], dayColumns: object[], byDay: object[], storeName?: string }} opts
 */
export function printSalesRangeReport({
  title = "تقرير مبيعات — فترة",
  from,
  to,
  summaryItems,
  dayColumns,
  byDay,
}) {
  const meta = [`الفترة: ${from} — ${to}`];

  const body = `
  <h1>${escapeHtml(title)}</h1>
  <p class="subtitle">من ${escapeHtml(from)} إلى ${escapeHtml(to)}</p>
  ${meta.map((line) => `<p class="meta">${escapeHtml(line)}</p>`).join("")}
  <p class="generated">تاريخ الطباعة: ${escapeHtml(formatPrintTimestamp())}</p>
  ${buildSummaryHtml(summaryItems, "ملخص الفترة")}
  ${buildTableHtml(dayColumns, byDay, "التفصيل اليومي")}
  `;

  openPrintWindow(title, body);
}
