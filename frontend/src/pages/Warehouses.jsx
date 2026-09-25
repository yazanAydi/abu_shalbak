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
  FormField, FormGrid, Input, Select, Textarea, Icon, ReportToolbar, FilterBar, HelpPanel, useToast,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";

const WH_TYPES = { main: "رئيسي", store: "متجر", returns: "مرتجعات", damaged: "تالف" };

function formatUnitCost(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "التكلفة غير محددة";
  return `₪${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

function qtyWithUnit(row) {
  const qty = fmtQty(row.quantity);
  return row.unit_name ? `${qty} ${row.unit_name}` : qty;
}

export default function Warehouses({ workspace = null }) {
  const isBakery = workspace === "bakery";
  const toast = useToast();
  const [tab, setTab] = useState("warehouses");
  const [warehouses, setWarehouses] = useState([]);
  const [stock, setStock] = useState([]);
  const [valuation, setValuation] = useState(null);
  const [asOf, setAsOf] = useState("");
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
        const data = (await api.get("/api/warehouses/valuation", { headers: getAuthHeaders(), params: catalogParams() })).data;
        setValuation(data);
        const day = data?.shop_business_day;
        if (day) setAsOf((current) => (!current || current > day ? day : current));
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
    { key: "category_label", header: "التصنيف الحالي", value: (r) => r.category_label || "غير مصنف", render: (r) => r.category_label || "غير مصنف" },
    { key: "product_name", header: "الصنف", value: (r) => r.cross_scope_label ? `${r.product_name || "—"} — ${r.cross_scope_label}` : (r.product_name || "—"), render: (r) => r.cross_scope_label ? `${r.product_name || "—"} — ${r.cross_scope_label}` : (r.product_name || "—") },
    { key: "warehouse_name", header: "المستودع" },
    { key: "quantity", header: "الكمية", value: (r) => qtyWithUnit(r), render: (r) => qtyWithUnit(r) },
    { key: "unit_cost", header: "تكلفة المخزون", value: (r) => (r.cost_known ? formatUnitCost(r.unit_cost) : "التكلفة غير محددة"), render: (r) => (r.cost_known ? formatUnitCost(r.unit_cost) : "التكلفة غير محددة") },
    { key: "value", header: "القيمة", value: (r) => (r.cost_known ? ils(r.value) : "—"), render: (r) => (r.cost_known ? ils(r.value) : "—") },
  ];

  const reportConfig = useMemo(() => {
    if (tab === "transfers") {
      return { title: "تحويلات المستودعات", columns: pickExportColumns(transferColumns), rows: transfers, filename: "warehouse-transfers" };
    }
    if (tab === "stock") {
      return { title: isBakery ? "مخزون مستودعات المخبز" : "تقرير مخزون المستودعات", columns: stockColumns, rows: stock, filename: isBakery ? "bakery-warehouse-stock" : "warehouse-stock" };
    }
    if (tab === "valuation" && valuation) {
      const when = valuation.as_of_label || asOf || "حتى الآن";
      const unavailable = valuation.status === "unavailable";
      const totalLabel = valuation.money_label || valuation.basis_label || (valuation.valuation_complete ? "إجمالي قيمة المخزون" : "القيمة المعروفة");
      const totalValue = unavailable
        ? "لا تتوفر بيانات كافية للتقييم"
        : valuation.valuation_complete
          ? ils(valuation.grand_total)
          : (valuation.known_subtotal == null ? "لا تتوفر بيانات كافية للتقييم" : ils(valuation.known_subtotal));
      return {
        title: isBakery ? "تقييم مخزون المخبز" : "تقييم المخزون",
        subtitle: `${valuation.basis_label || "تقييم المخزون"} — ${when}`,
        columns: valuationColumns,
        rows: valuation.lines || [],
        filename: isBakery ? "bakery-warehouse-valuation" : "warehouse-valuation",
        meta: [
          `التاريخ: ${when}`,
          `يوم العمل: ${valuation.shop_business_day || ""}`,
          `أساس التقييم: ${valuation.basis_label || ""}`,
          `التجميع: ${valuation.classification?.label || "التصنيف الحالي"}`,
          valuation.classification?.note || "",
          valuation.ownership_note || "",
          valuation.date_rule || "",
          valuation.cross_scope_note || "",
          `اكتمال التقييم: ${valuation.status === "complete" || valuation.valuation_complete ? "مكتمل" : (valuation.status === "empty" ? "لا يوجد مخزون" : (unavailable ? "لا تتوفر بيانات كافية" : "جزئي"))}`,
        ].filter(Boolean),
        summary: [
          { label: "التاريخ", value: when },
          { label: "أساس التقييم", value: valuation.basis_label || "" },
          { label: totalLabel, value: totalValue },
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
        ...(isBakery ? [] : [{ id: "transfers", label: "التحويلات", icon: "deliveries" }]),
        { id: "stock", label: isBakery ? "الرئيسي والمرتجع والتالف" : "تقرير المخزون", icon: "inventory" },
        { id: "valuation", label: "تقييم المخزون", icon: "finance" },
      ]} />

      {(tab === "stock" || tab === "valuation") && (
        <FilterBar onReset={q ? () => setQ("") : undefined}>
          {tab === "valuation" && (
            <FormField label="التاريخ" className="ui-field--date">
              <Input
                type="date"
                yearDigits={4}
                value={asOf}
                max={valuation?.shop_business_day || asOf || undefined}
                aria-label="تقييم المخزون بتاريخ"
                onChange={(e) => setAsOf(e.target.value)}
              />
            </FormField>
          )}
          <FormField label="بحث" className="ui-field--grow">
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
                <div className="ui-stat__label">{valuation.money_label || valuation.basis_label} ({valuation.as_of_label})</div>
                <div className="ui-stat__value">
                  {valuation.status === "unavailable"
                    ? "لا تتوفر بيانات كافية للتقييم"
                    : valuation.known_subtotal == null && valuation.grand_total == null
                      ? (valuation.status_message || "لا تتوفر بيانات كافية للتقييم")
                      : ils(valuation.valuation_complete ? valuation.grand_total : valuation.known_subtotal)}
                </div>
              </div>
            </div>
          </div>
          {valuation.status === "partial" && valuation.status_message && valuation.known_subtotal != null && (
            <p style={{ margin: "0.35rem 0 0.75rem", fontWeight: 700 }}>{valuation.status_message}</p>
          )}
          {valuation.status === "empty" && (
            <p style={{ margin: "0.35rem 0 0.75rem", fontWeight: 700 }}>{valuation.status_message}</p>
          )}
          {valuation.classification?.note && (
            <p style={{ margin: "0.35rem 0 0.75rem" }}>{valuation.classification.note}</p>
          )}
          {valuation.ownership_note && (
            <p style={{ margin: "0.35rem 0 0.75rem" }}>{valuation.ownership_note}</p>
          )}
          {valuation.cross_scope_note && (
            <p style={{ margin: "0.35rem 0 0.75rem", fontWeight: 700 }}>{valuation.cross_scope_note}</p>
          )}
          {valuation.date_rule && (
            <p style={{ margin: "0.35rem 0 0.75rem" }}>{valuation.date_rule}</p>
          )}
          {valuation.boundary_note && (
            <p style={{ margin: "0.35rem 0 0.75rem" }}>{valuation.boundary_note}</p>
          )}
          {(valuation.category_groups || []).length > 0 ? (
            valuation.category_groups.map((group) => (
              <div key={group.category_name || "uncategorized"} style={{ marginTop: "0.75rem" }}>
                <div style={{ fontWeight: 700, marginBottom: "0.2rem" }}>
                  {group.grouping_label || "التصنيف الحالي"}: {group.category_label}
                  {group.known_value != null ? ` — ${group.money_label ? `${group.money_label}: ` : ""}${ils(group.known_value)}` : ""}
                </div>
                <div style={{ marginBottom: "0.35rem" }}>
                  {(group.warehouses || []).map((wh) => (
                    <span key={wh.warehouse_id} style={{ marginInlineEnd: "0.85rem" }}>
                      {wh.warehouse_name}: {fmtQty(wh.total_qty)}
                      {" — "}
                      {wh.known_value == null
                        ? "التكلفة غير محددة"
                        : `${wh.money_label ? `${wh.money_label}: ` : ""}${ils(wh.known_value)}`}
                    </span>
                  ))}
                  {(Number(group.cross_scope_qty) !== 0 || group.cross_scope_known_value != null || Number(group.cross_scope_unvalued_count) > 0) && (
                    <div>
                      خارج مجموع المخبز: {fmtQty(group.cross_scope_qty)}
                      {" — "}
                      {group.cross_scope_known_value == null ? "التكلفة غير محددة" : ils(group.cross_scope_known_value)}
                    </div>
                  )}
                </div>
                <DataTable columns={valuationColumns} rows={group.lines || []} empty="" />
              </div>
            ))
          ) : (
            <DataTable
              columns={valuationColumns}
              rows={[]}
              empty={valuation.status === "unavailable"
                ? "لا توجد أصناف مقيّمة لهذا التاريخ"
                : valuation.status === "empty"
                  ? "لا يوجد مخزون"
                  : "لا توجد أصناف مطابقة"}
            />
          )}
          {(valuation.excluded_products || []).length > 0 && (
            <div style={{ marginTop: "0.75rem" }}>
              <div style={{ fontWeight: 700, marginBottom: "0.35rem" }}>أصناف لم تُقيَّم</div>
              <DataTable
                columns={[
                  { key: "product_name", header: "الصنف" },
                  { key: "reason_ar", header: "السبب", value: (r) => r.reason_ar || r.reason, render: (r) => r.reason_ar || r.reason },
                ]}
                rows={valuation.excluded_products}
                empty=""
              />
            </div>
          )}
          <HelpPanel title="تفاصيل التقييم">
            {valuation.basis === "current_inventory_cost" ? (
              <p>هذا عرض للكمية الحالية مضروبة في تكلفة المخزون المعروفة. يختلف عن التقييم المحاسبي لتاريخ سابق.</p>
            ) : (
              <p>هذا تقييم تاريخي من الحركات المسجّلة حتى التاريخ المختار. لا تُستخدم كميات اليوم ولا تكلفته.</p>
            )}
            {valuation.classification?.note ? <p>{valuation.classification.note}</p> : null}
            {valuation.backdated_note ? <p>{valuation.backdated_note}</p> : null}
            {valuation.costing_note ? <p>{valuation.costing_note}</p> : null}
            {(valuation.unexplained_rounding || []).length > 0 && (
              <p>فروقات تقريب: {valuation.unexplained_rounding.map((row) => `${row.product_name} ${row.amount}`).join("، ")}</p>
            )}
            {(valuation.unreconciled_products || []).length > 0 && (
              <p>أصناف غير مسوّاة: {valuation.unreconciled_products.map((row) => `${row.product_name}${row.reason_ar ? ` — ${row.reason_ar}` : ""}`).join("، ")}</p>
            )}
            {valuation.document_date_estimate && (
              <p>
                {valuation.document_date_estimate.note}{" "}
                {valuation.document_date_estimate.lines.map((row) => `${row.product_name}: مسجّل ${row.recorded_value} / تقدير ${row.estimate_value}`).join("، ")}
              </p>
            )}
            {(valuation.supplier_returns || []).length > 0 && (
              <p>مرتجعات مورّدين مرحّلة خرجت من الملكية: {valuation.supplier_returns.map((row) => `${row.product_name} ${fmtQty(row.quantity)}`).join("، ")}</p>
            )}
          </HelpPanel>
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
