import { apiErrorMessage } from "../utils/apiError";
import { useCallback, useEffect, useMemo, useState } from "react";
import { todayISO } from "../utils/format";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils, dateOnly, qty as fmtQty } from "../utils/format";
import ProductPicker from "../components/ProductPicker";
import QtyStepper from "../components/QtyStepper";
import { handleEnterNavKeyDown } from "../utils/focusNavigation";
import { displayProductBarcode, displayProductSku } from "../utils/entityCodeDisplay";
import {
  PageHeader, Button, DataTable, Modal, Tabs, StatusPill,
  FormField, FormGrid, Input, Select, Textarea, Icon, ReportToolbar, FilterBar, useToast,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";

const WH_TYPES = { main: "رئيسي", store: "متجر", returns: "مرتجعات", damaged: "تالف" };

function formatUnitCost(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "غير مكتمل";
  return `₪${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

export default function Warehouses({ workspace = null }) {
  const isBakery = workspace === "bakery";
  const toast = useToast();
  const [tab, setTab] = useState("warehouses");
  const [warehouses, setWarehouses] = useState([]);
  const [stock, setStock] = useState([]);
  const [valuation, setValuation] = useState(null);
  const [asOf, setAsOf] = useState(() => todayISO());
  const [transfers, setTransfers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");

  const [showWh, setShowWh] = useState(false);
  const [whForm, setWhForm] = useState({ name: "", code: "", type: "store" });

  const [showTransfer, setShowTransfer] = useState(false);
  const [transferForm, setTransferForm] = useState({ from_warehouse_id: "", to_warehouse_id: "", transfer_date: todayISO(), notes: "" });
  const [transferItems, setTransferItems] = useState([]);
  const [detail, setDetail] = useState(null);
  const [editId, setEditId] = useState(null);

  useEffect(() => {
    const t = window.setTimeout(() => setQDebounced(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const catalogParams = useCallback(() => {
    const params = {};
    if (isBakery) params.membership = "bakery";
    if (qDebounced) params.q = qDebounced;
    if (asOf) params.as_of = asOf;
    return params;
  }, [isBakery, qDebounced, asOf]);

  const loadWarehouses = useCallback(async () => {
    try { const { data } = await api.get("/api/warehouses", { headers: getAuthHeaders() }); setWarehouses(data); }
    catch { /* */ }
  }, []);

  const loadTab = useCallback(async (which) => {
    setLoading(true);
    try {
      if (which === "stock") {
        setStock((await api.get("/api/warehouses/stock", { headers: getAuthHeaders(), params: catalogParams() })).data);
      } else if (which === "valuation") {
        setValuation((await api.get("/api/warehouses/valuation", { headers: getAuthHeaders(), params: catalogParams() })).data);
      } else if (which === "transfers") {
        setTransfers((await api.get("/api/warehouses/transfers", { headers: getAuthHeaders() })).data);
      }
    } catch { toast.error("تعذّر التحميل"); } finally { setLoading(false); }
  }, [toast, catalogParams]);

  useEffect(() => { loadWarehouses(); }, [loadWarehouses]);
  useEffect(() => { if (tab !== "warehouses") loadTab(tab); else setLoading(false); }, [tab, loadTab]);

  async function saveWh() {
    if (!whForm.name.trim()) { toast.error("الاسم مطلوب"); return; }
    try {
      await api.post("/api/warehouses", whForm, { headers: getAuthHeaders() });
      toast.success("تمت الإضافة"); setShowWh(false); setWhForm({ name: "", code: "", type: "store" }); loadWarehouses();
    } catch (e) { toast.error(apiErrorMessage(e, "فشل")); }
  }
  async function removeWh(id) {
    if (!window.confirm("حذف المستودع؟")) return;
    try { await api.delete(`/api/warehouses/${id}`, { headers: getAuthHeaders() }); toast.success("تم"); loadWarehouses(); }
    catch (e) { toast.error(apiErrorMessage(e, "فشل")); }
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
    } catch (e) { toast.error(apiErrorMessage(e, "فشل")); }
  }
  async function postTransfer(id) {
    if (!window.confirm("ترحيل التحويل سينقل المخزون بين المستودعين. متابعة؟")) return;
    try { await api.post(`/api/warehouses/transfers/${id}/post`, {}, { headers: getAuthHeaders() }); toast.success("تم الترحيل"); loadTab("transfers"); }
    catch (e) { toast.error(apiErrorMessage(e, "فشل")); }
  }
  async function removeTransfer(id) {
    if (!window.confirm("حذف المسودة؟")) return;
    try { await api.delete(`/api/warehouses/transfers/${id}`, { headers: getAuthHeaders() }); toast.success("تم"); loadTab("transfers"); }
    catch (e) { toast.error(apiErrorMessage(e, "فشل")); }
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
    { key: "actions", header: "", render: (w) => (
      isBakery ? null : <Button variant="ghost" size="sm" icon="trash" aria-label="حذف" onClick={() => removeWh(w.id)} />
    ) },
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
        {t.status === "draft" && <Button variant="ghost" size="sm" icon="trash" aria-label="حذف" onClick={() => removeTransfer(t.id)} />}
      </div>
    ) },
  ];

  const stockColumns = [
    { key: "warehouse_name", header: "المستودع" },
    { key: "product_name", header: "الصنف" },
    { key: "barcode", header: "الباركود", value: (r) => displayProductBarcode(r), render: (r) => displayProductBarcode(r) },
    { key: "sku", header: "رقم المنتج", value: (r) => displayProductSku(r.sku), render: (r) => displayProductSku(r.sku) },
    { key: "quantity", header: "الكمية", value: (r) => fmtQty(r.quantity), render: (r) => fmtQty(r.quantity) },
    { key: "value", header: "القيمة", value: (r) => ils(r.value), render: (r) => ils(r.value) },
  ];

  const valuationColumns = [
    { key: "as_of_label", header: "التاريخ", value: (r) => r.as_of_label || valuation?.as_of_label || asOf },
    { key: "warehouse_name", header: "المستودع" },
    { key: "product_name", header: "الصنف", value: (r) => r.product_name || "—", render: (r) => r.product_name || "—" },
    { key: "quantity", header: "الكمية", value: (r) => fmtQty(r.quantity), render: (r) => fmtQty(r.quantity) },
    { key: "unit_cost", header: "تكلفة الوحدة", value: (r) => (r.cost_known ? formatUnitCost(r.unit_cost) : "غير مكتمل"), render: (r) => (r.cost_known ? formatUnitCost(r.unit_cost) : "غير مكتمل") },
    { key: "value", header: "القيمة", value: (r) => (r.cost_known ? ils(r.value) : "غير مكتمل"), render: (r) => (r.cost_known ? ils(r.value) : "غير مكتمل") },
  ];

  const reportConfig = useMemo(() => {
    if (tab === "transfers") {
      return { title: "تحويلات المستودعات", columns: pickExportColumns(transferColumns), rows: transfers, filename: "warehouse-transfers" };
    }
    if (tab === "stock") {
      return { title: isBakery ? "مخزون مستودعات المخبز" : "تقرير مخزون المستودعات", columns: stockColumns, rows: stock, filename: isBakery ? "bakery-warehouse-stock" : "warehouse-stock" };
    }
    if (tab === "valuation" && valuation) {
      const when = valuation.as_of_label || asOf;
      return {
        title: isBakery ? "تقييم مخزون المخبز" : "تقييم المخزون",
        subtitle: `تقييم المخزون بتاريخ ${when}`,
        columns: valuationColumns,
        rows: valuation.lines || [],
        filename: isBakery ? "bakery-warehouse-valuation" : "warehouse-valuation",
        meta: [
          `التاريخ: ${when}`,
          `يوم العمل: ${valuation.shop_business_day || asOf}`,
          "المستودع: كل مستودعات هذا العرض",
        ],
        summary: [
          { label: "التاريخ", value: when },
          {
            label: valuation.valuation_complete ? "إجمالي قيمة المخزون" : "المجموع المعروف فقط — التقييم غير مكتمل",
            value: valuation.valuation_complete ? ils(valuation.grand_total) : ils(valuation.known_subtotal),
          },
          { label: "أصناف مستبعدة لنقص التاريخ", value: String((valuation.excluded_products || []).length) },
        ],
      };
    }
    return { title: isBakery ? "مستودعات المخبز" : "المستودعات", columns: pickExportColumns(warehouseColumns), rows: warehouses, filename: isBakery ? "bakery-warehouses" : "warehouses" };
  }, [tab, warehouses, transfers, stock, valuation, isBakery, asOf]);

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        icon="warehouses"
        title={isBakery ? "مستودعات المخبز" : "المستودعات"}
        subtitle={isBakery
          ? "مخزون المخبز المملوك في المستودع الرئيسي. مرتجع المورد المرحّل خرج من الملكية، والتحويل إلى المرتجع أو التالف يبقى مملوكاً."
          : "مخزون السوبرماركت المملوك في المستودع الرئيسي. مرتجع المورد المرحّل خرج من الملكية، والتحويل إلى المرتجع أو التالف يبقى مملوكاً."}
        actions={
          <>
            <ReportToolbar
              title={reportConfig.title}
              columns={reportConfig.columns}
              rows={reportConfig.rows}
              filename={reportConfig.filename}
              summary={reportConfig.summary}
              subtitle={reportConfig.subtitle}
              meta={reportConfig.meta}
              disabled={loading && tab !== "warehouses"}
            />
            {!isBakery && tab === "warehouses" ? <Button icon="plus" onClick={() => setShowWh(true)}>مستودع جديد</Button>
              : tab === "transfers" ? <Button icon="plus" onClick={() => { setEditId(null); setTransferForm({ from_warehouse_id: "", to_warehouse_id: "", transfer_date: todayISO(), notes: "" }); setTransferItems([]); setShowTransfer(true); }}>تحويل جديد</Button> : null}
          </>
        } />

      <Tabs active={tab} onChange={setTab} tabs={[
        { id: "warehouses", label: "المستودعات", icon: "warehouses" },
        { id: "transfers", label: "التحويلات", icon: "deliveries" },
        { id: "stock", label: "تقرير المخزون", icon: "inventory" },
        { id: "valuation", label: "تقييم المخزون", icon: "finance" },
      ]} />

      {(tab === "stock" || tab === "valuation") && (
        <FilterBar onReset={q ? () => setQ("") : undefined}>
          {tab === "valuation" && (
            <FormField label="تقييم المخزون بتاريخ">
              <Input
                type="date"
                value={asOf}
                max={valuation?.shop_business_day || todayISO()}
                aria-label="تقييم المخزون بتاريخ"
                onChange={(e) => setAsOf(e.target.value)}
              />
            </FormField>
          )}
          <FormField label="بحث">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="الاسم أو الباركود أو رقم المنتج"
              aria-label="بحث بالاسم أو الباركود أو رقم المنتج"
            />
          </FormField>
        </FilterBar>
      )}

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
          empty={qDebounced ? "لا توجد أصناف مطابقة" : "لا يوجد مخزون في المستودعات"}
          emptyHint={isBakery
            ? "مخزون المخبز المملوك يظهر في المستودع الرئيسي. مرتجع المورد المرحّل لا يظهر كمخزون مملوك."
            : "مخزون السوبرماركت المملوك يظهر في المستودع الرئيسي. مرتجع المورد المرحّل لا يظهر كمخزون مملوك."}
        />
      )}

      {tab === "valuation" && valuation && (
        <>
          <div className="ui-stat-grid">
            <div className="ui-stat">
              <div className="ui-stat__icon ui-stat__icon--green"><Icon name="finance" /></div>
              <div>
                <div className="ui-stat__label">{valuation.valuation_complete ? "إجمالي قيمة المخزون" : "التقييم غير مكتمل"} {valuation.as_of_label === "حتى الآن" ? "(حتى الآن)" : ""}</div>
                <div className="ui-stat__value">{valuation.valuation_complete ? ils(valuation.grand_total) : "غير مكتمل"}</div>
              </div>
            </div>
            <div className="ui-stat">
              <div className="ui-stat__icon"><Icon name="inventory" /></div>
              <div>
                <div className="ui-stat__label">المجموع المعروف فقط</div>
                <div className="ui-stat__value">{ils(valuation.known_subtotal)}</div>
              </div>
            </div>
          </div>
          {valuation.history_message && (
            <p style={{ color: "var(--office-panel-muted)", margin: "0.5rem 0" }}>{valuation.history_message}</p>
          )}
          {valuation.supported_from && (
            <p style={{ color: "var(--office-panel-muted)", margin: "0.5rem 0" }}>
              سجل التكلفة المحفوظ مع الحركة يبدأ من {valuation.supported_from}. ما قبله يُعاد من فواتير الشراء والمرتجع عندما تبدأ الحركة من صفر.
            </p>
          )}
          <p style={{ color: "var(--office-panel-muted)", margin: "0.5rem 0" }}>{valuation.backdated_note}</p>
          <p style={{ color: "var(--office-panel-muted)", margin: "0.5rem 0" }}>{valuation.costing_note}</p>
          <p style={{ color: "var(--office-panel-muted)", margin: "0.5rem 0" }}>{valuation.classification_message}</p>
          {(valuation.unexplained_rounding || []).length > 0 && (
            <p style={{ color: "var(--office-panel-muted)", margin: "0.5rem 0" }}>
              فرق تقريب غير محفوظ على حركة: {valuation.unexplained_rounding.map((row) => `${row.product_name} ${row.amount}`).join("، ")}
            </p>
          )}
          {(valuation.excluded_products || []).length > 0 && (
            <p style={{ color: "var(--office-panel-muted)", margin: "0.5rem 0" }}>
              أصناف بلا تاريخ كافٍ ولا تدخل في المجموع: {valuation.excluded_products.map((row) => row.product_name).join("، ")}
            </p>
          )}
          {valuation.document_date_estimate && (
            <p style={{ color: "var(--office-panel-muted)", margin: "0.5rem 0" }}>
              {valuation.document_date_estimate.note}{" "}
              {valuation.document_date_estimate.lines.map((row) => `${row.product_name}: مسجّل ${row.recorded_value} / تقدير ${row.estimate_value}`).join("، ")}
            </p>
          )}
          {(valuation.unreconciled_products || []).length > 0 && (
            <p style={{ color: "var(--office-panel-muted)", margin: "0.5rem 0" }}>
              أصناف غير مسوّاة ولم تُحسب صفراً: {valuation.unreconciled_products.map((row) => row.product_name).join("، ")}
            </p>
          )}
          {(valuation.supplier_returns || []).length > 0 && (
            <p style={{ color: "var(--office-panel-muted)", margin: "0.5rem 0" }}>
              مرتجعات مورّدين مرحّلة (خرجت من ملكية الشركة ولا تُحسب في القيمة): {valuation.supplier_returns.map((row) => `${row.product_name} ${row.quantity}`).join("، ")}
            </p>
          )}
          <DataTable
            columns={valuationColumns.filter((col) => col.key !== "as_of_label")}
            rows={valuation.lines || []}
            empty="لا يوجد مخزون موثق في هذا التاريخ"
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
        <div style={{ marginBottom: "0.75rem" }}>
          <ProductPicker
            onPick={addItem}
            scope={isBakery ? null : "retail"}
            membership={isBakery ? "bakery" : null}
            placeholder={isBakery ? "ابحث عن صنف مخبز…" : undefined}
          />
        </div>
        <div className="ui-table-wrap" style={{ marginBottom: "0.75rem" }}>
          <table className="ui-table">
            <thead><tr><th>الصنف</th><th>الكمية</th><th></th></tr></thead>
            <tbody>
              {transferItems.length === 0 && <tr><td colSpan={3} style={{ textAlign: "center", color: "var(--office-panel-muted)", padding: "1rem" }}>أضف أصنافاً</td></tr>}
              {transferItems.map((it, i) => (
                <tr key={it.product_id}>
                  <td>{it.name}</td>
                  <td><QtyStepper className="ui-input" style={{ width: 140 }} min={0} value={it.quantity} onChange={(e) => setTransferItems((prev) => prev.map((x, idx) => idx === i ? { ...x, quantity: e.target.value } : x))} /></td>
                  <td><Button variant="ghost" size="sm" icon="trash" aria-label="حذف" onClick={() => setTransferItems((p) => p.filter((_, idx) => idx !== i))} /></td>
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
