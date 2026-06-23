import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { dateOnly, todayISO } from "../utils/format";
import {
  PageHeader, Button, DataTable, Modal, Tabs, StatusPill,
  FormField, FormGrid, Input, Select, Textarea, useToast, ReportToolbar,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";

const SALES_STATUS = { pending: "قيد الانتظار", out: "خرجت للتوصيل", delivered: "تم التسليم", cancelled: "ملغاة" };
const RECV_STATUS = { pending: "قيد الانتظار", received: "تم الاستلام", cancelled: "ملغاة" };
const TONE = { pending: "orange", out: "blue", delivered: "green", received: "green", cancelled: "red" };

export default function Deliveries() {
  const toast = useToast();
  const [tab, setTab] = useState("sales");
  const [sales, setSales] = useState([]);
  const [recv, setRecv] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({});

  const loadRefs = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([
        api.get("/api/customers", { headers: getAuthHeaders() }),
        api.get("/api/suppliers", { headers: getAuthHeaders() }),
      ]);
      setCustomers(c.data); setSuppliers(s.data);
    } catch { /* */ }
  }, []);

  const load = useCallback(async (which) => {
    setLoading(true);
    try {
      const path = which === "sales" ? "/api/deliveries/sales" : "/api/deliveries/receivings";
      const { data } = await api.get(path, { headers: getAuthHeaders() });
      if (which === "sales") setSales(data); else setRecv(data);
    } catch { toast.error("تعذّر التحميل"); } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { loadRefs(); }, [loadRefs]);
  useEffect(() => { load(tab); }, [tab, load]);

  function openForm() {
    setForm(tab === "sales"
      ? { customer_id: "", driver: "", vehicle: "", address: "", delivery_date: todayISO(), notes: "" }
      : { supplier_id: "", purchase_invoice_id: "", driver: "", vehicle: "", received_date: todayISO(), notes: "" });
    setShow(true);
  }

  async function save() {
    try {
      const path = tab === "sales" ? "/api/deliveries/sales" : "/api/deliveries/receivings";
      await api.post(path, form, { headers: getAuthHeaders() });
      toast.success("تم الحفظ"); setShow(false); load(tab);
    } catch (e) { toast.error(e.response?.data?.error || "فشل الحفظ"); }
  }

  async function setStatus(which, id, status) {
    try {
      const path = which === "sales" ? `/api/deliveries/sales/${id}/status` : `/api/deliveries/receivings/${id}/status`;
      await api.patch(path, { status }, { headers: getAuthHeaders() });
      toast.success("تم تحديث الحالة"); load(tab);
    } catch (e) { toast.error(e.response?.data?.error || "فشل"); }
  }

  async function remove(which, id) {
    if (!window.confirm("حذف السجل؟")) return;
    try {
      const path = which === "sales" ? `/api/deliveries/sales/${id}` : `/api/deliveries/receivings/${id}`;
      await api.delete(path, { headers: getAuthHeaders() });
      toast.success("تم الحذف"); load(tab);
    } catch { toast.error("فشل"); }
  }

  const f = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));

  const salesCols = [
    { key: "delivery_no", header: "رقم", value: (r) => `#${r.delivery_no ?? r.id}`, render: (r) => `#${r.delivery_no ?? r.id}` },
    { key: "customer_name", header: "العميل", value: (r) => r.customer_name || "—", render: (r) => r.customer_name || "—" },
    { key: "driver", header: "السائق", value: (r) => r.driver || "—", render: (r) => r.driver || "—" },
    { key: "vehicle", header: "المركبة", value: (r) => r.vehicle || "—", render: (r) => r.vehicle || "—" },
    { key: "delivery_date", header: "التاريخ", value: (r) => dateOnly(r.delivery_date), render: (r) => dateOnly(r.delivery_date) },
    { key: "status", header: "الحالة", value: (r) => SALES_STATUS[r.status], render: (r) => <StatusPill tone={TONE[r.status]}>{SALES_STATUS[r.status]}</StatusPill> },
    {
      key: "actions", header: "إجراءات", render: (r) => (
        <div className="ui-table__actions">
          {r.status === "pending" && <Button variant="ghost" size="sm" onClick={() => setStatus("sales", r.id, "out")}>خرجت</Button>}
          {r.status === "out" && <Button variant="outline" size="sm" icon="check" onClick={() => setStatus("sales", r.id, "delivered")}>تسليم</Button>}
          {r.status !== "delivered" && r.status !== "cancelled" && <Button variant="ghost" size="sm" onClick={() => setStatus("sales", r.id, "cancelled")}>إلغاء</Button>}
          <Button variant="ghost" size="sm" icon="trash" onClick={() => remove("sales", r.id)} />
        </div>
      ),
    },
  ];

  const recvCols = [
    { key: "receiving_no", header: "رقم", value: (r) => `#${r.receiving_no ?? r.id}`, render: (r) => `#${r.receiving_no ?? r.id}` },
    { key: "supplier_name", header: "المورد", value: (r) => r.supplier_name || "—", render: (r) => r.supplier_name || "—" },
    { key: "driver", header: "السائق", value: (r) => r.driver || "—", render: (r) => r.driver || "—" },
    { key: "vehicle", header: "المركبة", value: (r) => r.vehicle || "—", render: (r) => r.vehicle || "—" },
    { key: "received_date", header: "التاريخ", value: (r) => dateOnly(r.received_date), render: (r) => dateOnly(r.received_date) },
    { key: "status", header: "الحالة", value: (r) => RECV_STATUS[r.status], render: (r) => <StatusPill tone={TONE[r.status]}>{RECV_STATUS[r.status]}</StatusPill> },
    {
      key: "actions", header: "إجراءات", render: (r) => (
        <div className="ui-table__actions">
          {r.status === "pending" && <Button variant="outline" size="sm" icon="check" onClick={() => setStatus("recv", r.id, "received")}>استلام</Button>}
          {r.status !== "received" && r.status !== "cancelled" && <Button variant="ghost" size="sm" onClick={() => setStatus("recv", r.id, "cancelled")}>إلغاء</Button>}
          <Button variant="ghost" size="sm" icon="trash" onClick={() => remove("recv", r.id)} />
        </div>
      ),
    },
  ];

  const reportConfig = useMemo(() => {
    if (tab === "sales") {
      return {
        title: "توصيل المبيعات",
        columns: pickExportColumns(salesCols),
        rows: sales,
        filename: "sales-deliveries",
      };
    }
    return {
      title: "استلام المشتريات",
      columns: pickExportColumns(recvCols),
      rows: recv,
      filename: "purchase-receivings",
    };
  }, [tab, sales, recv]);

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader icon="deliveries" title="التوصيل والاستلام" subtitle="توصيل المبيعات واستلام المشتريات"
        actions={
          <>
            <ReportToolbar
              title={reportConfig.title}
              columns={reportConfig.columns}
              rows={reportConfig.rows}
              filename={reportConfig.filename}
              disabled={loading}
            />
            <Button icon="plus" onClick={openForm}>{tab === "sales" ? "توصيل جديد" : "استلام جديد"}</Button>
          </>
        } />

      <Tabs active={tab} onChange={setTab} tabs={[
        { id: "sales", label: "توصيل المبيعات", icon: "deliveries" },
        { id: "receivings", label: "استلام المشتريات", icon: "purchases" },
      ]} />

      <DataTable columns={tab === "sales" ? salesCols : recvCols} rows={tab === "sales" ? sales : recv} loading={loading} emptyIcon="deliveries" empty="لا توجد سجلات" />

      <Modal open={show} title={tab === "sales" ? "توصيل مبيعات جديد" : "استلام مشتريات جديد"} onClose={() => setShow(false)}
        footer={<><Button onClick={save}>حفظ</Button><Button variant="secondary" onClick={() => setShow(false)}>إلغاء</Button></>}>
        <FormGrid>
          {tab === "sales" ? (
            <>
              <FormField label="العميل">
                <Select value={form.customer_id || ""} onChange={f("customer_id")}>
                  <option value="">— اختر —</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </FormField>
              <FormField label="رقم الفاتورة (اختياري)"><Input value={form.transaction_id || ""} onChange={f("transaction_id")} /></FormField>
              <FormField label="العنوان" className="ui-field--full"><Input value={form.address || ""} onChange={f("address")} /></FormField>
              <FormField label="التاريخ"><Input type="date" value={form.delivery_date || ""} onChange={f("delivery_date")} /></FormField>
            </>
          ) : (
            <>
              <FormField label="المورد">
                <Select value={form.supplier_id || ""} onChange={f("supplier_id")}>
                  <option value="">— اختر —</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </FormField>
              <FormField label="رقم فاتورة الشراء (اختياري)"><Input value={form.purchase_invoice_id || ""} onChange={f("purchase_invoice_id")} /></FormField>
              <FormField label="التاريخ"><Input type="date" value={form.received_date || ""} onChange={f("received_date")} /></FormField>
            </>
          )}
          <FormField label="السائق"><Input value={form.driver || ""} onChange={f("driver")} /></FormField>
          <FormField label="المركبة"><Input value={form.vehicle || ""} onChange={f("vehicle")} /></FormField>
          <FormField label="ملاحظات" className="ui-field--full"><Textarea value={form.notes || ""} onChange={f("notes")} /></FormField>
        </FormGrid>
      </Modal>
    </div>
  );
}
