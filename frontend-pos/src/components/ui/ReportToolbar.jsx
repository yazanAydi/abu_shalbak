import Icon from "../icons/Icon";
import { SecondaryButton } from "./ActionButtons";
import { exportToCsv } from "../../utils/reportExport";
import { printReport, printSummaryReport } from "../../utils/printReport";
import { todayISO } from "../../utils/format";

function sanitizeFilename(name) {
  return String(name || "report")
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

/**
 * Shared Print + Export toolbar for report pages.
 * @param {{ title: string, subtitle?: string, columns: object[], rows: object[], summary?: { label: string, value: string }[], filename?: string, meta?: string[], disabled?: boolean }} props
 */
export default function ReportToolbar({
  title,
  subtitle,
  columns,
  rows,
  summary,
  filename,
  meta,
  disabled,
}) {
  const hasTableData =
    Array.isArray(rows) && rows.length > 0 && Array.isArray(columns) && columns.length > 0;
  const hasSummary = Array.isArray(summary) && summary.length > 0;
  const isDisabled = disabled || (!hasTableData && !hasSummary);
  const csvName = `${sanitizeFilename(filename || title)}-${todayISO()}`;

  function onPrint() {
    if (hasTableData) {
      printReport({ title, subtitle, columns, rows, summary, meta });
      return;
    }
    if (hasSummary) {
      printSummaryReport({
        title,
        subtitle,
        sections: [{ items: summary }],
        meta,
      });
    }
  }

  function onExport() {
    if (hasTableData) {
      exportToCsv(csvName, columns, rows);
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
    <div className="report-toolbar" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <SecondaryButton type="button" onClick={onPrint} disabled={isDisabled}>
        <Icon name="print" size={16} style={{ marginInlineEnd: 6 }} />
        طباعة
      </SecondaryButton>
      <SecondaryButton type="button" onClick={onExport} disabled={isDisabled}>
        <Icon name="download" size={16} style={{ marginInlineEnd: 6 }} />
        تصدير CSV
      </SecondaryButton>
    </div>
  );
}
