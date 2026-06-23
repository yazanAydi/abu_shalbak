import { useCallback, useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils, dateOnly, qty as fmtQty } from "../utils/format";
import ProductPicker from "../components/ProductPicker";
import {
  PageHeader, Button, DataTable, Modal, Tabs, StatusPill,
  FormField, FormGrid, Input, Textarea, Select, Icon, ReportToolbar, useToast,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";

const STATUS_TONE = { draft: "neutral", posted: "green", confirmed: "blue", received: "green", cancelled: "red" };
const STATUS_LABEL = { draft: "مسودة", posted: "مرحّلة", confirmed: "مؤكد", received: "مستلم", cancelled: "ملغي" };

function selectInputOnFocus(e) {
  e.target.select();
}

function ItemEditor({ items, setItems, withVat }) {
  function addProduct(p) {
    setItems((prev) => {
      if (prev.some((x) => x.product_id === p.id)) return prev;
      return [...prev, { product_id: p.id, name: p.name, barcode: p.barcode, quantity: 1, unit_cost: Number(p.cost) || "", vat_rate: "" }];
    });
  }
  function update(i, key, val) {
    setItems((prev) => prev.map((x, idx) => (idx === i ? { ...x, [key]: val } : x)));
  }
  function remove(i) { setItems((prev) => prev.filter((_, idx) => idx !== i)); }

  const total = items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.unit_cost) || 0), 0);

  return (
    <>
      <div style={{ marginBottom: "0.75rem" }}>
        <ProductPicker onPick={addProduct} />
      </div>
      <div className="ui-table-wrap" style={{ marginBottom: "0.75rem" }}>
        <table className="ui-table">
          <thead>
            <tr>
              <th>الصنف</th><th>الكمية</th><th>الكلفة</th>{withVat && <th>ض.ق.م %</th>}<th>الإجمالي</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={withVat ? 6 : 5} style={{ textAlign: "center", color: "var(--office-panel-muted)", padding: "1rem" }}>أضف أصنافاً</td></tr>}
            {items.map((it, i) => (
              <tr key={it.product_id}>
                <td>{it.name}</td>
                <td><input className="ui-input" style={{ width: 90 }} type="number" min="0" step="1" value={it.quantity} onFocus={selectInputOnFocus} onChange={(e) => update(i, "quantity", e.target.value)} /></td>
                <td><input className="ui-input" style={{ width: 100 }} type="number" min="0" step="1" placeholder="0" value={it.unit_cost} onFocus={selectInputOnFocus} onChange={(e) => update(i, "unit_cost", e.target.value)} /></td>
                {withVat && <td><input className="ui-input" style={{ width: 80 }} type="number" min="0" max="100" step="1" placeholder="افتراضي" value={it.vat_rate} onFocus={selectInputOnFocus} onChange={(e) => update(i, "vat_rate", e.target.value)} /></td>}
                <td className="num">{ils((Number(it.quantity) || 0) * (Number(it.unit_cost) || 0))}</td>
                <td><Button variant="ghost" size="sm" icon="trash" onClick={() => remove(i)} /></td>
              </tr>
            ))}
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
  const [detail, setDetail] = useState(null);

  const loadSuppliers = useCallback(async () => {
    try {
      const { data } = await api.get("/api/suppliers", { headers: getAuthHeaders() });
      setSuppliers(data);
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

  useEffect(() => { loadSuppliers(); }, [loadSuppliers]);
  useEffect(() => { loadList(tab); }, [tab, loadList]);

  function openForm() {
    setSupplierId(""); setDocDate(new Date().toISOString().slice(0, 10));
    setRefText(""); setNotes(""); setItems([]); setShowForm(true);
  }

  async function save() {
    if (!supplierId) { toast.error("اختر المورد"); return; }
    if (items.length === 0) { toast.error("أضف أصنافاً"); return; }
    setSaving(true);
    const payload = {
      supplier_id: Number(supplierId),
      notes,
      items: items.map((it) => ({
        product_id: it.product_id,
        quantity: Number(it.quantity),
        unit_cost: Number(it.unit_cost),
        vat_rate: it.vat_rate === "" ? undefined : Number(it.vat_rate) / 100,
      })),
    };
    try {
      if (tab === "orders") { payload.order_date = docDate; await api.post("/api/purchases/orders", payload, { headers: getAuthHeaders() }); }
      else if (tab === "returns") { payload.return_date = docDate; await api.post("/api/purchases/returns", payload, { headers: getAuthHeaders() }); }
      else { payload.invoice_date = docDate; payload.ref_text = refText; await api.post("/api/purchases/invoices", payload, { headers: getAuthHeaders() }); }
      toast.success("تم الحفظ كمسودة");
      setShowForm(false);
      loadList(tab);
    } catch (e) { toast.error(e.response?.data?.error || "فشل الحفظ"); }
    finally { setSaving(false); }
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
      setDetail({ which, doc: data });
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

      <Modal open={showForm} title={newLabel} onClose={() => setShowForm(false)} size="lg"
        footer={<>
          <Button onClick={save} disabled={saving}>{saving ? "جاري الحفظ…" : "حفظ كمسودة"}</Button>
          <Button variant="secondary" onClick={() => setShowForm(false)}>إلغاء</Button>
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

      <Modal open={!!detail} title={detail ? `تفاصيل المستند #${detail.doc.invoice_no ?? detail.doc.return_no ?? detail.doc.order_no ?? detail.doc.id}` : ""} onClose={() => setDetail(null)} size="lg">
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
                { key: "unit_cost", header: "الكلفة", align: "left", className: "num", render: (it) => ils(it.unit_cost) },
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
