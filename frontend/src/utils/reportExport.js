/**
 * @typedef {{ key: string, header: string, value?: (row: object) => unknown }} ReportColumn
 */

function cellValue(column, row) {
  if (typeof column.value === "function") {
    return column.value(row);
  }
  return row[column.key];
}

function formatCsvCell(value) {
  if (value == null) return '""';
  let text = String(value);
  // CSV formula-injection guard: a leading =, +, -, @, tab or CR can be
  // executed by Excel/Sheets. Prefix with a single quote to neutralize it.
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  text = text.replace(/"/g, '""');
  return `"${text}"`;
}

/**
 * Export rows to a CSV file (UTF-8 BOM for Excel Arabic support).
 * @param {string} filename
 * @param {ReportColumn[]} columns
 * @param {object[]} rows
 */
export function exportToCsv(filename, columns, rows) {
  if (!columns?.length || !rows?.length) return;

  const headerLine = columns.map((c) => formatCsvCell(c.header ?? c.key)).join(",");
  const bodyLines = rows.map((row) =>
    columns.map((c) => formatCsvCell(cellValue(c, row))).join(",")
  );

  const csv = `\uFEFF${headerLine}\n${bodyLines.join("\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export { cellValue };

/**
 * Filter DataTable column defs into export/print columns (drops action columns).
 * @param {object[]} columns
 */
export function pickExportColumns(columns) {
  return (columns || [])
    .filter((c) => {
      if (!c.key || c.key === "actions" || c.key === "view") return false;
      if (c.header === "" || c.header == null) return false;
      return true;
    })
    .map((c) => ({
      key: c.key,
      header: typeof c.header === "string" ? c.header : String(c.label || c.key),
      value: c.value,
    }));
}
