import { memo, useMemo, useState } from "react";
import { SkeletonRows } from "./Skeleton";
import EmptyState from "./EmptyState";
import Button from "./Button";

const VIRTUALIZE_AFTER = 80;
const ROW_HEIGHT = 48;
const OVERSCAN = 8;
const VIEWPORT_HEIGHT = 520;

function columnLabel(column) {
  if (column.label != null && String(column.label).trim() !== "") {
    return String(column.label);
  }
  if (typeof column.header === "string") {
    return column.header;
  }
  return "";
}

function hideOnMobile(column, mobileColumns) {
  if (Array.isArray(mobileColumns) && mobileColumns.length > 0) {
    return !mobileColumns.includes(column.key);
  }
  return Boolean(column.hideOnMobile);
}

function columnClassName(column, mobileColumns) {
  const parts = [];
  if (column.className) parts.push(column.className);
  if (column.nameColumn) parts.push("ui-table__col--name");
  if (column.wrap) parts.push("ui-table__col--wrap");
  if (hideOnMobile(column, mobileColumns)) parts.push("ui-table__col--hide-mobile");
  return parts.length ? parts.join(" ") : undefined;
}

function columnStyle(column) {
  const style = {};
  if (column.align) style.textAlign = column.align;
  if (column.width) style.width = column.width;
  if (column.minWidth) style.minWidth = column.minWidth;
  return Object.keys(style).length ? style : undefined;
}

const TableRow = memo(function TableRow({
  row,
  index,
  columns,
  rowKey,
  rowClassName,
  onRowClick,
  mobileColumns,
}) {
  return (
    <tr
      key={rowKey(row, index)}
      className={rowClassName ? rowClassName(row) : undefined}
      onClick={onRowClick ? () => onRowClick(row) : undefined}
    >
      {columns.map((c) => (
        <td
          key={c.key}
          className={columnClassName(c, mobileColumns)}
          data-label={columnLabel(c)}
          style={columnStyle(c)}
        >
          {c.render ? c.render(row, index) : row[c.key]}
        </td>
      ))}
    </tr>
  );
});

function wrapClassName(className) {
  return ["ui-table-wrap", className].filter(Boolean).join(" ");
}

export default function DataTable({
  columns,
  rows,
  loading,
  rowKey = (r, i) => r.id ?? i,
  empty,
  emptyIcon,
  emptyHint,
  rowClassName,
  onRowClick,
  mobileColumns,
  className,
  error,
  onRetry,
  footer,
  dense,
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const virtualize = Boolean(rows && rows.length > VIRTUALIZE_AFTER);

  const windowed = useMemo(() => {
    if (!virtualize || !rows) return { start: 0, end: rows?.length || 0, top: 0, bottom: 0 };
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visible = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2;
    const end = Math.min(rows.length, start + visible);
    return {
      start,
      end,
      top: start * ROW_HEIGHT,
      bottom: Math.max(0, (rows.length - end) * ROW_HEIGHT),
    };
  }, [virtualize, scrollTop, rows]);

  if (loading) {
    return (
      <div className={wrapClassName(className)}>
        <SkeletonRows rows={6} cols={columns.length} />
      </div>
    );
  }

  if (error) {
    return (
      <div className={wrapClassName(className)}>
        <EmptyState
          icon="alert"
          title={error}
          action={
            onRetry ? (
              <Button variant="secondary" onClick={onRetry}>
                إعادة المحاولة
              </Button>
            ) : null
          }
        />
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <div className={wrapClassName(className)}>
        <EmptyState icon={emptyIcon} title={empty || "لا توجد بيانات"} hint={emptyHint} />
      </div>
    );
  }

  const slice = virtualize ? rows.slice(windowed.start, windowed.end) : rows;
  const footerRows = Array.isArray(footer) ? footer : footer ? [footer] : [];

  return (
    <div
      className={wrapClassName(className)}
      style={virtualize ? { maxHeight: VIEWPORT_HEIGHT, overflow: "auto" } : undefined}
      onScroll={virtualize ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined}
    >
      <table className={`ui-table${dense ? " ui-table--dense" : ""}`}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={columnClassName(c, mobileColumns)}
                style={columnStyle(c)}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {virtualize && windowed.top > 0 ? (
            <tr aria-hidden="true">
              <td colSpan={columns.length} style={{ height: windowed.top, padding: 0, border: 0 }} />
            </tr>
          ) : null}
          {slice.map((row, i) => {
            const index = virtualize ? windowed.start + i : i;
            return (
              <TableRow
                key={rowKey(row, index)}
                row={row}
                index={index}
                columns={columns}
                rowKey={rowKey}
                rowClassName={rowClassName}
                onRowClick={onRowClick}
                mobileColumns={mobileColumns}
              />
            );
          })}
          {virtualize && windowed.bottom > 0 ? (
            <tr aria-hidden="true">
              <td colSpan={columns.length} style={{ height: windowed.bottom, padding: 0, border: 0 }} />
            </tr>
          ) : null}
        </tbody>
        {footerRows.length ? (
          <tfoot>
            {footerRows.map((row, i) => (
              <tr key={row.key || `footer-${i}`} className="ui-table__total">
                {columns.map((c) => (
                  <td key={c.key} className={columnClassName(c, mobileColumns)} style={columnStyle(c)}>
                    {c.render ? c.render(row, i) : row[c.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
