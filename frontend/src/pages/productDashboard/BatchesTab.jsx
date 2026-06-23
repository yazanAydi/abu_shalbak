import { StatusBadge } from "../../components/ui";
import { ils, num, dateOnly } from "../../utils/format";
import { useProductTab } from "./useProductTab";
import { TabState, expiryBadge } from "./shared";

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
              <th>الكمية</th>
              <th>التكلفة</th>
              <th>الحالة</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const b = expiryBadge(r.days_remaining);
              return (
                <tr key={r.id}>
                  <td>{r.batch_no || "—"}</td>
                  <td>{dateOnly(r.created_at)}</td>
                  <td>{r.expiry_date || "—"}</td>
                  <td className="num">{r.days_remaining != null ? num(r.days_remaining, 0) : "—"}</td>
                  <td className="num">{num(r.quantity, 0)}</td>
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
