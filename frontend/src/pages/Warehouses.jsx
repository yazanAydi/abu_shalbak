import { useCallback, useEffect, useMemo, useState } from "react";
import { todayISO } from "../utils/format";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils, dateOnly, qty as fmtQty } from "../utils/format";
import ProductPicker from "../components/ProductPicker";
import QtyStepper from "../components/QtyStepper";
import { handleEnterNavKeyDown } from "../utils/focusNavigation";
import {
  PageHeader, Button, DataTable, Modal, Tabs, StatusPill,
  FormField, FormGrid, Input, Select, Textarea, Icon, ReportToolbar, useToast,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";

const WH_TYPES = { main: "رئيسي", store: "متجر", returns: "مرتجعات", damaged: "تالف" };

export default function Warehouses() {
  const toast = useToast();
  const [tab, setTab] = useState("warehouses");
  const [warehouses, setWarehouses] = useState([]);
  const [stock, setStock] = useState([]);
  const [valuation, setValuation] = useState(null);
  const [transfers, setTransfers] = useState([]);
  const [loading, setLoading] = useState(true);

  const [showWh, setShowWh] = useState(false);
  const [whForm, setWhForm] = useState({ name: "", code: "", type: "store" });

  const [showTransfer, setShowTransfer] = useState(false);
  const [transferForm, setTransferForm] = useState({ from_warehouse_id: "", to_warehouse_id: "", transfer_date: todayISO(), notes: "" });
  const [transferItems, setTransferItems] = useState([]);
  const [detail, setDetail] = useState(null);
  const [editId, setEditId] = useState(null);

  const loadWarehouses = useCallback(async () => {
    try { const { data } = await api.get("/api/warehouses", { headers: getAuthHeaders() }); setWarehouses(data); }
    catch { /* */ }
  }, []);

  const loadTab = useCallback(async (which) => {
    setLoading(true);
    try {
      if (which === "stock") setStock((await api.get("/api/warehouses/stock", { headers: getAuthHeaders() })).data);
      else if (which === "valuation") setValuation((await api.get("/api/warehouses/valuation", { headers: getAuthHeaders() })).data);
      else if (which === "transfers") setTransfers((await api.get("/api/warehouses/transfers", { headers: getAuthHeaders() })).data);
    } catch { toast.error("تعذّر التحميل"); } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { loadWarehouses(); }, [loadWarehouses]);
  useEffect(() => { if (tab !== "warehouses") loadTab(tab); else setLoading(false); }, [tab, loadTab]);

  async function saveWh() {
    if (!whForm.name.trim()) { toast.error("الاسم مطلوب"); return; }
    try {
      await api.post("/api/warehouses", whForm, { headers: getAuthHeaders() });
      toast.success("تمت الإضافة"); setShowWh(false); setWhForm({ name: "", code: "", type: "store" }); loadWarehouses();
    } catch (e) { toast.error(e.response?.data?.error || "فشل"); }
  }
  async function removeWh(id) {
    if (!window.confirm("حذف المستودع؟")) return;
    try { await api.delete(`/api/warehouses/${id}`, { headers: getAuthHeaders() }); toast.success("تم"); loadWarehouses(); }
    catch (e) { toast.error(e.response?.data?.error || "فشل"); }
  }

  function addItem(p) {
    setTransferItems((prev) => prev.some((x) => x.product_id === p.id) ? prev : [...prev, { product_id: p.id, name: p.name, quantity: 1 }]);
  }
  async function saveTransfer() {
    if (!transferForm.from_warehouse_id || !transferForm.to_warehouse_id) { toast.error("حدّد المستودعين"); return; }
    if (transferItems.length === 0) { toast.error("أضف أصنافاً"); return; }
    try {
      const payload = {
        ...transferForm,
        items: transferItems.map((it) => ({ product_id: it.product_id, quantity: Number(it.quantity) })),
      };
      if (editId) {
        await api.put(`/api/warehouses/transfers/${editId}`, payload, { headers: getAuthHeaders() });
        toast.success("تم تعديل المسودة");
      } else {
        await api.post("/api/warehouses/transfers", payload, { headers: getAuthHeaders() });
        toast.success("حُفظ كمسودة");
      }
      setShowTransfer(false); setTransferItems([]); setEditId(null); loadTab("transfers");
    } catch (e) { toast.error(e.response?.data?.error || "فشل"); }
  }
  async function postTransfer(id) {
    if (!window.confirm("ترحيل التحويل سينقل المخزون بين المستودعين. متابعة؟")) return;
    try { await api.post(`/api/warehouses/transfers/${id}/post`, {}, { headers: getAuthHeaders() }); toast.success("تم الترحيل"); loadTab("transfers"); }
    catch (e) { toast.error(e.response?.data?.error || "فشل"); }
  }
  async function removeTransfer(id) {
    if (!window.confirm("حذف المسودة؟")) return;
    try { await api.delete(`/api/warehouses/transfers/${id}`, { headers: getAuthHeaders() }); toast.success("تم"); loadTab("transfers"); }
    catch (e) { toast.error(e.response?.data?.error || "فشل"); }
  }
  async function openDetail(id) {
    try {
      const { data } = await api.get(`/api/warehouses/transfers/${id}`, { headers: getAuthHeaders() });
      if (data.status === "draft") fillFormFromDoc(data);
      else setDetail(data);
    } catch { /* */ }
  }

  function fillFormFromDoc(data) {
    setTransferForm({
      from_warehouse_id: String(data.from_warehouse_id),
      to_warehouse_id: String(data.to_warehouse_id),
      transfer_date: data.transfer_date?.slice(0, 10) || todayISO(),
      notes: data.notes || "",
    });
    setTransferItems((data.items || []).map((it) => ({ product_id: it.product_id, name: it.name, quantity: it.quantity })));
    setEditId(data.id);
    setShowTransfer(true);
  }

  const warehouseColumns = [
    { key: "name", header: "الاسم", value: (w) => w.name, render: (w) => <strong>{w.name}</strong> },
    { key: "code", header: "الكود", value: (w) => w.code || "—", render: (w) => w.code || "—" },
    { key: "type", header: "النوع", value: (w) => WH_TYPES[w.type] || w.type, render: (w) => <StatusPill tone="blue" noDot>{WH_TYPES[w.type] || w.type}</StatusPill> },
    { key: "active", header: "الحالة", value: (w) => (w.active ? "مفعّل" : "معطّل"), render: (w) => <StatusPill tone={w.active ? "green" : "neutral"}>{w.active ? "مفعّل" : "معطّل"}</StatusPill> },
    { key: "actions", header: "", render: (w) => <Button variant="ghost" size="sm" icon="trash" onClick={() => removeWh(w.id)} /> },
  ];

  const transferColumns = [
    { key: "transfer_no", header: "رقم", value: (t) => `#${t.transfer_no ?? t.id}`, render: (t) => `#${t.transfer_no ?? t.id}` },
    { key: "from_name", header: "من" },
    { key: "to_name", header: "إلى" },
    { key: "transfer_date", header: "التاريخ", value: (t) => dateOnly(t.transfer_date), render: (t) => dateOnly(t.transfer_date) },
    { key: "item_count", header: "الأصناف" },
    { key: "status", header: "الحالة", value: (t) => (t.status === "posted" ? "مرحّل" : "مسودة"), render: (t) => <StatusPill tone={t.status === "posted" ? "green" : "neutral"}>{t.status === "posted" ? "مرحّل" : "مسودة"}</StatusPill> },
    { key: "actions", header: "إجراءات", render: (t) => (
      <div className="ui-table__actions">
        <Button variant="ghost" size="sm" onClick={() => openDetail(t.id)}>عرض</Button>
        {t.status === "draft" && <Button variant="outline" size="sm" icon="check" onClick={() => postTransfer(t.id)}>ترحيل</Button>}
        {t.status === "draft" && <Button variant="ghost" size="sm" icon="trash" onClick={() => removeTransfer(t.id)} />}
      </div>
    ) },
  ];

  const stockColumns = [
    { key: "warehouse_name", header: "المستودع" },
    { key: "product_name", header: "الصنف" },
    { key: "quantity", header: "الكمية", value: (r) => fmtQty(r.quantity), render: (r) => fmtQty(r.quantity) },
    { key: "value", header: "القيمة", value: (r) => ils(r.value), render: (r) => ils(r.value) },
  ];

  const valuationColumns = [
    { key: "warehouse_name", header: "المستودع" },
    { key: "total_qty", header: "إجمالي الكمية", value: (r) => fmtQty(r.total_qty), render: (r) => fmtQty(r.total_qty) },
    { key: "total_value", header: "القيمة", value: (r) => ils(r.total_value), render: (r) => ils(r.total_value) },
  ];

  const reportConfig = useMemo(() => {
    if (tab === "transfers") {
      return { title: "تحويلات المستودعات", columns: pickExportColumns(transferColumns), rows: transfers, filename: "warehouse-transfers" };
    }
    if (tab === "stock") {
      return { title: "تقرير مخزون المستودعات", columns: stockColumns, rows: stock, filename: "warehouse-stock" };
    }
    if (tab === "valuation" && valuation) {
      return {
        title: "تقييم المخزون",
        columns: valuationColumns,
        rows: valuation.warehouses || [],
        filename: "warehouse-valuation",
        summary: [{ label: "إجمالي قيمة المخزون", value: ils(valuation.grand_total) }],
      };
    }
    return { title: "المستودعات", columns: pickExportColumns(warehouseColumns), rows: warehouses, filename: "warehouses" };
  }, [tab, warehouses, transfers, stock, valuation]);

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader icon="warehouses" title="المستودعات" subtitle="المستودعات، التحويلات، تقارير المخزون والتقييم"
        actions={
          <>
            <ReportToolbar
              title={reportConfig.title}
              columns={reportConfig.columns}
              rows={reportConfig.rows}
              filename={reportConfig.filename}
              summary={reportConfig.summary}
              disabled={loading && tab !== "warehouses"}
            />
            {tab === "warehouses" ? <Button icon="plus" onClick={() => setShowWh(true)}>مستودع جديد</Button>
              : tab === "transfers" ? <Button icon="plus" onClick={() => { setEditId(null); setTransferForm({ from_warehouse_id: "", to_warehouse_id: "", transfer_date: todayISO(), notes: "" }); setTransferItems([]); setShowTransfer(true); }}>تحويل جديد</Button> : null}
          </>
        } />

      <Tabs active={tab} onChange={setTab} tabs={[
        { id: "warehouses", label: "المستودعات", icon: "warehouses" },
        { id: "transfers", label: "التحويلات", icon: "deliveries" },
        { id: "stock", label: "تقرير المخزون", icon: "inventory" },
        { id: "valuation", label: "تقييم المخزون", icon: "finance" },
      ]} />

      {tab === "warehouses" && (
        <DataTable
          loading={loading}
          columns={warehouseColumns}
          rows={warehouses}
          emptyIcon="warehouses"
          empty="لا توجد مستودعات"
        />
      )}

      {tab === "transfers" && (
        <DataTable
          loading={loading}
          columns={transferColumns}
          rows={transfers}
          emptyIcon="deliveries"
          empty="لا توجد تحويلات"
        />
      )}

      {tab === "stock" && (
        <DataTable
          loading={loading}
          columns={stockColumns}
          rows={stock}
          emptyIcon="inventory"
          empty="لا يوجد مخزون موزّع على المستودعات"
          emptyHint="يُسجَّل المخزون لكل مستودع عبر التحويلات"
        />
      )}

      {tab === "valuation" && valuation && (
        <>
          <div className="ui-stat-grid">
            <div className="ui-stat">
              <div className="ui-stat__icon ui-stat__icon--green"><Icon name="finance" /></div>
              <div><div className="ui-stat__label">إجمالي قيمة المخزون</div><div className="ui-stat__value">{ils(valuation.grand_total)}</div></div>
            </div>
          </div>
          <DataTable
            columns={valuationColumns}
            rows={valuation.warehouses}
            empty="لا توجد بيانات"
          />
        </>
      )}

      <Modal open={showWh} title="مستودع جديد" onClose={() => setShowWh(false)}
        footer={<><Button onClick={saveWh}>حفظ</Button><Button variant="secondary" onClick={() => setShowWh(false)}>إلغاء</Button></>}>
        <FormGrid>
          <FormField label="الاسم" required><Input value={whForm.name} onChange={(e) => setWhForm((f) => ({ ...f, name: e.target.value }))} /></FormField>
          <FormField label="الكود"><Input value={whForm.code} onChange={(e) => setWhForm((f) => ({ ...f, code: e.target.value }))} /></FormField>
          <FormField label="النوع"><Select value={whForm.type} onChange={(e) => setWhForm((f) => ({ ...f, type: e.target.value }))}>{Object.entries(WH_TYPES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></FormField>
        </FormGrid>
      </Modal>

      <Modal open={showTransfer} title={editId ? "تعديل التحويل" : "تحويل بين المستودعات"} onClose={() => { setShowTransfer(false); setEditId(null); }} size="lg"
        footer={<><Button onClick={saveTransfer}>{editId ? "حفظ التعديلات" : "حفظ كمسودة"}</Button><Button variant="secondary" onClick={() => { setShowTransfer(false); setEditId(null); }}>إلغاء</Button></>}>
        <FormGrid>
          <FormField label="من مستودع" required>
            <Select value={transferForm.from_warehouse_id} onChange={(e) => setTransferForm((f) => ({ ...f, from_warehouse_id: e.target.value }))}>
              <option value="">— اختر —</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </FormField>
          <FormField label="إلى مستودع" required>
            <Select value={transferForm.to_warehouse_id} onChange={(e) => setTransferForm((f) => ({ ...f, to_warehouse_id: e.target.value }))}>
              <option value="">— اختر —</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          </FormField>
          <FormField label="التاريخ"><Input type="date" value={transferForm.transfer_date} onChange={(e) => setTransferForm((f) => ({ ...f, transfer_date: e.target.value }))} /></FormField>
        </FormGrid>
        <div style={{ margin: "1rem 0 0.5rem", fontWeight: 700 }}>الأصناف</div>
        <div data-enter-nav="" onKeyDown={handleEnterNavKeyDown}>
        <div style={{ marginBottom: "0.75rem" }}><ProductPicker onPick={addItem} /></div>
        <div className="ui-table-wrap" style={{ marginBottom: "0.75rem" }}>
          <table className="ui-table">
            <thead><tr><th>الصنف</th><th>الكمية</th><th></th></tr></thead>
            <tbody>
              {transferItems.length === 0 && <tr><td colSpan={3} style={{ textAlign: "center", color: "var(--office-panel-muted)", padding: "1rem" }}>أضف أصنافاً</td></tr>}
              {transferItems.map((it, i) => (
                <tr key={it.product_id}>
                  <td>{it.name}</td>
                  <td><QtyStepper className="ui-input" style={{ width: 140 }} min={0} value={it.quantity} onChange={(e) => setTransferItems((prev) => prev.map((x, idx) => idx === i ? { ...x, quantity: e.target.value } : x))} /></td>
                  <td><Button variant="ghost" size="sm" icon="trash" onClick={() => setTransferItems((p) => p.filter((_, idx) => idx !== i))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </div>
        <FormField label="ملاحظات"><Textarea value={transferForm.notes} onChange={(e) => setTransferForm((f) => ({ ...f, notes: e.target.value }))} /></FormField>
      </Modal>

      <Modal open={!!detail} title={detail ? `تحويل #${detail.transfer_no ?? detail.id}` : ""} onClose={() => setDetail(null)}>
        {detail && (
          <>
            <div className="detail-header">
              <div>من: <strong>{detail.from_name}</strong> ← إلى: <strong>{detail.to_name}</strong></div>
            </div>
            <DataTable
              columns={[
                { key: "name", header: "الصنف" },
                { key: "quantity", header: "الكمية", align: "left", render: (it) => fmtQty(it.quantity) },
              ]}
              rows={detail.items || []}
              empty="لا توجد أصناف"
            />
          </>
        )}
      </Modal>
    </div>
  );
}
