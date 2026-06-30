import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils, dateOnly, qty as fmtQty } from "../utils/format";
import ProductPicker from "../components/ProductPicker";
import {
  PageHeader, Button, DataTable, Modal, Tabs, StatusPill,
  FormField, FormGrid, Input, Textarea, Select, Icon, ReportToolbar, useToast,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";
import { printPurchaseDoc } from "../utils/purchaseDocPrint";

const STATUS_TONE = { draft: "neutral", posted: "green", confirmed: "blue", received: "green", cancelled: "red" };
const STATUS_LABEL = { draft: "مسودة", posted: "مرحّلة", confirmed: "مؤكد", received: "مستلم", cancelled: "ملغي" };

function selectInputOnFocus(e) {
  e.target.select();
}

function ItemEditor({ items, setItems, withVat }) {
  function addProduct(p) {
    setItems((prev) => {
      if (prev.some((x) => x.product_id === p.id)) return prev;
      return [...prev, { product_id: p.id, name: p.name, barcode: p.barcode, quantity: 1, total_cost: "", vat_rate: "" }];
    });
  }
  function update(i, key, val) {
    setItems((prev) => prev.map((x, idx) => (idx === i ? { ...x, [key]: val } : x)));
  }
  function remove(i) { setItems((prev) => prev.filter((_, idx) => idx !== i)); }

  const total = items.reduce((s, it) => s + (Number(it.total_cost) || 0), 0);

  return (
    <>
      <div style={{ marginBottom: "0.75rem" }}>
        <ProductPicker onPick={addProduct} />
      </div>
      <div className="ui-table-wrap" style={{ marginBottom: "0.75rem" }}>
        <table className="ui-table">
          <thead>
            <tr>
              <th>الصنف</th><th>الكمية</th><th>إجمالي الكلفة</th><th>كلفة الوحدة</th>{withVat && <th>ض.ق.م %</th>}<th>الإجمالي</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={withVat ? 7 : 6} style={{ textAlign: "center", color: "var(--office-panel-muted)", padding: "1rem" }}>أضف أصنافاً</td></tr>}
            {items.map((it, i) => {
              const qtyNum = Number(it.quantity) || 0;
              const totalNum = Number(it.total_cost) || 0;
              const unitCost = qtyNum > 0 ? totalNum / qtyNum : 0;
              return (
              <tr key={it.product_id}>
                <td>{it.name}</td>
                <td><input className="ui-input" style={{ width: 90 }} type="number" min="0" step="1" value={it.quantity} onFocus={selectInputOnFocus} onChange={(e) => update(i, "quantity", e.target.value)} /></td>
                <td><input className="ui-input" style={{ width: 100 }} type="number" min="0" step="0.01" placeholder="0" value={it.total_cost} onFocus={selectInputOnFocus} onChange={(e) => update(i, "total_cost", e.target.value)} /></td>
                <td className="num">{qtyNum > 0 ? ils(unitCost) : "—"}</td>
                {withVat && <td><input className="ui-input" style={{ width: 80 }} type="number" min="0" max="100" step="1" placeholder="افتراضي" value={it.vat_rate} onFocus={selectInputOnFocus} onChange={(e) => update(i, "vat_rate", e.target.value)} /></td>}
                <td className="num">{ils(totalNum)}</td>
                <td><Button variant="ghost" size="sm" icon="trash" onClick={() => remove(i)} /></td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ textAlign: "left", fontWeight: 700, fontSize: "1.05rem" }}>الإجمالي قبل الضريبة: {ils(total)}</div>
    </>
  );
}

export default function Purchases() {
  const toast = useToast();
  const [tab, setTab] = useState("invoices");
  const [suppliers, setSuppliers] = useState([]);
  const [store, setStore] = useState({});
  const [orders, setOrders] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [returns, setReturns] = useState([]);
  const [loading, setLoading] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [docDate, setDocDate] = useState(new Date().toISOString().slice(0, 10));
  const [refText, setRefText] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState([]);
  const [saving, setSaving] = useState(false);
  const [editId, setEditId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const loadSuppliers = useCallback(async () => {
    try {
      const { data } = await api.get("/api/suppliers", { headers: getAuthHeaders() });
      setSuppliers(data);
    } catch { /* ignore */ }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const { data } = await api.get("/api/settings", { headers: getAuthHeaders() });
      setStore(data || {});
    } catch { /* ignore */ }
  }, []);

  const loadList = useCallback(async (which) => {
    setLoading(true);
    try {
      const path = which === "orders" ? "/api/purchases/orders" : which === "returns" ? "/api/purchases/returns" : "/api/purchases/invoices";
      const { data } = await api.get(path, { headers: getAuthHeaders() });
      if (which === "orders") setOrders(data);
      else if (which === "returns") setReturns(data);
      else setInvoices(data);
    } catch { toast.error("تعذّر التحميل"); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { loadSuppliers(); loadSettings(); }, [loadSuppliers, loadSettings]);
  useEffect(() => { loadList(tab); }, [tab, loadList]);

  // Deep-link drill-down from the supplier statement: open the matching detail.
  useEffect(() => {
    const invoiceId = searchParams.get("invoiceId");
    const returnId = searchParams.get("returnId");
    const orderId = searchParams.get("orderId");
    if (!invoiceId && !returnId && !orderId) return;
    const which = returnId ? "returns" : orderId ? "orders" : "invoices";
    const id = returnId || orderId || invoiceId;
    setTab(which);
    openDetail(which, id);
    const next = new URLSearchParams(searchParams);
    next.delete("invoiceId");
    next.delete("returnId");
    next.delete("orderId");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openForm() {
    setEditId(null);
    setSupplierId(""); setDocDate(new Date().toISOString().slice(0, 10));
    setRefText(""); setNotes(""); setItems([]); setShowForm(true);
  }

  function fillFormFromDoc(which, data, id) {
    setSupplierId(String(data.supplier_id));
    const docDateValue = which === "returns" ? data.return_date : which === "orders" ? data.order_date : data.invoice_date;
    setDocDate(docDateValue?.slice(0, 10) || new Date().toISOString().slice(0, 10));
    setRefText(data.ref_text || "");
    setNotes(data.notes || "");
    setItems((data.items || []).map((it) => ({
      product_id: it.product_id,
      name: it.name,
      barcode: it.barcode,
      quantity: it.quantity,
      total_cost: it.total_cost,
      vat_rate: which === "invoices" && it.vat_rate != null ? Math.round(it.vat_rate * 100) : "",
    })));
    setEditId(id);
    setShowForm(true);
  }

  async function persist() {
    if (!supplierId) { toast.error("اختر المورد"); return null; }
    if (items.length === 0) { toast.error("أضف أصنافاً"); return null; }
    setSaving(true);
    const payload = {
      supplier_id: Number(supplierId),
      notes,
      items: items.map((it) => ({
        product_id: it.product_id,
        quantity: Number(it.quantity),
        total_cost: Number(it.total_cost),
        vat_rate: it.vat_rate === "" ? undefined : Number(it.vat_rate) / 100,
      })),
    };
    try {
      if (tab === "returns") payload.return_date = docDate;
      else if (tab === "invoices") { payload.invoice_date = docDate; payload.ref_text = refText; }
      else payload.order_date = docDate;
      if (editId) {
        await api.put(`/api/purchases/${tab}/${editId}`, payload, { headers: getAuthHeaders() });
        toast.success("تم تعديل المسودة");
        return editId;
      }
      const { data } = await api.post(`/api/purchases/${tab}`, payload, { headers: getAuthHeaders() });
      toast.success("تم الحفظ كمسودة");
      return data?.id ?? null;
    } catch (e) {
      toast.error(e.response?.data?.error || "فشل الحفظ");
      return null;
    } finally { setSaving(false); }
  }

  async function save() {
    const id = await persist();
    if (id == null) return;
    setShowForm(false);
    setEditId(null);
    loadList(tab);
  }

  async function saveAndPost() {
    if (!window.confirm("سيتم حفظ التعديلات ثم ترحيل المستند وتحديث المخزون وأرصدة المورد. متابعة؟")) return;
    const id = await persist();
    if (id == null) return;
    try {
      const path = tab === "returns" ? `/api/purchases/returns/${id}/post` : `/api/purchases/invoices/${id}/post`;
      await api.post(path, {}, { headers: getAuthHeaders() });
      toast.success("تم الترحيل");
      setShowForm(false);
      setEditId(null);
      loadList(tab);
    } catch (e) { toast.error(e.response?.data?.error || "فشل الترحيل"); }
  }

  async function saveAndPrint() {
    const id = await persist();
    if (id == null) return;
    printDoc(tab, id);
  }

  async function postDoc(which, id) {
    if (!window.confirm("ترحيل هذا المستند سيحدّث المخزون وأرصدة المورد. متابعة؟")) return;
    try {
      const path = which === "returns" ? `/api/purchases/returns/${id}/post` : `/api/purchases/invoices/${id}/post`;
      await api.post(path, {}, { headers: getAuthHeaders() });
      toast.success("تم الترحيل");
      loadList(tab);
    } catch (e) { toast.error(e.response?.data?.error || "فشل الترحيل"); }
  }

  async function removeDoc(which, id) {
    if (!window.confirm("حذف هذه المسودة؟")) return;
    try {
      const path = which === "orders" ? `/api/purchases/orders/${id}` : which === "returns" ? `/api/purchases/returns/${id}` : `/api/purchases/invoices/${id}`;
      await api.delete(path, { headers: getAuthHeaders() });
      toast.success("تم الحذف");
      loadList(tab);
    } catch (e) { toast.error(e.response?.data?.error || "فشل الحذف"); }
  }

  async function openDetail(which, id) {
    try {
      const path = which === "orders" ? `/api/purchases/orders/${id}` : which === "returns" ? `/api/purchases/returns/${id}` : `/api/purchases/invoices/${id}`;
      const { data } = await api.get(path, { headers: getAuthHeaders() });
      if (data.status === "draft") {
        fillFormFromDoc(which, data, id);
      } else {
        setDetail({ which, doc: data });
      }
    } catch { toast.error("تعذّر التحميل"); }
  }

  async function printDoc(which, id) {
    try {
      const path = which === "orders" ? `/api/purchases/orders/${id}` : which === "returns" ? `/api/purchases/returns/${id}` : `/api/purchases/invoices/${id}`;
      const { data } = await api.get(path, { headers: getAuthHeaders() });
      printPurchaseDoc(data, which, store);
    } catch { toast.error("تعذّر التحميل"); }
  }

  const invoiceCols = [
    { key: "invoice_no", header: "رقم", value: (r) => `#${r.invoice_no ?? r.id}`, render: (r) => `#${r.invoice_no ?? r.id}` },
    { key: "supplier_name", header: "المورد" },
    { key: "invoice_date", header: "التاريخ", value: (r) => dateOnly(r.invoice_date), render: (r) => dateOnly(r.invoice_date) },
    { key: "total", header: "الإجمالي", align: "left", className: "num", value: (r) => ils(r.total), render: (r) => ils(r.total) },
    { key: "status", header: "الحالة", value: (r) => STATUS_LABEL[r.status], render: (r) => <StatusPill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</StatusPill> },
    {
      key: "actions", header: "إجراءات",
      render: (r) => (
        <div className="ui-table__actions">
          <Button variant="ghost" size="sm" onClick={() => openDetail("invoices", r.id)}>عرض</Button>
          <Button variant="ghost" size="sm" icon="print" onClick={() => printDoc("invoices", r.id)}>طباعة</Button>
          {r.status === "draft" && <Button variant="outline" size="sm" icon="check" onClick={() => postDoc("invoices", r.id)}>ترحيل</Button>}
          {r.status === "draft" && <Button variant="ghost" size="sm" icon="trash" onClick={() => removeDoc("invoices", r.id)} />}
        </div>
      ),
    },
  ];

  const returnCols = [
    { key: "return_no", header: "رقم", value: (r) => `#${r.return_no ?? r.id}`, render: (r) => `#${r.return_no ?? r.id}` },
    { key: "supplier_name", header: "المورد" },
    { key: "return_date", header: "التاريخ", value: (r) => dateOnly(r.return_date), render: (r) => dateOnly(r.return_date) },
    { key: "total", header: "الإجمالي", align: "left", className: "num", value: (r) => ils(r.total), render: (r) => ils(r.total) },
    { key: "status", header: "الحالة", value: (r) => STATUS_LABEL[r.status], render: (r) => <StatusPill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</StatusPill> },
    {
      key: "actions", header: "إجراءات",
      render: (r) => (
        <div className="ui-table__actions">
          <Button variant="ghost" size="sm" onClick={() => openDetail("returns", r.id)}>عرض</Button>
          <Button variant="ghost" size="sm" icon="print" onClick={() => printDoc("returns", r.id)}>طباعة</Button>
          {r.status === "draft" && <Button variant="outline" size="sm" icon="check" onClick={() => postDoc("returns", r.id)}>ترحيل</Button>}
          {r.status === "draft" && <Button variant="ghost" size="sm" icon="trash" onClick={() => removeDoc("returns", r.id)} />}
        </div>
      ),
    },
  ];

  const orderCols = [
    { key: "order_no", header: "رقم", value: (r) => `#${r.order_no ?? r.id}`, render: (r) => `#${r.order_no ?? r.id}` },
    { key: "supplier_name", header: "المورد" },
    { key: "order_date", header: "التاريخ", value: (r) => dateOnly(r.order_date), render: (r) => dateOnly(r.order_date) },
    { key: "total_amount", header: "الإجمالي", align: "left", className: "num", value: (r) => ils(r.total_amount), render: (r) => ils(r.total_amount) },
    { key: "status", header: "الحالة", value: (r) => STATUS_LABEL[r.status], render: (r) => <StatusPill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</StatusPill> },
    {
      key: "actions", header: "إجراءات",
      render: (r) => (
        <div className="ui-table__actions">
          <Button variant="ghost" size="sm" onClick={() => openDetail("orders", r.id)}>عرض</Button>
          <Button variant="ghost" size="sm" icon="print" onClick={() => printDoc("orders", r.id)}>طباعة</Button>
          {r.status !== "received" && <Button variant="ghost" size="sm" icon="trash" onClick={() => removeDoc("orders", r.id)} />}
        </div>
      ),
    },
  ];

  const rows = tab === "orders" ? orders : tab === "returns" ? returns : invoices;
  const cols = tab === "orders" ? orderCols : tab === "returns" ? returnCols : invoiceCols;
  const newLabel = tab === "orders" ? "أمر شراء جديد" : tab === "returns" ? "مرتجع جديد" : "فاتورة شراء جديدة";
  const reportTitle = tab === "orders" ? "أوامر الشراء" : tab === "returns" ? "مرتجعات الشراء" : "فواتير الشراء";

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader icon="purchases" title="المشتريات" subtitle="أوامر وفواتير ومرتجعات الشراء"
        actions={
          <>
            <ReportToolbar
              title={reportTitle}
              columns={pickExportColumns(cols)}
              rows={rows}
              filename={`purchases-${tab}`}
              disabled={loading}
            />
            <Button icon="plus" onClick={openForm}>{newLabel}</Button>
          </>
        } />

      <Tabs active={tab} onChange={setTab} tabs={[
        { id: "invoices", label: "فواتير الشراء", icon: "vouchers" },
        { id: "orders", label: "أوامر الشراء", icon: "purchases" },
        { id: "returns", label: "مرتجعات الشراء", icon: "refunds" },
      ]} />

      <DataTable columns={cols} rows={rows} loading={loading} emptyIcon="purchases" empty="لا توجد مستندات" emptyHint="أنشئ مستنداً جديداً للبدء" />

      <Modal open={showForm} title={editId ? "تعديل المسودة" : newLabel} onClose={() => { setShowForm(false); setEditId(null); }} size="lg"
        footer={<>
          <Button onClick={save} disabled={saving}>{saving ? "جاري الحفظ…" : editId ? "حفظ التعديلات" : "حفظ كمسودة"}</Button>
          {editId && tab !== "orders" && <Button variant="outline" icon="check" onClick={saveAndPost} disabled={saving}>ترحيل</Button>}
          {editId && tab !== "orders" && <Button variant="ghost" icon="print" onClick={saveAndPrint} disabled={saving}>طباعة</Button>}
          <Button variant="secondary" onClick={() => { setShowForm(false); setEditId(null); }}>إلغاء</Button>
        </>}>
        <FormGrid>
          <FormField label="المورد" required>
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">— اختر —</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </FormField>
          <FormField label="التاريخ"><Input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} /></FormField>
          {tab === "invoices" && <FormField label="مرجع الفاتورة"><Input value={refText} onChange={(e) => setRefText(e.target.value)} /></FormField>}
        </FormGrid>
        <div style={{ margin: "1rem 0 0.5rem", fontWeight: 700 }}>الأصناف</div>
        <ItemEditor items={items} setItems={setItems} withVat={tab === "invoices"} />
        <FormField label="ملاحظات" className="ui-field--full"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></FormField>
      </Modal>

      <Modal open={!!detail} title={detail ? `تفاصيل المستند #${detail.doc.invoice_no ?? detail.doc.return_no ?? detail.doc.order_no ?? detail.doc.id}` : ""} onClose={() => setDetail(null)} size="lg"
        footer={detail ? <Button icon="print" onClick={() => printPurchaseDoc(detail.doc, detail.which, store)}>طباعة</Button> : null}>
        {detail && (
          <>
            <div className="detail-header">
              <div>المورد: <strong>{detail.doc.supplier_name}</strong></div>
              <div>الحالة: <StatusPill tone={STATUS_TONE[detail.doc.status]}>{STATUS_LABEL[detail.doc.status]}</StatusPill></div>
            </div>
            <DataTable
              columns={[
                { key: "name", header: "الصنف" },
                { key: "quantity", header: "الكمية", align: "left", render: (it) => fmtQty(it.quantity) },
                { key: "total_cost", header: "إجمالي الكلفة", align: "left", className: "num", render: (it) => ils(it.total_cost) },
                { key: "unit_cost", header: "كلفة الوحدة", align: "left", className: "num", render: (it) => ils(it.unit_cost) },
                { key: "line_total", header: "الإجمالي", align: "left", className: "num", render: (it) => ils(it.line_total) },
              ]}
              rows={detail.doc.items || []}
              empty="لا توجد أصناف"
            />
          </>
        )}
      </Modal>
    </div>
  );
}
