import { apiErrorMessage } from "../utils/apiError";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSubmitGuard } from "../hooks/useSubmitGuard";
import { todayISO } from "../utils/format";
import { storePurchaseReturnPrefill } from "../utils/purchaseReturnPrefill";
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
import { batchSourceLabel } from "../utils/stockBatchLabels";
import { warehouseChoiceLabel, warehouseDisplayName, warehouseTypeLabel } from "../utils/inventoryLabels";

function formatUnitCost(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "التكلفة غير محددة";
  return `₪${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

function qtyWithUnit(row) {
  const qty = fmtQty(row.quantity);
  return row.unit_name ? `${qty} ${row.unit_name}` : qty;
}

const RETURN_PAGE_SIZE = 25;

export default function Warehouses({ workspace = null }) {
  const isBakery = workspace === "bakery";
  const toast = useToast();
  const navigate = useNavigate();
  const guardSubmit = useSubmitGuard();
  const [tab, setTab] = useState("warehouses");
  const [warehouses, setWarehouses] = useState([]);
  const [stock, setStock] = useState([]);
  const [valuation, setValuation] = useState(null);
  const [asOf, setAsOf] = useState("");
  const [transfers, setTransfers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [returnSupplier, setReturnSupplier] = useState(null);
  const [supplierQuery, setSupplierQuery] = useState("");
  const [supplierHits, setSupplierHits] = useState([]);
  const [returnRows, setReturnRows] = useState([]);
  const [returnTotal, setReturnTotal] = useState(0);
  const [returnPage, setReturnPage] = useState(0);
  const [returnLoading, setReturnLoading] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedLots, setSelectedLots] = useState({});
  const [assignLot, setAssignLot] = useState(null);
  const [assignSuppliers, setAssignSuppliers] = useState([]);
  const [assignSupplierId, setAssignSupplierId] = useState("");
  const [assignQty, setAssignQty] = useState("");

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

  useEffect(() => {
    setSelectedLots({});
    setSelectMode(false);
    setReturnPage(0);
    setReturnRows([]);
    setReturnTotal(0);
  }, [returnSupplier, qDebounced, isBakery]);

  useEffect(() => {
    if (!assignLot) return undefined;
    let cancelled = false;
    api.get("/api/suppliers", { headers: getAuthHeaders(), params: { all: "1" } })
      .then(({ data }) => { if (!cancelled) setAssignSuppliers(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancelled) setAssignSuppliers([]); });
    return () => { cancelled = true; };
  }, [assignLot]);

  useEffect(() => {
    if (tab !== "stock") return undefined;
    const query = supplierQuery.trim();
    if (query.length < 1) {
      setSupplierHits([]);
      return undefined;
    }
    const timer = window.setTimeout(async () => {
      try {
        const { data } = await api.get("/api/suppliers", {
          headers: getAuthHeaders(),
          params: { q: query },
        });
        setSupplierHits(Array.isArray(data) ? data : []);
      } catch {
        setSupplierHits([]);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [supplierQuery, tab]);

  const loadReturnLots = useCallback(async (page = returnPage) => {
    if (!returnSupplier) return { rows: [], total: 0 };
    const params = {
      limit: RETURN_PAGE_SIZE,
      offset: page * RETURN_PAGE_SIZE,
    };
    if (isBakery) params.membership = "bakery";
    if (qDebounced) params.q = qDebounced;
    if (returnSupplier.unknown) params.unknown = "1";
    else params.supplier_id = returnSupplier.id;
    const { data } = await api.get("/api/warehouses/returns-stock", { headers: getAuthHeaders(), params });
    return { rows: data?.rows || [], total: Number(data?.total) || 0 };
  }, [returnSupplier, returnPage, isBakery, qDebounced]);

  useEffect(() => {
    if (tab !== "stock" || !returnSupplier) return undefined;
    let cancelled = false;
    setReturnLoading(true);
    loadReturnLots(returnPage)
      .then((result) => {
        if (cancelled) return;
        setReturnRows(result.rows);
        setReturnTotal(result.total);
      })
      .catch((e) => {
        if (!cancelled) toast.error(apiErrorMessage(e, "تعذّر تحميل مرتجعات المورد"));
      })
      .finally(() => {
        if (!cancelled) setReturnLoading(false);
      });
    return () => { cancelled = true; };
  }, [tab, returnSupplier, returnPage, loadReturnLots, toast]);

  async function fetchAllReturnLots() {
    const params = { limit: "all", offset: 0 };
    if (isBakery) params.membership = "bakery";
    if (qDebounced) params.q = qDebounced;
    params.supplier_id = returnSupplier.id;
    const { data } = await api.get("/api/warehouses/returns-stock", { headers: getAuthHeaders(), params });
    return data?.rows || [];
  }

  function openPurchaseReturn(rows) {
    const lines = rows.filter((row) => row.eligible && Number(row.quantity) > 0);
    if (!returnSupplier?.id || lines.length === 0) return;
    storePurchaseReturnPrefill({
      supplierId: returnSupplier.id,
      lines: lines.map((row) => ({
        product_id: row.product_id,
        product_name: row.product_name,
        barcode: row.barcode,
        quantity: row.quantity,
        available: row.quantity,
        expiry_date: row.expiry_date,
        batch_source: row.batch_source,
        source_lot_id: row.source_lot_id,
        receipt_reference: row.receipt_reference,
        show_receipt_reference: row.show_receipt_reference,
      })),
    });
    navigate(`${isBakery ? "/bakery/returns" : "/purchases"}?prefill=1`);
  }

  const selectedList = Object.values(selectedLots);
  const pageEligible = returnRows.filter((row) => row.eligible);
  const pageAllSelected = pageEligible.length > 0 && pageEligible.every((row) => selectedLots[row.source_lot_id]);
  const returnPageCount = Math.max(1, Math.ceil(returnTotal / RETURN_PAGE_SIZE));

  function sourceLabel(it) {
    if (it.supplier_name || it.source_lot_id || it.supplier_id) {
      const who = it.supplier_name || "غير معروف";
      const expiry = it.batch_source === "undated" || !it.expiry_date ? "بدون تاريخ صلاحية" : dateOnly(it.expiry_date);
      const receipt = (it.show_receipt_reference && it.receipt_reference)
        ? ` — ${it.receipt_reference}`
        : (it.invoice_no ? ` — فاتورة ${it.invoice_no}` : "");
      return `${who} — ${expiry}${receipt}`;
    }
    const source = it.batch_source === "dated" || it.batch_source === "undated"
      ? it.batch_source
      : (it.expiry_date ? "dated" : "undated");
    return batchSourceLabel(source, it.expiry_date);
  }
  async function addItem(p) {
    if (!transferForm.from_warehouse_id) { toast.error("اختر المستودع المصدر أولاً"); return; }
    try {
      const { data } = await api.get(`/api/warehouses/${transferForm.from_warehouse_id}/sources`, {
        headers: getAuthHeaders(),
        params: { product_id: p.id },
      });
      const sources = Array.isArray(data) ? data : [];
      if (sources.length === 0) { toast.error("لا توجد كمية في المستودع المصدر"); return; }
      setTransferItems((prev) => {
        const next = [...prev];
        for (const source of sources) {
          const key = `${p.id}:${source.source_lot_id || source.batch_source}:${source.expiry_date || ""}`;
          if (next.some((row) => row.key === key)) continue;
          next.push({
            key,
            product_id: p.id,
            name: p.name,
            batch_source: source.batch_source,
            expiry_date: source.expiry_date,
            source_lot_id: source.source_lot_id || null,
            supplier_id: source.supplier_id || null,
            supplier_name: source.supplier_name || (source.supplier_id ? "" : "غير معروف"),
            receipt_reference: source.receipt_reference || null,
            show_receipt_reference: Boolean(source.show_receipt_reference),
            available: source.quantity,
            quantity: source.quantity,
          });
        }
        return next;
      });
    } catch (e) { toast.error(apiErrorMessage(e, "تعذّر تحميل المصادر")); }
  }
  async function saveTransfer() {
    if (!transferForm.from_warehouse_id || !transferForm.to_warehouse_id) { toast.error("حدّد المستودعين"); return; }
    if (transferItems.length === 0) { toast.error("أضف أصنافاً"); return; }
    try {
      const payload = {
        ...transferForm,
        items: transferItems.map((it) => ({
          product_id: it.product_id,
          quantity: Number(it.quantity),
          batch_source: it.batch_source || undefined,
          expiry_date: it.batch_source === "dated" ? it.expiry_date : undefined,
          source_lot_id: it.source_lot_id || undefined,
        })),
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
    setTransferItems((data.items || []).map((it) => ({
      key: `${it.product_id}:${it.batch_source || "auto"}:${it.expiry_date || ""}:${it.id || ""}`,
      product_id: it.product_id,
      name: it.name,
      quantity: it.quantity,
      batch_source: it.batch_source,
      expiry_date: it.expiry_date,
      available: it.quantity,
    })));
    setEditId(data.id);
    setShowTransfer(true);
  }

  const warehouseColumns = [
    { key: "name", header: "الاسم", value: (w) => warehouseDisplayName(w.name, w.type), render: (w) => <strong>{warehouseDisplayName(w.name, w.type)}</strong> },
    { key: "code", header: "الكود", value: (w) => w.code || "—", render: (w) => w.code || "—" },
    { key: "type", header: "النوع", value: (w) => warehouseTypeLabel(w.type), render: (w) => <StatusPill tone="blue" noDot>{warehouseTypeLabel(w.type)}</StatusPill> },
    { key: "active", header: "الحالة", value: (w) => (w.active ? "مفعّل" : "معطّل"), render: (w) => <StatusPill tone={w.active ? "green" : "neutral"}>{w.active ? "مفعّل" : "معطّل"}</StatusPill> },
  ];

  const transferColumns = [
    { key: "transfer_no", header: "رقم", value: (t) => `#${t.transfer_no ?? t.id}`, render: (t) => `#${t.transfer_no ?? t.id}` },
    { key: "from_name", header: "من", value: (t) => warehouseDisplayName(t.from_name), render: (t) => warehouseDisplayName(t.from_name) },
    { key: "to_name", header: "إلى", value: (t) => warehouseDisplayName(t.to_name), render: (t) => warehouseDisplayName(t.to_name) },
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
    { key: "warehouse_name", header: "المستودع", value: (r) => warehouseDisplayName(r.warehouse_name, r.type), render: (r) => warehouseDisplayName(r.warehouse_name, r.type) },
    { key: "product_name", header: "الصنف" },
    { key: "barcode", header: "الباركود", value: (r) => displayProductBarcode(r), render: (r) => displayProductBarcode(r) },
    { key: "sku", header: "رقم المنتج", value: (r) => displayProductSku(r.sku), render: (r) => displayProductSku(r.sku) },
    { key: "quantity", header: "الكمية", value: (r) => fmtQty(r.quantity), render: (r) => fmtQty(r.quantity) },
    { key: "value", header: "القيمة", value: (r) => ils(r.value), render: (r) => ils(r.value) },
  ];

  const valuationColumns = [
    { key: "category_label", header: "التصنيف الحالي", value: (r) => r.category_label || "غير مصنف", render: (r) => r.category_label || "غير مصنف" },
    { key: "product_name", header: "الصنف", value: (r) => r.cross_scope_label ? `${r.product_name || "—"} — ${r.cross_scope_label}` : (r.product_name || "—"), render: (r) => r.cross_scope_label ? `${r.product_name || "—"} — ${r.cross_scope_label}` : (r.product_name || "—") },
    { key: "warehouse_name", header: "المستودع", value: (r) => warehouseDisplayName(r.warehouse_name, r.warehouse_type || r.type), render: (r) => warehouseDisplayName(r.warehouse_name, r.warehouse_type || r.type) },
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
          ? "مواد المخبز وأصناف البيع تستخدم المخزن الرئيسي والمرتجعات. مرتجع المورد المرحّل خرج من الملكية."
          : "السوبرماركت يستخدم المخزن الرئيسي والمرتجعات. مرتجع المورد المرحّل خرج من الملكية."}
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
            {tab === "transfers" ? <Button icon="plus" onClick={() => { setEditId(null); setTransferForm({ from_warehouse_id: "", to_warehouse_id: "", transfer_date: todayISO(), notes: "" }); setTransferItems([]); setShowTransfer(true); }}>تحويل جديد</Button> : null}
          </>
        } />

      <Tabs active={tab} onChange={setTab} tabs={[
        { id: "warehouses", label: "المستودعات", icon: "warehouses" },
        { id: "transfers", label: "التحويلات", icon: "deliveries" },
        { id: "stock", label: "المخزن الرئيسي والمرتجعات", icon: "inventory" },
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
          {tab === "stock" && (
            <FormField label="المورد" className="ui-field--grow">
              <Input
                value={returnSupplier ? returnSupplier.name : supplierQuery}
                onChange={(e) => {
                  setReturnRows([]);
                  setReturnTotal(0);
                  setReturnSupplier(null);
                  setSupplierQuery(e.target.value);
                }}
                placeholder="ابحث عن مورد"
                aria-label="المورد"
              />
            </FormField>
          )}
        </FilterBar>
      )}

      {tab === "stock" && supplierHits.length > 0 && !returnSupplier && (
        <div className="ui-table-wrap" style={{ marginBottom: "0.75rem" }}>
          {supplierHits.map((supplier) => (
            <button
              key={supplier.id}
              type="button"
              className="ui-button ui-button--ghost"
              onClick={() => {
                setReturnRows([]);
                setReturnTotal(0);
                setReturnSupplier({ id: supplier.id, name: supplier.name, unknown: false });
                setSupplierQuery("");
                setSupplierHits([]);
              }}
            >
              {supplier.name}
            </button>
          ))}
        </div>
      )}

      {tab === "stock" && (
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
          <Button
            variant={returnSupplier?.unknown ? "primary" : "outline"}
            onClick={() => {
              setReturnRows([]);
              setReturnTotal(0);
              setReturnSupplier({ id: null, name: "غير معروف", unknown: true });
            }}
          >
            غير معروف
          </Button>
          {returnSupplier && (
            <Button variant="ghost" onClick={() => { setReturnSupplier(null); setSupplierQuery(""); }}>إلغاء اختيار المورد</Button>
          )}
        </div>
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

      {tab === "stock" && !returnSupplier && (
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

      {tab === "stock" && returnSupplier && (
        <>
          <p style={{ margin: "0 0 0.75rem" }}>
            {returnSupplier.unknown
              ? "مخزون مرتجعات بلا مورد. عيّن المورد قبل إنشاء مرتجع شراء."
              : `بضاعة ${returnSupplier.name} الموجودة في مرتجعات. ${returnTotal} مصدر.`}
          </p>
          {!returnSupplier.unknown && (
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
              <Button
                disabled={returnTotal === 0 || returnLoading}
                onClick={() => guardSubmit(async () => openPurchaseReturn(await fetchAllReturnLots()))}
              >
                {`إنشاء مرتجع شراء للكل (${returnTotal})`}
              </Button>
              <Button variant="outline" onClick={() => { setSelectMode((on) => !on); setSelectedLots({}); }}>
                تحديد أصناف
              </Button>
              {selectMode && (
                <>
                  <Button
                    variant="outline"
                    disabled={returnTotal === 0}
                    onClick={() => guardSubmit(async () => {
                      const rows = await fetchAllReturnLots();
                      const next = {};
                      rows.filter((row) => row.eligible).forEach((row) => { next[row.source_lot_id] = row; });
                      setSelectedLots(next);
                    })}
                  >
                    {`تحديد كل النتائج (${returnTotal})`}
                  </Button>
                  <Button
                    disabled={selectedList.length === 0}
                    onClick={() => guardSubmit(async () => openPurchaseReturn(selectedList))}
                  >
                    {`إنشاء مرتجع شراء للمحدد (${selectedList.length})`}
                  </Button>
                </>
              )}
            </div>
          )}
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead>
                <tr>
                  {selectMode && !returnSupplier.unknown && (
                    <th>
                      <label>
                        <input
                          type="checkbox"
                          aria-label="تحديد الصفحة"
                          checked={pageAllSelected}
                          onChange={() => {
                            setSelectedLots((prev) => {
                              const next = { ...prev };
                              if (pageAllSelected) pageEligible.forEach((row) => { delete next[row.source_lot_id]; });
                              else pageEligible.forEach((row) => { next[row.source_lot_id] = row; });
                              return next;
                            });
                          }}
                        />
                        {" "}تحديد الصفحة
                      </label>
                    </th>
                  )}
                  <th>الصنف</th>
                  <th>الباركود</th>
                  <th>تاريخ الصلاحية</th>
                  <th>الكمية المتاحة للإرجاع</th>
                  {returnSupplier.unknown && <th></th>}
                </tr>
              </thead>
              <tbody>
                {returnLoading && <tr><td colSpan={6}>جاري التحميل…</td></tr>}
                {!returnLoading && returnRows.length === 0 && <tr><td colSpan={6}>لا توجد كمية لهذا المورد في مرتجعات</td></tr>}
                {!returnLoading && returnRows.map((row) => (
                  <tr key={row.source_lot_id}>
                    {selectMode && !returnSupplier.unknown && (
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`تحديد ${row.product_name}`}
                          checked={Boolean(selectedLots[row.source_lot_id])}
                          onChange={() => setSelectedLots((prev) => {
                            const next = { ...prev };
                            if (next[row.source_lot_id]) delete next[row.source_lot_id];
                            else next[row.source_lot_id] = row;
                            return next;
                          })}
                        />
                      </td>
                    )}
                    <td>{row.product_name}</td>
                    <td>{displayProductBarcode(row)}</td>
                    <td>
                      {row.batch_source === "undated" || !row.expiry_date ? "بدون تاريخ صلاحية" : dateOnly(row.expiry_date)}
                      {row.show_receipt_reference && row.receipt_reference ? <div>{row.receipt_reference}</div> : null}
                      {row.supplier_name === "غير معروف" ? <div>غير معروف</div> : null}
                    </td>
                    <td>{fmtQty(row.quantity)}</td>
                    {returnSupplier.unknown && (
                      <td>
                        <Button size="sm" variant="outline" onClick={() => {
                          setAssignLot(row);
                          setAssignSupplierId("");
                          setAssignQty(String(row.quantity));
                        }}>تعيين المورد</Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {returnTotal > RETURN_PAGE_SIZE && (
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.75rem" }}>
              <Button variant="outline" disabled={returnPage <= 0} onClick={() => setReturnPage((page) => Math.max(0, page - 1))}>السابق</Button>
              <span>{`صفحة ${returnPage + 1} من ${returnPageCount}`}</span>
              <Button variant="outline" disabled={returnPage + 1 >= returnPageCount} onClick={() => setReturnPage((page) => page + 1)}>التالي</Button>
            </div>
          )}
        </>
      )}

      <Modal open={!!assignLot} title="تعيين مورد للمخزون غير المعروف" onClose={() => setAssignLot(null)}
        footer={<><Button onClick={() => guardSubmit(async () => {
          if (!assignLot || !assignSupplierId) { toast.error("اختر المورد"); return; }
          try {
            await api.post("/api/inventory/source-lots/assign", {
              source_lot_id: assignLot.source_lot_id,
              supplier_id: Number(assignSupplierId),
              quantity: Number(assignQty),
              note: "تعيين من مرتجعات",
            }, { headers: getAuthHeaders() });
            toast.success("تم تعيين المورد");
            setAssignLot(null);
            const result = await loadReturnLots(returnPage);
            setReturnRows(result.rows);
            setReturnTotal(result.total);
          } catch (e) { toast.error(apiErrorMessage(e, "تعذّر التعيين")); }
        })}>حفظ التعيين</Button><Button variant="secondary" onClick={() => setAssignLot(null)}>إلغاء</Button></>}>
        {assignLot && (
          <FormGrid>
            <FormField label="الصنف"><Input value={assignLot.product_name} readOnly /></FormField>
            <FormField label="الكمية"><Input type="number" min="0" value={assignQty} onChange={(e) => setAssignQty(e.target.value)} /></FormField>
            <FormField label="المورد" required>
              <Select value={assignSupplierId} onChange={(e) => setAssignSupplierId(e.target.value)}>
                <option value="">— اختر —</option>
                {assignSuppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
              </Select>
            </FormField>
          </FormGrid>
        )}
      </Modal>

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
                      {warehouseDisplayName(wh.warehouse_name, wh.type)}: {fmtQty(wh.total_qty)}
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

      <Modal open={showTransfer} title={editId ? "تعديل التحويل" : "تحويل بين المستودعات"} onClose={() => { setShowTransfer(false); setEditId(null); }} size="lg"
        footer={<><Button onClick={saveTransfer}>{editId ? "حفظ التعديلات" : "حفظ كمسودة"}</Button><Button variant="secondary" onClick={() => { setShowTransfer(false); setEditId(null); }}>إلغاء</Button></>}>
        <FormGrid>
          <FormField label="من مستودع" required>
            <Select value={transferForm.from_warehouse_id} onChange={(e) => { setTransferForm((f) => ({ ...f, from_warehouse_id: e.target.value })); setTransferItems([]); }}>
              <option value="">— اختر —</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{warehouseChoiceLabel(w)}</option>)}
            </Select>
          </FormField>
          <FormField label="إلى مستودع" required>
            <Select value={transferForm.to_warehouse_id} onChange={(e) => setTransferForm((f) => ({ ...f, to_warehouse_id: e.target.value }))}>
              <option value="">— اختر —</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{warehouseChoiceLabel(w)}</option>)}
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
            <thead><tr><th>الصنف</th><th>المورد والصلاحية</th><th>المتاح</th><th>الكمية</th><th></th></tr></thead>
            <tbody>
              {transferItems.length === 0 && <tr><td colSpan={5} style={{ textAlign: "center", color: "var(--office-panel-muted)", padding: "1rem" }}>أضف أصنافاً</td></tr>}
              {transferItems.map((it, i) => (
                <tr key={it.key || `${it.product_id}-${i}`}>
                  <td>{it.name}</td>
                  <td>{sourceLabel(it)}</td>
                  <td>{fmtQty(it.available)}</td>
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
              <div>من: <strong>{warehouseDisplayName(detail.from_name)}</strong> ← إلى: <strong>{warehouseDisplayName(detail.to_name)}</strong></div>
            </div>
            <DataTable
              columns={[
                { key: "name", header: "الصنف" },
                { key: "source", header: "المورد والصلاحية", render: (it) => sourceLabel(it) },
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
