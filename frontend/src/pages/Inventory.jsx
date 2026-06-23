import { useCallback, useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils, dateTime, dateOnly, qty as fmtQty } from "../utils/format";
import InventoryCount from "./InventoryCount";
import ProductPicker from "../components/ProductPicker";
import {
  PageHeader, Button, DataTable, Modal, Tabs, StatusPill,
  FormField, FormGrid, Input, Select, Textarea, Icon, ReportToolbar, useToast,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";

const ADJ_LABELS = { in: "إدخال مخزون", out: "إخراج مخزون", damage: "تالف", consumption: "استهلاك", correction: "تصحيح" };
const MOVE_LABELS = {
  sale: "بيع", refund: "استرجاع", purchase: "شراء", purchase_return: "مرتجع شراء",
  adjust_in: "إدخال", adjust_out: "إخراج", damage: "تالف", consumption: "استهلاك",
  correction: "تصحيح", count: "جرد", transfer_in: "تحويل وارد", transfer_out: "تحويل صادر", opening: "افتتاحي",
};
const MOVE_TONE = { sale: "blue", refund: "orange", purchase: "green", purchase_return: "red", adjust_in: "green", adjust_out: "red", damage: "red", consumption: "orange", correction: "neutral" };

function Adjustments() {
  const toast = useToast();
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [show, setShow] = useState(false);
  const [type, setType] = useState("in");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState([]);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { const { data } = await api.get("/api/inventory/adjustments", { headers: getAuthHeaders() }); setList(data); }
    catch { toast.error("تعذّر التحميل"); } finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  function addProduct(p) {
    setItems((prev) => prev.some((x) => x.product_id === p.id) ? prev : [...prev, { product_id: p.id, name: p.name, quantity: 1, unit_cost: Number(p.cost) || 0 }]);
  }
  const upd = (i, k, v) => setItems((prev) => prev.map((x, idx) => idx === i ? { ...x, [k]: v } : x));

  async function save(post) {
    if (items.length === 0) { toast.error("أضف أصنافاً"); return; }
    setSaving(true);
    try {
      await api.post("/api/inventory/adjustments", {
        adjustment_type: type, adjustment_date: date, notes, post,
        items: items.map((it) => ({ product_id: it.product_id, quantity: Number(it.quantity), unit_cost: Number(it.unit_cost) || null })),
      }, { headers: getAuthHeaders() });
      toast.success(post ? "تم الترحيل" : "حُفظت كمسودة");
      setShow(false); setItems([]); setNotes(""); load();
    } catch (e) { toast.error(e.response?.data?.error || "فشل الحفظ"); }
    finally { setSaving(false); }
  }

  async function post(id) {
    if (!window.confirm("ترحيل التسوية سيحدّث المخزون. متابعة؟")) return;
    try { await api.post(`/api/inventory/adjustments/${id}/post`, {}, { headers: getAuthHeaders() }); toast.success("تم الترحيل"); load(); }
    catch (e) { toast.error(e.response?.data?.error || "فشل"); }
  }
  async function remove(id) {
    if (!window.confirm("حذف المسودة؟")) return;
    try { await api.delete(`/api/inventory/adjustments/${id}`, { headers: getAuthHeaders() }); toast.success("تم الحذف"); load(); }
    catch (e) { toast.error(e.response?.data?.error || "فشل"); }
  }
  async function openDetail(id) {
    try { const { data } = await api.get(`/api/inventory/adjustments/${id}`, { headers: getAuthHeaders() }); setDetail(data); } catch { /* */ }
  }

  const adjColumns = [
    { key: "adjustment_no", header: "رقم", value: (r) => `#${r.adjustment_no ?? r.id}`, render: (r) => `#${r.adjustment_no ?? r.id}` },
    { key: "adjustment_type", header: "النوع", value: (r) => ADJ_LABELS[r.adjustment_type] || r.adjustment_type, render: (r) => ADJ_LABELS[r.adjustment_type] || r.adjustment_type },
    { key: "adjustment_date", header: "التاريخ", value: (r) => dateOnly(r.adjustment_date), render: (r) => dateOnly(r.adjustment_date) },
    { key: "item_count", header: "الأصناف" },
    { key: "status", header: "الحالة", value: (r) => (r.status === "posted" ? "مرحّلة" : "مسودة"), render: (r) => <StatusPill tone={r.status === "posted" ? "green" : "neutral"}>{r.status === "posted" ? "مرحّلة" : "مسودة"}</StatusPill> },
    { key: "actions", header: "إجراءات", render: (r) => (
      <div className="ui-table__actions">
        <Button variant="ghost" size="sm" onClick={() => openDetail(r.id)}>عرض</Button>
        {r.status === "draft" && <Button variant="outline" size="sm" icon="check" onClick={() => post(r.id)}>ترحيل</Button>}
        {r.status === "draft" && <Button variant="ghost" size="sm" icon="trash" onClick={() => remove(r.id)} />}
      </div>
    ) },
  ];

  return (
    <>
      <div className="ui-toolbar" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <ReportToolbar title="تسويات المخزون" columns={pickExportColumns(adjColumns)} rows={list} filename="inventory-adjustments" disabled={loading} />
        <Button icon="plus" onClick={() => { setShow(true); setItems([]); }}>تسوية جديدة</Button>
      </div>
      <DataTable
        loading={loading}
        columns={adjColumns}
        rows={list}
        emptyIcon="inventory"
        empty="لا توجد تسويات"
      />

      <Modal open={show} title="تسوية مخزون" onClose={() => setShow(false)} size="lg"
        footer={<>
          <Button onClick={() => save(true)} disabled={saving}>ترحيل مباشر</Button>
          <Button variant="secondary" onClick={() => save(false)} disabled={saving}>حفظ كمسودة</Button>
          <Button variant="ghost" onClick={() => setShow(false)}>إلغاء</Button>
        </>}>
        <FormGrid>
          <FormField label="نوع التسوية"><Select value={type} onChange={(e) => setType(e.target.value)}>{Object.entries(ADJ_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></FormField>
          <FormField label="التاريخ"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></FormField>
        </FormGrid>
        <p className="ui-field__hint" style={{ margin: "0.5rem 0" }}>
          {type === "correction" ? "للتصحيح: أدخل كمية موجبة للزيادة أو سالبة للنقص." : "أدخل الكمية (موجبة) وسيُطبَّق اتجاهها تلقائياً حسب النوع."}
        </p>
        <div style={{ marginBottom: "0.75rem" }}><ProductPicker onPick={addProduct} /></div>
        <div className="ui-table-wrap" style={{ marginBottom: "0.75rem" }}>
          <table className="ui-table">
            <thead><tr><th>الصنف</th><th>الكمية</th><th>الكلفة</th><th></th></tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={4} style={{ textAlign: "center", color: "var(--office-panel-muted)", padding: "1rem" }}>أضف أصنافاً</td></tr>}
              {items.map((it, i) => (
                <tr key={it.product_id}>
                  <td>{it.name}</td>
                  <td><input className="ui-input" style={{ width: 100 }} type="number" step="0.001" value={it.quantity} onChange={(e) => upd(i, "quantity", e.target.value)} /></td>
                  <td><input className="ui-input" style={{ width: 100 }} type="number" step="0.01" value={it.unit_cost} onChange={(e) => upd(i, "unit_cost", e.target.value)} /></td>
                  <td><Button variant="ghost" size="sm" icon="trash" onClick={() => setItems((p) => p.filter((_, idx) => idx !== i))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <FormField label="ملاحظات"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></FormField>
      </Modal>

      <Modal open={!!detail} title={detail ? `تسوية #${detail.adjustment_no ?? detail.id}` : ""} onClose={() => setDetail(null)}>
        {detail && (
          <DataTable
            columns={[
              { key: "name", header: "الصنف" },
              { key: "quantity", header: "الكمية", align: "left", render: (it) => fmtQty(it.quantity) },
              { key: "unit_cost", header: "الكلفة", align: "left", className: "num", render: (it) => (it.unit_cost != null ? ils(it.unit_cost) : "—") },
            ]}
            rows={detail.items || []}
            empty="لا توجد أصناف"
          />
        )}
      </Modal>
    </>
  );
}

function Movements() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (type) params.set("type", type);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const { data } = await api.get(`/api/inventory/movements?${params}`, { headers: getAuthHeaders() });
      setRows(data);
    } catch { toast.error("تعذّر التحميل"); } finally { setLoading(false); }
  }, [type, from, to, toast]);
  useEffect(() => { load(); }, [load]);

  const moveColumns = [
    { key: "created_at", header: "التاريخ", value: (r) => dateTime(r.created_at), render: (r) => dateTime(r.created_at) },
    { key: "product_name", header: "الصنف" },
    { key: "movement_type", header: "النوع", value: (r) => MOVE_LABELS[r.movement_type] || r.movement_type, render: (r) => <StatusPill tone={MOVE_TONE[r.movement_type] || "neutral"} noDot>{MOVE_LABELS[r.movement_type] || r.movement_type}</StatusPill> },
    { key: "quantity", header: "الكمية", value: (r) => `${r.quantity > 0 ? "+" : ""}${fmtQty(r.quantity)}`, render: (r) => <span className={r.quantity > 0 ? "positive" : "negative"}>{r.quantity > 0 ? "+" : ""}{fmtQty(r.quantity)}</span> },
    { key: "notes", header: "ملاحظات", value: (r) => r.notes || "—", render: (r) => r.notes || "—" },
    { key: "created_by_name", header: "بواسطة", value: (r) => r.created_by_name || "—", render: (r) => r.created_by_name || "—" },
  ];

  return (
    <>
      <div className="ui-toolbar" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <ReportToolbar title="حركة المخزون" columns={moveColumns} rows={rows} filename="inventory-movements" disabled={loading} />
        <Select value={type} onChange={(e) => setType(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="">كل الأنواع</option>
          {Object.entries(MOVE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ maxWidth: 170 }} />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ maxWidth: 170 }} />
      </div>
      <DataTable
        loading={loading}
        columns={moveColumns}
        rows={rows}
        emptyIcon="inventory"
        empty="لا توجد حركات"
      />
    </>
  );
}

function NegativeStock() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/api/inventory/negative-stock", { headers: getAuthHeaders() });
      const payload = data?.data ?? data;
      setRows(Array.isArray(payload?.products) ? payload.products : []);
      setCount(Number(payload?.count) || 0);
    } catch {
      toast.error("تعذّر تحميل المخزون السالب");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const columns = [
    { key: "barcode", header: "الباركود" },
    { key: "name", header: "الصنف" },
    { key: "category", header: "التصنيف", value: (r) => r.category || "—", render: (r) => r.category || "—" },
    {
      key: "stock",
      header: "المخزون",
      className: "num",
      value: (r) => fmtQty(r.stock),
      render: (r) => <span className="negative">{fmtQty(r.stock)}</span>,
    },
  ];

  return (
    <>
      <p className="ui-field__hint" style={{ marginBottom: "0.75rem" }}>
        البيع تحت الصفر مسموح في النظام — هذه القائمة للمتابعة والتسوية فقط ({count} صنف).
      </p>
      <ReportToolbar title="مخزون سالب" columns={columns} rows={rows} filename="negative-stock" disabled={loading} />
      <DataTable loading={loading} columns={columns} rows={rows} emptyIcon="inventory" empty="لا يوجد مخزون سالب" />
    </>
  );
}

function Batches() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ product_id: null, name: "", batch_no: "", expiry_date: "", quantity: "", cost: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try { const { data } = await api.get("/api/inventory/batches", { headers: getAuthHeaders() }); setRows(data); }
    catch { toast.error("تعذّر التحميل"); } finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  async function save() {
    if (!form.product_id) { toast.error("اختر منتجاً"); return; }
    try {
      await api.post("/api/inventory/batches", {
        product_id: form.product_id, batch_no: form.batch_no, expiry_date: form.expiry_date || null,
        quantity: Number(form.quantity) || 0, cost: form.cost === "" ? null : Number(form.cost),
      }, { headers: getAuthHeaders() });
      toast.success("تمت إضافة الدفعة"); setShow(false);
      setForm({ product_id: null, name: "", batch_no: "", expiry_date: "", quantity: "", cost: "" });
      load();
    } catch (e) { toast.error(e.response?.data?.error || "فشل"); }
  }
  async function remove(id) {
    if (!window.confirm("حذف الدفعة؟")) return;
    try { await api.delete(`/api/inventory/batches/${id}`, { headers: getAuthHeaders() }); toast.success("تم الحذف"); load(); }
    catch { toast.error("فشل"); }
  }

  const batchColumns = [
    { key: "product_name", header: "الصنف" },
    { key: "batch_no", header: "رقم الدفعة", value: (r) => r.batch_no || "—", render: (r) => r.batch_no || "—" },
    { key: "expiry_date", header: "الصلاحية", value: (r) => r.expiry_date || "—", render: (r) => r.expiry_date || "—" },
    { key: "quantity", header: "الكمية", value: (r) => fmtQty(r.quantity), render: (r) => fmtQty(r.quantity) },
    {
      key: "days_until_expiry", header: "الحالة",
      value: (r) => {
        if (r.expiry_date == null) return "—";
        const d = r.days_until_expiry;
        if (d < 0) return "منتهية";
        if (d <= 30) return `${d} يوم`;
        return "سارية";
      },
      render: (r) => {
        if (r.expiry_date == null) return "—";
        const d = r.days_until_expiry;
        if (d < 0) return <StatusPill tone="red">منتهية</StatusPill>;
        if (d <= 30) return <StatusPill tone="orange">{d} يوم</StatusPill>;
        return <StatusPill tone="green">سارية</StatusPill>;
      },
    },
    { key: "actions", header: "", render: (r) => <Button variant="ghost" size="sm" icon="trash" onClick={() => remove(r.id)} /> },
  ];

  return (
    <>
      <div className="ui-toolbar" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <ReportToolbar title="دفعات المخزون" columns={pickExportColumns(batchColumns)} rows={rows} filename="inventory-batches" disabled={loading} />
        <Button icon="plus" onClick={() => setShow(true)}>دفعة جديدة</Button>
      </div>
      <DataTable
        loading={loading}
        columns={batchColumns}
        rows={rows}
        emptyIcon="expiry"
        empty="لا توجد دفعات"
      />

      <Modal open={show} title="دفعة جديدة" onClose={() => setShow(false)}
        footer={<><Button onClick={save}>حفظ</Button><Button variant="secondary" onClick={() => setShow(false)}>إلغاء</Button></>}>
        <div style={{ marginBottom: "0.75rem" }}>
          <ProductPicker onPick={(p) => setForm((f) => ({ ...f, product_id: p.id, name: p.name }))} />
          {form.name && <p className="ui-field__hint" style={{ marginTop: 4 }}>المنتج: <strong>{form.name}</strong></p>}
        </div>
        <FormGrid>
          <FormField label="رقم الدفعة"><Input value={form.batch_no} onChange={(e) => setForm((f) => ({ ...f, batch_no: e.target.value }))} /></FormField>
          <FormField label="تاريخ الصلاحية"><Input type="date" value={form.expiry_date} onChange={(e) => setForm((f) => ({ ...f, expiry_date: e.target.value }))} /></FormField>
          <FormField label="الكمية"><Input type="number" step="0.001" value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} /></FormField>
          <FormField label="الكلفة"><Input type="number" step="0.01" value={form.cost} onChange={(e) => setForm((f) => ({ ...f, cost: e.target.value }))} /></FormField>
        </FormGrid>
      </Modal>
    </>
  );
}

export default function Inventory() {
  const [tab, setTab] = useState("count");
  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader icon="inventory" title="المخزون" subtitle="الجرد، التسويات، حركة المخزون والدفعات" />
      <Tabs active={tab} onChange={setTab} tabs={[
        { id: "count", label: "الجرد", icon: "inventory" },
        { id: "adjustments", label: "التسويات", icon: "edit" },
        { id: "movements", label: "حركة المخزون", icon: "refunds" },
        { id: "negative", label: "مخزون سالب", icon: "alert" },
        { id: "batches", label: "الدفعات والصلاحية", icon: "expiry" },
      ]} />
      {tab === "count" && <InventoryCount embedded />}
      {tab === "adjustments" && <Adjustments />}
      {tab === "movements" && <Movements />}
      {tab === "negative" && <NegativeStock />}
      {tab === "batches" && <Batches />}
    </div>
  );
}
