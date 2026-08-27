import { SkeletonRows } from "./Skeleton";
import EmptyState from "./EmptyState";

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

  return (
    <div className="ui-table-wrap">
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
          {rows.map((row, i) => (
            <tr
              key={rowKey(row, i)}
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
                  {c.render ? c.render(row, i) : row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
