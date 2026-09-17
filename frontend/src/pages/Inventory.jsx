import { useCallback, useEffect, useState } from "react";
import { todayISO } from "../utils/format";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils, dateTime, dateOnly, qty as fmtQty } from "../utils/format";
import InventoryCount from "./InventoryCount";
import ProductPicker from "../components/ProductPicker";
import {
  PageHeader, Button, DataTable, Modal, Tabs, StatusPill,
  FormField, FormGrid, Input, Select, Textarea, ReportToolbar, useToast,
  FilterBar, Notice, DateField,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";
import { apiErrorMessage } from "../utils/apiError";
import QtyStepper from "../components/QtyStepper";
import { handleEnterNavKeyDown } from "../utils/focusNavigation";

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
  const [date, setDate] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState([]);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState(null);
  const [editId, setEditId] = useState(null);

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
      const payload = {
        adjustment_type: type, adjustment_date: date, notes,
        items: items.map((it) => ({ product_id: it.product_id, quantity: Number(it.quantity), unit_cost: Number(it.unit_cost) || null })),
      };
      if (editId) {
        await api.put(`/api/inventory/adjustments/${editId}`, payload, { headers: getAuthHeaders() });
        if (post) await api.post(`/api/inventory/adjustments/${editId}/post`, {}, { headers: getAuthHeaders() });
        toast.success(post ? "تم الترحيل" : "تم تعديل المسودة");
      } else {
        await api.post("/api/inventory/adjustments", { ...payload, post }, { headers: getAuthHeaders() });
        toast.success(post ? "تم الترحيل" : "حُفظت كمسودة");
      }
      setShow(false); setItems([]); setNotes(""); setEditId(null); load();
    } catch (e) { toast.error(apiErrorMessage(e, "فشل الحفظ")); }
    finally { setSaving(false); }
  }

  async function post(id) {
    if (!window.confirm("ترحيل التسوية سيحدّث المخزون. متابعة؟")) return;
    try { await api.post(`/api/inventory/adjustments/${id}/post`, {}, { headers: getAuthHeaders() }); toast.success("تم الترحيل"); load(); }
    catch (e) { toast.error(apiErrorMessage(e, "فشل")); }
  }
  async function remove(id) {
    if (!window.confirm("حذف المسودة؟")) return;
    try { await api.delete(`/api/inventory/adjustments/${id}`, { headers: getAuthHeaders() }); toast.success("تم الحذف"); load(); }
    catch (e) { toast.error(apiErrorMessage(e, "فشل")); }
  }
  async function openDetail(id) {
    try {
      const { data } = await api.get(`/api/inventory/adjustments/${id}`, { headers: getAuthHeaders() });
      if (data.status === "draft") fillFormFromDoc(data);
      else setDetail(data);
    } catch { /* */ }
  }

  function fillFormFromDoc(data) {
    setType(data.adjustment_type);
    setDate(data.adjustment_date?.slice(0, 10) || todayISO());
    setNotes(data.notes || "");
    setItems((data.items || []).map((it) => ({
      product_id: it.product_id,
      name: it.name,
      quantity: it.quantity,
      unit_cost: it.unit_cost ?? 0,
    })));
    setEditId(data.id);
    setShow(true);
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
        {r.status === "draft" && <Button variant="ghost" size="sm" icon="trash" iconOnly aria-label="حذف" onClick={() => remove(r.id)} />}
      </div>
    ) },
  ];

  return (
    <>
      <FilterBar
        actions={
          <>
            <Button icon="plus" onClick={() => { setEditId(null); setType("in"); setDate(todayISO()); setNotes(""); setItems([]); setShow(true); }}>تسوية جديدة</Button>
            <ReportToolbar title="تسويات المخزون" columns={pickExportColumns(adjColumns)} rows={list} filename="inventory-adjustments" disabled={loading} />
          </>
        }
      />
      <DataTable
        loading={loading}
        columns={adjColumns}
        rows={list}
        emptyIcon="inventory"
        empty="لا توجد تسويات"
      />

      <Modal open={show} title={editId ? "تعديل التسوية" : "تسوية مخزون"} onClose={() => { setShow(false); setEditId(null); }} size="lg"
        footer={<>
          <Button onClick={() => save(true)} disabled={saving}>{editId ? "ترحيل" : "ترحيل مباشر"}</Button>
          <Button variant="secondary" onClick={() => save(false)} disabled={saving}>{editId ? "حفظ التعديلات" : "حفظ كمسودة"}</Button>
          <Button variant="ghost" onClick={() => { setShow(false); setEditId(null); }}>إلغاء</Button>
        </>}>
        <FormGrid>
          <FormField label="نوع التسوية"><Select value={type} onChange={(e) => setType(e.target.value)}>{Object.entries(ADJ_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></FormField>
          <FormField label="التاريخ"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></FormField>
        </FormGrid>
        <Notice tone="info" className="ui-mt-md">
          {type === "correction" ? "للتصحيح: أدخل كمية موجبة للزيادة أو سالبة للنقص." : "أدخل الكمية (موجبة) وسيُطبَّق اتجاهها تلقائياً حسب النوع."}
        </Notice>
        <div data-enter-nav="" onKeyDown={handleEnterNavKeyDown}>
        <div className="ui-mt-md"><ProductPicker onPick={addProduct} scope="retail" /></div>
        <div className="ui-table-wrap ui-mt-md">
          <table className="ui-table">
            <thead><tr><th className="ui-table__col--name">الصنف</th><th>الكمية</th><th>الكلفة</th><th></th></tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={4} className="ui-table__empty-cell">أضف أصنافاً</td></tr>}
              {items.map((it, i) => (
                <tr key={it.product_id}>
                  <td className="ui-table__col--name">{it.name}</td>
                  <td><QtyStepper className="ui-input ui-input--narrow" min={0} value={it.quantity} onChange={(e) => upd(i, "quantity", e.target.value)} /></td>
                  <td><input className="ui-input ui-input--narrow" type="number" step="0.01" value={it.unit_cost} onChange={(e) => upd(i, "unit_cost", e.target.value)} /></td>
                  <td><Button variant="ghost" size="sm" icon="trash" iconOnly aria-label="حذف" onClick={() => setItems((p) => p.filter((_, idx) => idx !== i))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </div>
        <FormField label="ملاحظات"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></FormField>
      </Modal>

      <Modal open={!!detail} title={detail ? `تسوية #${detail.adjustment_no ?? detail.id}` : ""} onClose={() => setDetail(null)}>
        {detail && (
          <DataTable
            columns={[
              { key: "name", header: "الصنف", nameColumn: true, wrap: true },
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

function Movements({ membership = null }) {
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
      if (membership) params.set("membership", membership);
      const { data } = await api.get(`/api/inventory/movements?${params}`, { headers: getAuthHeaders() });
      setRows(data);
    } catch { toast.error("تعذّر التحميل"); } finally { setLoading(false); }
  }, [type, from, to, toast, membership]);
  useEffect(() => { load(); }, [load]);

  const moveColumns = [
    { key: "created_at", header: "التاريخ", value: (r) => dateTime(r.created_at), render: (r) => dateTime(r.created_at) },
    { key: "product_name", header: "الصنف", nameColumn: true, wrap: true },
    { key: "movement_type", header: "النوع", value: (r) => MOVE_LABELS[r.movement_type] || r.movement_type, render: (r) => <StatusPill tone={MOVE_TONE[r.movement_type] || "neutral"} noDot>{MOVE_LABELS[r.movement_type] || r.movement_type}</StatusPill> },
    { key: "quantity", header: "الكمية", value: (r) => `${r.quantity > 0 ? "+" : ""}${fmtQty(r.quantity)}`, render: (r) => <span className={r.quantity > 0 ? "positive" : "negative"}>{r.quantity > 0 ? "+" : ""}{fmtQty(r.quantity)}</span> },
    { key: "notes", header: "ملاحظات", value: (r) => r.notes || "—", render: (r) => r.notes || "—" },
    { key: "created_by_name", header: "بواسطة", value: (r) => r.created_by_name || "—", render: (r) => r.created_by_name || "—" },
  ];

  return (
    <>
      <FilterBar
        actions={<ReportToolbar title="حركة المخزون" columns={moveColumns} rows={rows} filename="inventory-movements" disabled={loading} />}
      >
        <FormField label="النوع">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">كل الأنواع</option>
            {Object.entries(MOVE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </FormField>
        <FormField label="من تاريخ" className="ui-field--date">
          <DateField value={from} onChange={(e) => setFrom(e.target.value)} />
        </FormField>
        <FormField label="إلى تاريخ" className="ui-field--date">
          <DateField value={to} onChange={(e) => setTo(e.target.value)} />
        </FormField>
      </FilterBar>
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
    { key: "name", header: "الصنف", nameColumn: true, wrap: true },
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
      <Notice tone="info">
        البيع تحت الصفر مسموح — هذه القائمة للمتابعة والتسوية فقط ({count} صنف).
      </Notice>
      <ReportToolbar title="مخزون سالب" columns={columns} rows={rows} filename="negative-stock" disabled={loading} />
      <DataTable loading={loading} columns={columns} rows={rows} emptyIcon="inventory" empty="لا يوجد مخزون سالب" />
    </>
  );
}

function Batches({ membership = null }) {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ product_id: null, name: "", batch_no: "", expiry_date: "", quantity: "", cost: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (membership) params.set("membership", membership);
      const { data } = await api.get(`/api/inventory/batches?${params}`, { headers: getAuthHeaders() });
      setRows(data);
    } catch { toast.error("تعذّر التحميل"); } finally { setLoading(false); }
  }, [toast, membership]);
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
    } catch (e) { toast.error(apiErrorMessage(e, "فشل")); }
  }
  async function remove(id) {
    if (!window.confirm("حذف الدفعة؟")) return;
    try { await api.delete(`/api/inventory/batches/${id}`, { headers: getAuthHeaders() }); toast.success("تم الحذف"); load(); }
    catch { toast.error("فشل"); }
  }

  const batchColumns = [
    { key: "product_name", header: "الصنف", nameColumn: true, wrap: true },
    { key: "batch_no", header: "رقم الدفعة", value: (r) => r.batch_no || "—", render: (r) => r.batch_no || "—" },
    { key: "expiry_date", header: "الصلاحية", value: (r) => dateOnly(r.expiry_date), render: (r) => dateOnly(r.expiry_date) },
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
    { key: "actions", header: "", render: (r) => <Button variant="ghost" size="sm" icon="trash" iconOnly aria-label="حذف" onClick={() => remove(r.id)} /> },
  ];

  return (
    <>
      <FilterBar
        actions={
          <>
            <Button icon="plus" onClick={() => setShow(true)}>دفعة جديدة</Button>
            <ReportToolbar title="دفعات المخزون" columns={pickExportColumns(batchColumns)} rows={rows} filename="inventory-batches" disabled={loading} />
          </>
        }
      />
      <DataTable
        loading={loading}
        columns={batchColumns}
        rows={rows}
        emptyIcon="expiry"
        empty="لا توجد دفعات"
      />

      <Modal open={show} title="دفعة جديدة" onClose={() => setShow(false)}
        footer={<><Button onClick={save}>حفظ</Button><Button variant="secondary" onClick={() => setShow(false)}>إلغاء</Button></>}>
        <div className="ui-mt-md">
          <ProductPicker
            onPick={(p) => setForm((f) => ({ ...f, product_id: p.id, name: p.name }))}
            scope={membership === "bakery" ? null : "retail"}
            membership={membership === "bakery" ? "bakery" : null}
            placeholder={membership === "bakery" ? "ابحث عن صنف مخبز…" : undefined}
          />
          {form.name && <p className="ui-field__hint">المنتج: <strong>{form.name}</strong></p>}
        </div>
        <FormGrid>
          <FormField label="رقم الدفعة"><Input value={form.batch_no} onChange={(e) => setForm((f) => ({ ...f, batch_no: e.target.value }))} /></FormField>
          <FormField label="تاريخ الصلاحية"><Input type="date" value={form.expiry_date} onChange={(e) => setForm((f) => ({ ...f, expiry_date: e.target.value }))} /></FormField>
          <FormField label="الكمية"><QtyStepper min={0} value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} /></FormField>
          <FormField label="الكلفة"><Input type="number" step="0.01" value={form.cost} onChange={(e) => setForm((f) => ({ ...f, cost: e.target.value }))} /></FormField>
        </FormGrid>
      </Modal>
    </>
  );
}

export default function Inventory({
  workspace = null,
  initialTab = "count",
  allowedTabs = null,
  title,
  subtitle,
}) {
  const isBakery = workspace === "bakery";
  const [tab, setTab] = useState(initialTab);
  const membership = isBakery ? "bakery" : null;
  const tabs = [
    { id: "count", label: "الجرد", icon: "inventory" },
    { id: "adjustments", label: "التسويات", icon: "edit" },
    { id: "movements", label: "حركة المخزون", icon: "refunds" },
    { id: "negative", label: "مخزون سالب", icon: "alert" },
    { id: "batches", label: "الدفعات والصلاحية", icon: "expiry" },
  ].filter((item) => !allowedTabs || allowedTabs.includes(item.id));
  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        icon="inventory"
        title={title || (isBakery ? "حركة مخزون المخبز" : "المخزون")}
        subtitle={subtitle || (isBakery ? "حركات الشراء والبيع والمرتجع والجرد والتسوية لأصناف المخبز" : "الجرد، التسويات، حركة المخزون والدفعات")}
      />
      {tabs.length > 1 ? (
        <Tabs active={tab} onChange={setTab} tabs={tabs} />
      ) : null}
      {tab === "count" && <InventoryCount embedded />}
      {tab === "adjustments" && <Adjustments />}
      {tab === "movements" && <Movements membership={membership} />}
      {tab === "negative" && <NegativeStock />}
      {tab === "batches" && <Batches membership={membership} />}
    </div>
  );
}

export { Batches, Movements };
