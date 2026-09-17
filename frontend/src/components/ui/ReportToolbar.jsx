import Button from "./Button";
import { exportToCsv } from "../../utils/reportExport";
import { printReport, printSummaryReport } from "../../utils/printReport";
import { loadStoreSettings } from "../../utils/loadStoreSettings";
import { todayISO } from "../../utils/format";

function sanitizeFilename(name) {
  return String(name || "report")
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

export default function ReportToolbar({
  title,
  subtitle,
  columns,
  rows,
  summary,
  filename,
  meta,
  disabled,
  getExportRows,
}) {
  const hasTableData =
    Array.isArray(rows) && rows.length > 0 && Array.isArray(columns) && columns.length > 0;
  const hasSummary = Array.isArray(summary) && summary.length > 0;
  const isDisabled = disabled || (!hasTableData && !hasSummary);
  const csvName = `${sanitizeFilename(filename || title)}-${todayISO()}`;

  async function onPrint() {
    const store = await loadStoreSettings();
    if (hasTableData) {
      printReport({ title, subtitle, columns, rows, summary, meta, store });
      return;
    }
    if (hasSummary) {
      printSummaryReport({
        title,
        subtitle,
        sections: [{ items: summary }],
        meta,
        store,
      });
    }
  }

  async function onExport() {
    const exportRows = typeof getExportRows === "function" ? await getExportRows() : rows;
    const canExportTable =
      Array.isArray(exportRows) && exportRows.length > 0 && Array.isArray(columns) && columns.length > 0;
    if (canExportTable) {
      exportToCsv(csvName, columns, exportRows);
      return;
    }
    if (hasSummary) {
      exportToCsv(
        csvName,
        [
          { key: "label", header: "البند" },
          { key: "value", header: "القيمة" },
        ],
        summary
      );
    }
  }

  return (
    <div className="report-toolbar ui-btn-group">
      <Button type="button" variant="secondary" size="sm" icon="print" onClick={onPrint} disabled={isDisabled}>
        طباعة
      </Button>
      <Button type="button" variant="secondary" size="sm" icon="download" onClick={onExport} disabled={isDisabled}>
        تصدير CSV
      </Button>
    </div>
  );
}
