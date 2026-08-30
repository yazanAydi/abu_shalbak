import { memo, useMemo, useState } from "react";
import { SkeletonRows } from "./Skeleton";
import EmptyState from "./EmptyState";

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
  if (hideOnMobile(column, mobileColumns)) parts.push("ui-table__col--hide-mobile");
  return parts.length ? parts.join(" ") : undefined;
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
          style={c.align ? { textAlign: c.align } : undefined}
        >
          {c.render ? c.render(row, index) : row[c.key]}
        </td>
      ))}
    </tr>
  );
});

/**
 * Lightweight declarative table.
 * columns: [{ key, header, label?, render?(row), className?, align?, hideOnMobile? }]
 * mobileColumns: optional list of keys to keep on phones (overrides hideOnMobile).
 */
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
      <div className="ui-table-wrap">
        <SkeletonRows rows={6} cols={columns.length} />
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <div className="ui-table-wrap">
        <EmptyState icon={emptyIcon} title={empty || "لا توجد بيانات"} hint={emptyHint} />
      </div>
    );
  }

  const slice = virtualize ? rows.slice(windowed.start, windowed.end) : rows;

  return (
    <div
      className="ui-table-wrap"
      style={virtualize ? { maxHeight: VIEWPORT_HEIGHT, overflow: "auto" } : undefined}
      onScroll={virtualize ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined}
    >
      <table className="ui-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={columnClassName(c, mobileColumns)}
                style={c.align ? { textAlign: c.align } : undefined}
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
      </table>
    </div>
  );
}
