import { Card, CardBody } from "./ui";

const ACTION_LABELS = {
  create: { text: "جديد", className: "status-pill--success" },
  update: { text: "تحديث", className: "status-pill--info" },
  skip: { text: "تخطي", className: "status-pill--muted" },
  invalid: { text: "غير صالح", className: "status-pill--danger" },
};

function formatAmount(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `${abs}-` : abs;
}

/**
 * @param {{ preview: object | null }} props
 */
export default function SupplierBalanceImportPreview({ preview }) {
  if (!preview) return null;

  const stats = preview.stats || {};
  const rows = preview.rows || [];
  const duplicateNames = preview.duplicateNames || [];
  const errors = preview.errors || [];

  const statCards = [
    { label: "إجمالي الصفوف", value: stats.totalRows ?? 0 },
    { label: "موردون مطابقون", value: stats.matched ?? 0 },
    { label: "موردون جدد", value: stats.toCreate ?? 0 },
    { label: "صفوف غير صالحة", value: stats.invalid ?? 0 },
    { label: "أسماء مكررة", value: stats.duplicateNames ?? 0 },
    { label: "مستوردون سابقاً", value: stats.alreadyImported ?? 0 },
    { label: "إجمالي أرصدة موجبة", value: formatAmount(stats.totalPositiveExcel) },
    { label: "إجمالي أرصدة سالبة", value: formatAmount(stats.totalNegativeExcel) },
    { label: "صافي الأرصدة", value: formatAmount(stats.netTotalExcel) },
  ];

  return (
    <Card>
      <CardBody>
        <h3 style={{ marginTop: 0 }}>معاينة الاستيراد</h3>
        <div className="import-summary-stats" style={{ marginBottom: "1rem" }}>
          {statCards.map((s) => (
            <div key={s.label} className="import-summary-stat">
              <span className="import-summary-stat__value">{s.value}</span>
              <span className="import-summary-stat__label">{s.label}</span>
            </div>
          ))}
        </div>

        {duplicateNames.length > 0 && (
          <div className="import-preview-warnings" style={{ marginBottom: "1rem" }}>
            <strong>تحذير — أسماء مكررة بأكواد مختلفة:</strong>
            <ul>
              {duplicateNames.map((d) => (
                <li key={d.name}>
                  {d.name} ({d.codes.join("، ")})
                </li>
              ))}
            </ul>
          </div>
        )}

        {stats.alreadyImported > 0 && (
          <p style={{ color: "var(--office-warning, #b7791f)" }}>
            يوجد {stats.alreadyImported} مورد لديه رصيد افتتاحي من حساباتي. فعّل «تجاوز الأرصدة
            الافتتاحية» لإعادة الاستيراد.
          </p>
        )}

        <div className="hesabati-statement__table-wrap" style={{ maxHeight: "360px" }}>
          <table className="hesabati-statement-table data-table">
            <thead>
              <tr>
                <th>صف</th>
                <th>الرقم</th>
                <th>الاسم</th>
                <th>رصيد Excel</th>
                <th>رصيد النظام</th>
                <th>رصيد الكشف</th>
                <th>الإجراء</th>
                <th>ملاحظة</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const action = ACTION_LABELS[r.action] || ACTION_LABELS.skip;
                return (
                  <tr key={r.rowNum}>
                    <td>{r.rowNum}</td>
                    <td>{r.code || "—"}</td>
                    <td>{r.name}</td>
                    <td className="num">{formatAmount(r.excelBalance)}</td>
                    <td className="num">{formatAmount(r.systemBalance)}</td>
                    <td className="num">{formatAmount(r.statementBalance)}</td>
                    <td>
                      <span className={`status-pill ${action.className}`}>{action.text}</span>
                    </td>
                    <td>{r.reason || ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {rows.length < (stats.totalRows ?? 0) && (
          <p style={{ color: "var(--office-text-muted)", fontSize: "0.9rem" }}>
            عرض أول {rows.length} صف من {stats.totalRows}.
          </p>
        )}

        {errors.length > 0 && (
          <details style={{ marginTop: "1rem" }}>
            <summary>أخطاء وصفوف متروكة ({errors.length})</summary>
            <ul>
              {errors.slice(0, 30).map((e, i) => (
                <li key={`${e.row}-${i}`}>
                  صف {e.row}: {e.reason}
                  {e.name ? ` — ${e.name}` : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardBody>
    </Card>
  );
}
