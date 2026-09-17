import { cellValue } from "./reportExport";
import { buildPrintBrandingHtml, A4_PRINT_SHEET_CSS, PRINT_BRANDING_CSS } from "./printBranding";
import { printDocumentWhenReady } from "./printDocument";
import { formatDateTimeShopAr } from "./format";

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text == null ? "" : String(text);
  return div.innerHTML;
}

function formatPrintTimestamp() {
  return formatDateTimeShopAr(new Date());
}

function buildSummaryHtml(summary) {
  if (!summary?.length) return "";
  const items = summary
    .map(
      (item) =>
        `<div class="summary-item"><span class="summary-label">${escapeHtml(item.label)}</span><span class="summary-value">${escapeHtml(item.value)}</span></div>`
    )
    .join("");
  return `<div class="summary-grid">${items}</div>`;
}

function buildTableHtml(columns, rows) {
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
  return `<table><thead><tr>${headers}</tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * Open a styled RTL print window for tabular reports.
 * @param {{ title: string, subtitle?: string, columns: object[], rows: object[], summary?: { label: string, value: string }[], meta?: string[] }} opts
 */
export function printReport({ title, subtitle, columns, rows, summary, meta, store }) {
  if (!columns?.length || !rows?.length) return;

  const w = window.open("", "_blank", "width=900,height=720");
  if (!w) {
    window.alert("اسمح بفتح النافذة المنبثقة للطباعة.");
    return;
  }

  const metaLines = (meta || []).map((line) => `<p class="meta">${escapeHtml(line)}</p>`).join("");
  const html = `<!DOCTYPE html>
<html lang="ar-u-nu-latn" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4; }
    ${A4_PRINT_SHEET_CSS}
    ${PRINT_BRANDING_CSS}
    th { background: #f0f0f0; }
    tr:nth-child(even) td { background: #fafafa; }
  </style>
</head>
<body>
  ${buildPrintBrandingHtml(store)}
  <h1>${escapeHtml(title)}</h1>
  ${subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ""}
  ${metaLines}
  <p class="generated">تاريخ الطباعة: ${escapeHtml(formatPrintTimestamp())}</p>
  ${buildSummaryHtml(summary)}
  ${buildTableHtml(columns, rows)}
</body>
</html>`;

  w.document.write(html);
  w.document.close();
  printDocumentWhenReady(w.document, { onAfterPrint: () => w.close() });
}

/**
 * Print a summary-only report (no table), e.g. dashboard KPIs.
 * @param {{ title: string, subtitle?: string, sections: { heading?: string, items: { label: string, value: string }[] }[], meta?: string[] }} opts
 */
export function printSummaryReport({ title, subtitle, sections, meta, store }) {
  const w = window.open("", "_blank", "width=900,height=720");
  if (!w) {
    window.alert("اسمح بفتح النافذة المنبثقة للطباعة.");
    return;
  }

  const sectionHtml = (sections || [])
    .map((section) => {
      const items = (section.items || [])
        .map(
          (item) =>
            `<div class="summary-item"><span class="summary-label">${escapeHtml(item.label)}</span><span class="summary-value">${escapeHtml(item.value)}</span></div>`
        )
        .join("");
      const heading = section.heading
        ? `<h2 class="section-title">${escapeHtml(section.heading)}</h2>`
        : "";
      return `${heading}<div class="summary-grid">${items}</div>`;
    })
    .join("");

  const metaLines = (meta || []).map((line) => `<p class="meta">${escapeHtml(line)}</p>`).join("");

  const html = `<!DOCTYPE html>
<html lang="ar-u-nu-latn" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4; }
    ${A4_PRINT_SHEET_CSS}
    ${PRINT_BRANDING_CSS}
  </style>
</head>
<body>
  ${buildPrintBrandingHtml(store)}
  <h1>${escapeHtml(title)}</h1>
  ${subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ""}
  ${metaLines}
  <p class="generated">تاريخ الطباعة: ${escapeHtml(formatPrintTimestamp())}</p>
  ${sectionHtml}
</body>
</html>`;

  w.document.write(html);
  w.document.close();
  printDocumentWhenReady(w.document, { onAfterPrint: () => w.close() });
}
