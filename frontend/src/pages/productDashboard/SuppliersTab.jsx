import { useState } from "react";
import api from "../../apiClient";
import { Modal, StatusBadge, SecondaryButton } from "../../components/ui";
import { ils, num, dateOnly } from "../../utils/format";
import { useProductTab } from "./useProductTab";
import { TabState } from "./shared";

export default function SuppliersTab({ productId }) {
  const { data, loading, error } = useProductTab(`/api/products/${productId}/supplier-prices`);
  const [drill, setDrill] = useState(null);
  const [drillRows, setDrillRows] = useState([]);
  const [drillLoading, setDrillLoading] = useState(false);

  async function openHistory(supplier) {
    setDrill(supplier);
    setDrillLoading(true);
    setDrillRows([]);
    try {
      const { data: res } = await api.get(
        `/api/products/${productId}/supplier-prices/${supplier.supplier_id}/history`
      );
      setDrillRows(res.rows || []);
    } catch (e) {
      setDrillRows([]);
    } finally {
      setDrillLoading(false);
    }
  }

  const rows = data?.rows || [];

  return (
    <TabState loading={loading} error={error} empty={rows.length === 0} emptyText="لا توجد مشتريات مسجّلة لهذا المنتج من أي مورد">
      <div className="ui-table-wrap pd-sticky-table">
        <table className="ui-table">
          <thead>
            <tr>
              <th>المورد</th>
              <th>آخر تكلفة</th>
              <th>أقل تكلفة</th>
              <th>أعلى تكلفة</th>
              <th>متوسط التكلفة</th>
              <th>الكمية المشتراة</th>
              <th>عدد المشتريات</th>
              <th>آخر شراء</th>
              <th>رقم الفاتورة</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.supplier_id}>
                <td>
                  <span className="pd-supplier-name">{r.supplier_name}</span>
                  {r.is_best ? <StatusBadge tone="green" noDot>أفضل سعر</StatusBadge> : null}
                </td>
                <td className="num">{r.last_purchase_cost != null ? ils(r.last_purchase_cost) : "—"}</td>
                <td className="num">{ils(r.min_cost)}</td>
                <td className="num">{ils(r.max_cost)}</td>
                <td className="num">{ils(r.avg_cost)}</td>
                <td className="num">{num(r.total_quantity, 0)}</td>
                <td className="num">{r.purchase_count}</td>
                <td>{dateOnly(r.last_purchase_date)}</td>
                <td>{r.invoice_number != null ? `#${r.invoice_number}` : "—"}</td>
                <td>
                  <SecondaryButton size="sm" type="button" onClick={() => openHistory(r)}>
                    سجل الشراء
                  </SecondaryButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        open={!!drill}
        onClose={() => setDrill(null)}
        size="lg"
        title={drill ? `سجل شراء — ${drill.supplier_name}` : ""}
      >
        {drillLoading ? (
          <p className="pd-muted">جاري التحميل…</p>
        ) : drillRows.length === 0 ? (
          <p className="pd-muted">لا توجد فواتير.</p>
        ) : (
          <div className="ui-table-wrap pd-sticky-table">
            <table className="ui-table">
              <thead>
                <tr><th>رقم الفاتورة</th><th>التاريخ</th><th>الكمية</th><th>تكلفة الوحدة</th><th>الإجمالي</th></tr>
              </thead>
              <tbody>
                {drillRows.map((d) => (
                  <tr key={d.invoice_id}>
                    <td>#{d.invoice_number ?? d.invoice_id}</td>
                    <td>{dateOnly(d.invoice_date)}</td>
                    <td className="num">{num(d.quantity, 0)}</td>
                    <td className="num">{ils(d.unit_cost)}</td>
                    <td className="num">{ils(d.line_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </TabState>
  );
}
