import { StatusBadge } from "../../components/ui";
import { ils, num, dateOnly } from "../../utils/format";
import { useProductTab } from "./useProductTab";
import { TabState } from "./shared";
import { UNKNOWN_EXPIRY_LABEL } from "../../utils/stockBatchLabels";

function batchBadge(row) {
  if (!row) return null;
  if (row.status === "unknown" || row.expiry_date == null || row.expiry_date === "") {
    return { tone: "neutral", label: UNKNOWN_EXPIRY_LABEL };
  }
  if (row.status === "expired") return { tone: "red", label: "منتهي الصلاحية" };
  if (row.status === "near") return { tone: "orange", label: "قريب الانتهاء" };
  return { tone: "green", label: row.status_label || "ساري" };
}

export default function BatchesTab({ productId }) {
  const { data, loading, error } = useProductTab(`/api/products/${productId}/batches`);
  const rows = data?.rows || [];

  return (
    <TabState loading={loading} error={error} empty={rows.length === 0} emptyText="لا توجد دفعات مسجّلة لهذا المنتج">
      <div className="ui-table-wrap pd-sticky-table">
        <table className="ui-table">
          <thead>
            <tr>
              <th>رقم الدفعة</th>
              <th>تاريخ الاستلام</th>
              <th>تاريخ الصلاحية</th>
              <th>الأيام المتبقية</th>
              <th>الكمية المتبقية</th>
              <th>التكلفة</th>
              <th>الحالة</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const b = batchBadge(r);
              const key = r.virtual ? "unknown" : r.id;
              return (
                <tr key={key}>
                  <td>{r.virtual ? "—" : (r.batch_no || "—")}</td>
                  <td>{r.created_at ? dateOnly(r.created_at) : "—"}</td>
                  <td>{r.expiry_date ? dateOnly(r.expiry_date) : UNKNOWN_EXPIRY_LABEL}</td>
                  <td className="num">{r.days_remaining != null ? num(r.days_remaining, 0) : "—"}</td>
                  <td className="num">{num(r.quantity, r.virtual ? 3 : 0)}</td>
                  <td className="num">{r.cost != null ? ils(r.cost) : "—"}</td>
                  <td>{b ? <StatusBadge tone={b.tone} noDot>{b.label}</StatusBadge> : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </TabState>
  );
}
