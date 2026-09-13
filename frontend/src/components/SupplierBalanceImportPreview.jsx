import { Card, CardBody } from "./ui";

const ACTION_LABELS = {
  create: { text: "جديد", className: "status-pill--success" },
  update: { text: "تحديث", className: "status-pill--info" },
  existing: { text: "موجود", className: "status-pill--muted" },
  skip: { text: "تخطي", className: "status-pill--muted" },
  exclude: { text: "تجريبي — مستبعد", className: "status-pill--muted" },
  invalid: { text: "مرفوض", className: "status-pill--danger" },
};

function formatAmount(n) {
  if (n == null || n === "") return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
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
  const isTransfer = preview.type === "abu_shalbak_supplier_list";

  const statCards = isTransfer
    ? [
        { label: "إجمالي الصفوف", value: stats.totalRows ?? 0 },
        { label: "موردون جدد", value: stats.toCreate ?? 0 },
        { label: "موجودون", value: stats.existing ?? stats.alreadyImported ?? 0 },
        { label: "تعارض رقم", value: stats.conflicts ?? stats.codeReassigned ?? 0 },
        { label: "مرفوضون", value: stats.rejected ?? stats.invalid ?? 0 },
        { label: "تجريبيون مستبعدون", value: stats.excluded ?? 0 },
        { label: "إجمالي مستحق (موجب)", value: formatAmount(stats.totalPositiveSystem ?? stats.totalPositiveExcel) },
        { label: "إجمالي دائن (سالب)", value: formatAmount(stats.totalNegativeSystem ?? stats.totalNegativeExcel) },
        { label: "صافي الأرصدة", value: formatAmount(stats.netTotalSystem ?? stats.netTotalExcel) },
      ]
    : [
        { label: "إجمالي الصفوف", value: stats.totalRows ?? 0 },
        { label: "موردون جدد", value: stats.toCreate ?? 0 },
        { label: "موجودون", value: stats.existing ?? stats.alreadyImported ?? 0 },
        { label: "موردون محدّثون", value: stats.matched ?? 0 },
        { label: "مرفوضون", value: stats.rejected ?? stats.invalid ?? 0 },
        { label: "صفوف تُركت", value: stats.skipped ?? 0 },
        { label: "أسماء مكررة", value: stats.duplicateNames ?? 0 },
        { label: "إجمالي أرصدة موجبة", value: formatAmount(stats.totalPositiveExcel) },
        { label: "إجمالي أرصدة سالبة", value: formatAmount(stats.totalNegativeExcel) },
        { label: "صافي الأرصدة", value: formatAmount(stats.netTotalExcel) },
      ];

  return (
    <Card>
      <CardBody>
        <h3 style={{ marginTop: 0 }}>معاينة الاستيراد</h3>
        <p
          style={{
            marginTop: 0,
            padding: "0.6rem 0.75rem",
            background: "var(--office-surface-muted, #f4f1ea)",
            borderRadius: "6px",
          }}
        >
          الوجهة: <strong>{preview.destinationLabel || "إدارة الموردين — بطاقة مورد"}</strong>
          {" — "}
          لن يُنشئ زبائن في إدارة العملاء.
        </p>
        {preview.destinationWarning ? (
          <p style={{ color: "var(--office-warning, #b7791f)" }}>{preview.destinationWarning}</p>
        ) : null}
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

        {(stats.existing ?? stats.alreadyImported) > 0 && (
          <p style={{ color: "var(--office-warning, #b7791f)" }}>
            {isTransfer
              ? `يوجد ${stats.existing ?? stats.alreadyImported} مورد موجود بالاسم. لن يُغيَّر رصيده أو تاريخه.`
              : `يوجد ${stats.existing ?? stats.alreadyImported} مورد موجود من استيراد سابق. لن يُحدَّث رصيده ما لم تفعّل «تجاوز الأرصدة الافتتاحية».`}
          </p>
        )}

        <div className="hesabati-statement__table-wrap" style={{ maxHeight: "360px" }}>
          <table className="hesabati-statement-table data-table">
            <thead>
              <tr>
                <th>صف</th>
                <th>الرقم</th>
                <th>الاسم</th>
                <th>{isTransfer ? "الرصيد المقترح" : "رصيد Excel"}</th>
                {!isTransfer && <th>رصيد النظام</th>}
                {!isTransfer && <th>رصيد الكشف</th>}
                {isTransfer && <th>الرقم بعد التعارض</th>}
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
                    <td className="num">{formatAmount(isTransfer ? r.systemBalance : r.excelBalance)}</td>
                    {!isTransfer && <td className="num">{formatAmount(r.systemBalance)}</td>}
                    {!isTransfer && <td className="num">{formatAmount(r.statementBalance)}</td>}
                    {isTransfer && (
                      <td>{r.codeReassigned ? (r.assignedCode || "رقم جديد") : (r.assignedCode || r.code || "—")}</td>
                    )}
                    <td>
                      <span className={`status-pill ${action.className}`}>
                        {r.codeReassigned ? "جديد — رقم مُعاد" : action.text}
                      </span>
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
          <details style={{ marginTop: "1rem" }} open>
            <summary>صفوف مرفوضة ({errors.length})</summary>
            <ul>
              {errors.map((e, i) => (
                <li key={`${e.row}-${i}`}>
                  صف {e.row}: {e.reason}
                  {e.name ? ` — ${e.name}` : ""}
                  {e.code ? ` (${e.code})` : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardBody>
    </Card>
  );
}
