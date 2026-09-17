import { cellValue } from "./reportExport";
import { buildPrintBrandingHtml, A4_PRINT_SHEET_CSS, PRINT_BRANDING_CSS } from "./printBranding";
import { printDocumentWhenReady } from "./printDocument";
import { loadStoreSettings } from "./loadStoreSettings";
import { formatDateTimeShopAr } from "./format";

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

function formatPrintTimestamp() {
  return formatDateTimeShopAr(new Date());
}

const PRINT_CSS = `
  @page { size: A4; }
  ${A4_PRINT_SHEET_CSS}
  ${PRINT_BRANDING_CSS}
  th { background: #f0f0f0; }
  tr:nth-child(even) td { background: #fafafa; }
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

async function openPrintWindow(title, bodyHtml) {
  const store = await loadStoreSettings();
  const w = window.open("", "_blank", "width=900,height=720");
  if (!w) {
    window.alert("اسمح بفتح النافذة المنبثقة للطباعة.");
    return;
  }
  const html = `<!DOCTYPE html>
<html lang="ar-u-nu-latn" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>${PRINT_CSS}</style>
</head>
<body>${buildPrintBrandingHtml(store)}${bodyHtml}</body>
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

  return openPrintWindow(title, body);
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

  return openPrintWindow(title, body);
}
