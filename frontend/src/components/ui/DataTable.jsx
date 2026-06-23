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

/**
 * Lightweight declarative table.
 * columns: [{ key, header, label?, render?(row), className?, align? }]
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
              <th key={c.key} style={c.align ? { textAlign: c.align } : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey(row, i)} className={rowClassName ? rowClassName(row) : undefined}>
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={c.className}
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
