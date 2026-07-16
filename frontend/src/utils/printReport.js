import { cellValue } from "./reportExport";
import { buildPrintBrandingHtml, PRINT_BRANDING_CSS } from "./printBranding";
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
export function printReport({ title, subtitle, columns, rows, summary, meta }) {
  if (!columns?.length || !rows?.length) return;

  const w = window.open("", "_blank", "width=900,height=720");
  if (!w) {
    window.alert("اسمح بفتح النافذة المنبثقة للطباعة.");
    return;
  }

  const metaLines = (meta || []).map((line) => `<p class="meta">${escapeHtml(line)}</p>`).join("");
  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
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
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
    }
    th, td {
      border: 1px solid #ccc;
      padding: 6px 8px;
      text-align: right;
      vertical-align: top;
    }
    th {
      background: #f0f0f0;
      font-weight: 600;
    }
    tr:nth-child(even) td { background: #fafafa; }
    ${PRINT_BRANDING_CSS}
    @media print {
      body { padding: 0; }
      thead { display: table-header-group; }
      tr { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  ${buildPrintBrandingHtml()}
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
export function printSummaryReport({ title, subtitle, sections, meta }) {
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
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4; margin: 14mm; }
    body { margin: 0; padding: 16px; font-family: "Segoe UI", Tahoma, Arial, sans-serif; color: #111; background: #fff; }
    h1 { margin: 0 0 4px; font-size: 20px; }
    h2.section-title { margin: 16px 0 8px; font-size: 15px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
    .subtitle { margin: 0 0 8px; color: #444; }
    .meta { margin: 0 0 4px; color: #666; font-size: 11px; }
    .generated { margin: 0 0 16px; color: #666; font-size: 11px; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin-bottom: 12px; }
    .summary-item { border: 1px solid #ddd; border-radius: 6px; padding: 8px 10px; background: #fafafa; }
    .summary-label { display: block; color: #666; font-size: 11px; margin-bottom: 2px; }
    .summary-value { display: block; font-weight: 600; font-size: 14px; }
    ${PRINT_BRANDING_CSS}
  </style>
</head>
<body>
  ${buildPrintBrandingHtml()}
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
