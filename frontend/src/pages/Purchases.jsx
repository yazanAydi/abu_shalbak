import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils, dateOnly, qty as fmtQty } from "../utils/format";
import ProductPicker from "../components/ProductPicker";
import { fetchLastPurchaseCost } from "../utils/productSearch";
import SellPriceUpdateModal from "./SellPriceUpdateModal";
import {
  PageHeader, Button, DataTable, Modal, Tabs, StatusPill,
  FormField, FormGrid, Input, Textarea, Select, Icon, ReportToolbar, useToast,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";
import { printPurchaseDoc } from "../utils/purchaseDocPrint";
import QtyStepper from "../components/QtyStepper";
import { handleEnterNavKeyDown } from "../utils/focusNavigation";
import { computePurchaseEditorTotals, computePurchaseLinePayable, computePurchaseLineVat, computePurchaseSimpleTotal, deriveTotalCost, deriveUnitCost, formatCostInput, formatDiscountPercent, formatTaxRatePercent } from "../utils/purchaseTotals";
import "./purchase-item-editor.css";

const STATUS_TONE = { draft: "neutral", posted: "green", confirmed: "blue", received: "green", cancelled: "red" };
const STATUS_LABEL = { draft: "مسودة", posted: "مرحّلة", confirmed: "مؤكد", received: "مستلم", cancelled: "ملغي" };

function selectInputOnFocus(e) {
  e.target.select();
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Fetch a product's configured units and pick a sensible purchase default.
export async function fetchProductUnits(productId) {
  try {
    const { data } = await api.get(`/api/products/${productId}/units`, { headers: getAuthHeaders() });
    return Array.isArray(data.units) ? data.units : [];
  } catch {
    return [];
  }
}

function pickDefaultPurchaseUnit(units) {
  const purchasable = units.filter((u) => u.purchase_enabled !== false);
  const pool = purchasable.length ? purchasable : units;
  const def =
    pool.find((u) => u.is_default_purchase) ||
    pool.find((u) => u.is_default) ||
    pool[0];
  return def ? def.id : null;
}

/** Supplier-style summary block (matches PALCO invoice layout). */
function PurchaseSummaryFooter({ withVat, vatTotals, simpleTotals }) {
  const listTotal = withVat ? vatTotals?.listGrossTotal : simpleTotals?.listGrossTotal;
  const discountSaved = withVat ? vatTotals?.discountSaved : simpleTotals?.discountSaved;
  const discountPct = withVat ? vatTotals?.effectiveDiscountPct : simpleTotals?.effectiveDiscountPct;
  const afterDiscount = withVat ? vatTotals?.grossTotal : simpleTotals?.total;
  const hasDiscount = (discountSaved ?? 0) > 0;

  if (listTotal == null && afterDiscount == null) return null;

  const rows = [
    { label: "المجموع (يشمل ض.ق.م)", value: ils(listTotal ?? 0), muted: false },
    ...(hasDiscount
      ? [
          { label: `الخصم ${formatDiscountPercent(discountPct)}%`, value: ils(discountSaved), muted: true },
          { label: "بعد الخصم", value: ils(afterDiscount ?? 0), muted: true },
        ]
      : []),
    ...(withVat && vatTotals
      ? [{ label: `ضريبة ${formatTaxRatePercent(vatTotals.rate)}%`, value: ils(vatTotals.vat), muted: true }]
      : []),
    { label: "الصافي", value: ils(afterDiscount ?? 0), grand: true },
  ];

  return (
    <table className="purchase-summary-table" style={{ marginTop: "0.75rem", marginInlineStart: "auto", borderCollapse: "collapse", fontSize: "0.95rem" }}>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label} style={row.grand ? { background: "var(--office-panel-muted-bg, #eef2f7)", fontWeight: 700 } : undefined}>
            <td style={{ padding: "0.35rem 1rem 0.35rem 0", textAlign: "right", color: row.muted ? "var(--office-panel-muted)" : undefined, whiteSpace: "nowrap" }}>
              {row.label}
            </td>
            <td className="num" style={{ padding: "0.35rem 0", textAlign: "left", fontWeight: row.grand ? 700 : 500, minWidth: 90 }}>
              {row.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ItemEditor({ items, setItems, withVat, defaultTaxRate = 0, scope = "retail" }) {
  const [sellPricePrompt, setSellPricePrompt] = useState(null);

  async function addProduct(p) {
    let exists = false;
    setItems((prev) => {
      exists = prev.some((x) => x.product_id === p.id);
      return prev;
    });
    if (exists) return;
    const [units, pricing] = await Promise.all([
      fetchProductUnits(p.id),
      fetchLastPurchaseCost(p.id),
    ]);
    const last = pricing?.last_purchase;
    const lastCost = last?.unit_cost ?? null;
    let unitId = pickDefaultPurchaseUnit(units);
    if (last?.product_unit_id && units.some((u) => u.id === Number(last.product_unit_id))) {
      unitId = Number(last.product_unit_id);
    }
    const unitCostStr = lastCost != null ? formatCostInput(lastCost) : "";
    const totalCostStr = unitCostStr !== "" ? deriveTotalCost(unitCostStr, 1) : "";
    setItems((prev) => {
      if (prev.some((x) => x.product_id === p.id)) return prev;
      return [
        ...prev,
        {
          product_id: p.id,
          name: p.name,
          barcode: p.barcode,
          quantity: 1,
          unit_id: unitId,
          units,
          total_cost: totalCostStr,
          unit_cost: unitCostStr,
          cost_mode: unitCostStr !== "" ? "unit" : "total",
          discount_pct: "",
          bonus_quantity: "",
          last_purchase_cost: lastCost,
          sell_price: pricing?.sell_price ?? p.price ?? null,
          min_price: pricing?.min_price ?? p.min_price ?? null,
          max_price: pricing?.max_price ?? p.max_price ?? null,
          sell_price_prompted_for: null,
        },
      ];
    });
  }
  function handleUnitCostBlur(i) {
    const it = items[i];
    if (!it) return;
    const entered = round2(Number(it.unit_cost));
    const last = it.last_purchase_cost;
    if (last == null || !Number.isFinite(entered) || entered <= 0) return;
    if (round2(last) === entered) return;
    if (it.sell_price_prompted_for === entered) return;

    const ok = window.confirm("سعر الشراء اختلف عن آخر سعر — هل تريد تغيير سعر البيع؟");
    setItems((prev) => prev.map((x, idx) => (
      idx === i ? { ...x, sell_price_prompted_for: entered } : x
    )));
    if (ok) {
      setSellPricePrompt({
        index: i,
        productId: it.product_id,
        name: it.name,
        oldSellPrice: it.sell_price,
        newPurchaseCost: entered,
        min_price: it.min_price,
        max_price: it.max_price,
      });
    }
  }
  function handleSellPriceSaved(newPrice) {
    if (sellPricePrompt == null) return;
    setItems((prev) => prev.map((x, idx) => (
      idx === sellPricePrompt.index ? { ...x, sell_price: newPrice } : x
    )));
    setSellPricePrompt(null);
  }
  function update(i, key, val) {
    setItems((prev) => prev.map((x, idx) => (idx === i ? { ...x, [key]: val } : x)));
  }
  function updateTotalCost(i, val) {
    setItems((prev) => prev.map((x, idx) => {
      if (idx !== i) return x;
      const qty = Number(x.quantity) || 0;
      return {
        ...x,
        total_cost: val,
        unit_cost: deriveUnitCost(val, qty),
        cost_mode: "total",
      };
    }));
  }
  function updateUnitCost(i, val) {
    setItems((prev) => prev.map((x, idx) => {
      if (idx !== i) return x;
      const qty = Number(x.quantity) || 0;
      return {
        ...x,
        unit_cost: val,
        total_cost: deriveTotalCost(val, qty),
        cost_mode: "unit",
      };
    }));
  }
  function updateQuantity(i, val) {
    setItems((prev) => prev.map((x, idx) => {
      if (idx !== i) return x;
      const qty = Number(val) || 0;
      if (x.cost_mode === "unit" && x.unit_cost !== "") {
        return { ...x, quantity: val, total_cost: deriveTotalCost(x.unit_cost, qty) };
      }
      if (x.total_cost !== "") {
        return { ...x, quantity: val, unit_cost: deriveUnitCost(x.total_cost, qty) };
      }
      return { ...x, quantity: val };
    }));
  }
  function applyUnitSuggestion(i, unitId, quantity) {
    setItems((prev) => prev.map((x, idx) => {
      if (idx !== i) return x;
      const qty = Number(quantity) || 0;
      const next = { ...x, unit_id: unitId, quantity };
      if (x.cost_mode === "unit" && x.unit_cost !== "") {
        next.total_cost = deriveTotalCost(x.unit_cost, qty);
      } else if (x.total_cost !== "") {
        next.unit_cost = deriveUnitCost(x.total_cost, qty);
      }
      return next;
    }));
  }
  function remove(i) { setItems((prev) => prev.filter((_, idx) => idx !== i)); }

  const simpleTotals = !withVat ? computePurchaseSimpleTotal(items) : null;
  const vatTotals = withVat ? computePurchaseEditorTotals(items, defaultTaxRate) : null;
  const colSpan = 9;

  return (
    <div className="purchase-item-editor" data-enter-nav="" onKeyDown={handleEnterNavKeyDown}>
      <div style={{ marginBottom: "0.75rem" }}>
        <ProductPicker onPick={addProduct} scope={scope} />
      </div>
      {withVat ? (
        <div className="purchase-item-editor__hint">الأسعار شامل ضريبة القيمة المضافة</div>
      ) : null}
      <div className="ui-table-wrap">
        <table className="ui-table">
          <colgroup>
            <col style={{ width: "20%" }} />
            <col style={{ width: "9%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "7%" }} />
            <col style={{ width: "9%" }} />
            <col style={{ width: "11%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "14%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>الصنف</th>
              <th>الوحدة</th>
              <th title="كلفة الوحدة">سعر</th>
              <th>الكمية</th>
              <th title="خصم %">خصم</th>
              <th title="بونص مجاني">بونص</th>
              <th title="إجمالي الكلفة قبل الخصم">إجمالي</th>
              <th title="الإجمالي بعد الخصم">الإجمالي</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={colSpan} style={{ textAlign: "center", color: "var(--office-panel-muted)", padding: "1rem" }}>أضف أصنافاً</td></tr>}
            {items.map((it, i) => {
              const qtyNum = Number(it.quantity) || 0;
              const bonusNum = Number(it.bonus_quantity) || 0;
              const totalNum = Number(it.total_cost) || 0;
              const lineVat = withVat
                ? computePurchaseLineVat(it.total_cost, it.discount_pct, "", defaultTaxRate)
                : null;
              const linePayable = !withVat ? computePurchaseLinePayable(it.total_cost, it.discount_pct) : null;
              const units = Array.isArray(it.units) ? it.units : [];
              const purchasable = units.filter((u) => u.purchase_enabled !== false);
              const selectable = purchasable.length ? purchasable : units;
              const selectedUnit = units.find((u) => u.id === Number(it.unit_id));
              const conv = selectedUnit ? Number(selectedUnit.conversion_to_base) || 1 : 1;
              const baseQty = qtyNum * conv;
              const bonusBaseQty = bonusNum * conv;
              const stockBaseQty = baseQty + bonusBaseQty;
              // Smart suggest: entering pieces (conv 1) that divide evenly into a
              // larger purchasable unit -> offer a one-click switch (never auto).
              let suggestion = null;
              if (conv === 1 && qtyNum > 1) {
                const larger = selectable
                  .filter((u) => (Number(u.conversion_to_base) || 1) > 1 && qtyNum % (Number(u.conversion_to_base) || 1) === 0)
                  .sort((a, b) => (Number(b.conversion_to_base) || 1) - (Number(a.conversion_to_base) || 1))[0];
                if (larger) {
                  const packConv = Number(larger.conversion_to_base) || 1;
                  suggestion = { unit: larger, count: qtyNum / packConv };
                }
              }
              return (
              <tr key={it.product_id}>
                <td className="purchase-item-editor__name" title={it.name}>{it.name}</td>
                <td>
                  {selectable.length > 0 ? (
                    <select className="ui-input" value={it.unit_id ?? ""} onChange={(e) => update(i, "unit_id", e.target.value ? Number(e.target.value) : null)}>
                      {selectable.map((u) => <option key={u.id} value={u.id}>{u.unit_name}</option>)}
                    </select>
                  ) : <span style={{ color: "var(--office-panel-muted)" }}>—</span>}
                </td>
                <td>
                  <input className="ui-input" type="number" min="0" step="0.01" placeholder="0" value={it.unit_cost ?? ""} onFocus={selectInputOnFocus} onChange={(e) => updateUnitCost(i, e.target.value)} onBlur={() => handleUnitCostBlur(i)} />
                </td>
                <td>
                  <QtyStepper className="ui-input" min={0} value={it.quantity} onFocus={selectInputOnFocus} onChange={(e) => updateQuantity(i, e.target.value)} />
                  {conv > 1 && qtyNum > 0 ? <div className="purchase-item-editor__meta">= {fmtQty(baseQty)} حبة</div> : null}
                  {suggestion ? (
                    <button
                      type="button"
                      className="purchase-item-editor__suggest"
                      onClick={() => applyUnitSuggestion(i, suggestion.unit.id, suggestion.count)}
                    >
                      هل تقصد {fmtQty(suggestion.count)} {suggestion.unit.unit_name}؟
                    </button>
                  ) : null}
                </td>
                <td><input className="ui-input" type="number" min="0" max="100" step="0.1" placeholder="0" value={it.discount_pct ?? ""} onFocus={selectInputOnFocus} onChange={(e) => update(i, "discount_pct", e.target.value)} /></td>
                <td>
                  <QtyStepper className="ui-input" min={0} value={it.bonus_quantity ?? ""} onFocus={selectInputOnFocus} onChange={(e) => update(i, "bonus_quantity", e.target.value)} />
                  {bonusNum > 0 ? (
                    <div className="purchase-item-editor__meta purchase-item-editor__meta--accent">
                      + {fmtQty(bonusNum)} بونص{stockBaseQty > baseQty ? ` = ${fmtQty(stockBaseQty)} حبة` : ""}
                    </div>
                  ) : null}
                </td>
                <td><input className="ui-input" type="number" min="0" step="0.01" placeholder="0" value={it.total_cost} onFocus={selectInputOnFocus} onChange={(e) => updateTotalCost(i, e.target.value)} /></td>
                <td className="num purchase-item-editor__total-final">{ils(lineVat ? lineVat.lineTotal : linePayable ? linePayable.payable : totalNum)}</td>
                <td className="purchase-item-editor__actions"><Button variant="ghost" size="sm" icon="trash" onClick={() => remove(i)} /></td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <PurchaseSummaryFooter withVat={withVat} vatTotals={vatTotals} simpleTotals={simpleTotals} />
      <SellPriceUpdateModal
        open={sellPricePrompt != null}
        onClose={() => setSellPricePrompt(null)}
        productId={sellPricePrompt?.productId}
        productName={sellPricePrompt?.name}
        oldSellPrice={sellPricePrompt?.oldSellPrice}
        newPurchaseCost={sellPricePrompt?.newPurchaseCost}
        minPrice={sellPricePrompt?.min_price}
        maxPrice={sellPricePrompt?.max_price}
        onSaved={handleSellPriceSaved}
      />
    </div>
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

  async function fillFormFromDoc(which, data, id) {
    setSupplierId(String(data.supplier_id));
    const docDateValue = which === "returns" ? data.return_date : which === "orders" ? data.order_date : data.invoice_date;
    setDocDate(docDateValue?.slice(0, 10) || new Date().toISOString().slice(0, 10));
    setRefText(data.ref_text || "");
    setNotes(data.notes || "");
    const docItems = data.items || [];
    const mapped = await Promise.all(
      docItems.map(async (it) => {
        const [units, pricing] = await Promise.all([
          fetchProductUnits(it.product_id),
          fetchLastPurchaseCost(it.product_id),
        ]);
        const qty = Number(it.quantity) || 0;
        const totalCost = it.total_cost;
        const unitCost = it.unit_cost != null && it.unit_cost !== ""
          ? it.unit_cost
          : deriveUnitCost(totalCost, qty);
        return {
          product_id: it.product_id,
          name: it.name,
          barcode: it.barcode,
          quantity: it.quantity,
          unit_id: it.product_unit_id ?? pickDefaultPurchaseUnit(units),
          units,
          total_cost: totalCost,
          unit_cost: unitCost,
          cost_mode: "total",
          discount_pct: it.discount_pct != null && it.discount_pct !== 0 ? it.discount_pct : "",
          bonus_quantity: it.bonus_quantity != null && it.bonus_quantity !== 0 ? it.bonus_quantity : "",
          last_purchase_cost: pricing?.last_purchase?.unit_cost ?? null,
          sell_price: pricing?.sell_price ?? null,
          min_price: pricing?.min_price ?? null,
          max_price: pricing?.max_price ?? null,
          sell_price_prompted_for: null,
        };
      })
    );
    setItems(mapped);
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
        unit_id: it.unit_id != null ? Number(it.unit_id) : undefined,
        total_cost: Number(it.total_cost),
        discount_pct: it.discount_pct === "" ? undefined : Number(it.discount_pct),
        bonus_quantity: it.bonus_quantity === "" ? undefined : Number(it.bonus_quantity),
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
      <PageHeader icon="purchases" title="فتورة مشتريات" subtitle="فواتير وأوامر ومرتجعات الشراء"
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

      <Modal open={showForm} title={editId ? "تعديل المسودة" : newLabel} onClose={() => { setShowForm(false); setEditId(null); }} size="xl"
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
        <ItemEditor items={items} setItems={setItems} withVat={tab === "invoices"} defaultTaxRate={store.default_tax_rate} />
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
                { key: "unit_name", header: "الوحدة", render: (it) => it.unit_name || "—" },
                { key: "quantity", header: "الكمية", align: "left", render: (it) => fmtQty(it.quantity) },
                { key: "base_quantity", header: "بالحبة", align: "left", render: (it) => fmtQty(it.base_quantity ?? it.quantity) },
                { key: "total_cost", header: "إجمالي الكلفة", align: "left", className: "num", render: (it) => ils(it.total_cost) },
                { key: "discount_pct", header: "خصم %", align: "left", render: (it) => (it.discount_pct ? `${it.discount_pct}%` : "—") },
                { key: "bonus_quantity", header: "بونص", align: "left", render: (it) => (it.bonus_quantity ? fmtQty(it.bonus_quantity) : "—") },
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

export { pickDefaultPurchaseUnit, ItemEditor };
