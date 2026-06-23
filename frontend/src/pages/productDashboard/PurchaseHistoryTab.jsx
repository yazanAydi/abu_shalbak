import { ils, num, dateOnly } from "../../utils/format";
import { useProductTab } from "./useProductTab";
import { TabState } from "./shared";

export default function PurchaseHistoryTab({ productId }) {
  const { data, loading, error } = useProductTab(`/api/products/${productId}/purchase-history`);
  const rows = data?.rows || [];

  return (
    <TabState loading={loading} error={error} empty={rows.length === 0} emptyText="لا توجد فواتير شراء مرحّلة لهذا المنتج">
      <div className="ui-table-wrap pd-sticky-table">
        <table className="ui-table">
          <thead>
            <tr>
              <th>رقم الفاتورة</th>
              <th>المورد</th>
              <th>تاريخ الشراء</th>
              <th>الكمية</th>
              <th>تكلفة الوحدة</th>
              <th>إجمالي التكلفة</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.invoice_id}-${r.supplier_id}`}>
                <td>#{r.invoice_number ?? r.invoice_id}</td>
                <td>{r.supplier_name}</td>
                <td>{dateOnly(r.invoice_date)}</td>
                <td className="num">{num(r.quantity, 0)}</td>
                <td className="num">{ils(r.unit_cost)}</td>
                <td className="num">{ils(r.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TabState>
  );
}
