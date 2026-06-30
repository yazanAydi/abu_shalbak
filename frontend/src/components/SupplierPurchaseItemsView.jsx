import { useCallback, useEffect, useState } from "react";
import api from "../apiClient";
import { ils, dateOnly } from "../utils/format";
import { DataTable } from "./ui";

const itemColumns = [
  { key: "product_name", header: "الصنف", value: (it) => it.product_name, render: (it) => it.product_name || "—" },
  { key: "barcode", header: "الباركود", value: (it) => it.barcode || "—", render: (it) => it.barcode || "—" },
  { key: "quantity", header: "الكمية", align: "left", className: "num", render: (it) => it.quantity },
  { key: "unit_cost", header: "سعر الوحدة", align: "left", className: "num", render: (it) => ils(it.unit_cost) },
  { key: "line_total", header: "الإجمالي", align: "left", className: "num", render: (it) => ils(it.line_total) },
];

/**
 * @param {{ supplierId: number | null }} props
 */
export default function SupplierPurchaseItemsView({ supplierId }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [invoices, setInvoices] = useState([]);

  const load = useCallback(async () => {
    if (!supplierId) return;
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get(`/api/suppliers/${supplierId}/purchase-items`);
      setInvoices(data.invoices || []);
    } catch (e) {
      setError(e.response?.data?.error || e.message || "تعذّر تحميل المشتريات");
    } finally {
      setLoading(false);
    }
  }, [supplierId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p>جاري التحميل…</p>;
  if (error) return <p style={{ color: "var(--office-danger)" }}>{error}</p>;
  if (!invoices.length) return <p>لا توجد مشتريات</p>;

  return (
    <div className="supplier-purchase-items">
      {invoices.map((inv) => (
        <div key={inv.invoice_id} style={{ marginBottom: "1.25rem" }}>
          <div
            className="detail-header"
            style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap", marginBottom: ".5rem" }}
          >
            <div>التاريخ: <strong>{inv.invoice_date ? dateOnly(inv.invoice_date) : "—"}</strong></div>
            <div>رقم الفاتورة: <strong>#{inv.invoice_no}</strong></div>
            <div>الإجمالي: <strong>{ils(inv.invoice_total)}</strong></div>
          </div>
          <DataTable
            columns={itemColumns}
            rows={inv.items}
            rowKey={(it, i) => it.product_id ?? i}
            empty="لا توجد أصناف"
          />
        </div>
      ))}
    </div>
  );
}
