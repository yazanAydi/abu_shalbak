import { StatusBadge } from "../../components/ui";
import { num, dateTime } from "../../utils/format";
import { useProductTab } from "./useProductTab";
import { TabState, movementLabel, MOVEMENT_TONE } from "./shared";

export default function InventoryHistoryTab({ productId }) {
  const { data, loading, error } = useProductTab(`/api/products/${productId}/inventory-history`);
  const rows = data?.rows || [];

  return (
    <TabState loading={loading} error={error} empty={rows.length === 0} emptyText="لا توجد حركات مخزون مسجّلة لهذا المنتج">
      <div className="ui-table-wrap pd-sticky-table">
        <table className="ui-table">
          <thead>
            <tr>
              <th>التاريخ</th>
              <th>نوع الحركة</th>
              <th>المرجع</th>
              <th>الكمية</th>
              <th>الرصيد بعد الحركة</th>
              <th>المستخدم</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const delta = Number(r.quantity_delta) || 0;
              return (
                <tr key={r.id}>
                  <td>{dateTime(r.created_at)}</td>
                  <td><StatusBadge tone={MOVEMENT_TONE[r.movement_type] || "neutral"} noDot>{movementLabel(r.movement_type)}</StatusBadge></td>
                  <td>{r.reference_type ? `${r.reference_type} #${r.reference_id ?? "—"}` : (r.notes || "—")}</td>
                  <td className="num" style={{ color: delta < 0 ? "var(--office-danger, #dc2626)" : "var(--office-success, #16a34a)" }}>
                    {delta > 0 ? `+${num(delta, 0)}` : num(delta, 0)}
                  </td>
                  <td className="num">{r.qty_after != null ? num(r.qty_after, 0) : "—"}</td>
                  <td>{r.user_name || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </TabState>
  );
}
