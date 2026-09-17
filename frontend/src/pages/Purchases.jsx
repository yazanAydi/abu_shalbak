import { apiErrorMessage } from "../utils/apiError";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSubmitGuard } from "../hooks/useSubmitGuard";
import { todayISO } from "../utils/format";
import { Link, useSearchParams } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils, dateOnly, qty as fmtQty } from "../utils/format";
import InvoiceLineProductCell from "../components/invoice/InvoiceLineProductCell";
import { fetchLastPurchaseCost, fetchSupplierPurchaseUnitPrice, supplierPurchasePriceHint } from "../utils/productSearch";
import {
  completeInvoiceLines,
  focusInvoiceField,
  focusInvoiceProduct,
  handleInvoiceTableEnterKeyDown,
  invoiceLineQtyValid,
  newInvoiceLineKey,
} from "../utils/invoiceLineEntry";
import SellPriceUpdateModal from "./SellPriceUpdateModal";
import {
  PageHeader, Button, DataTable, Modal, Tabs, StatusPill, FilterBar,
  FormField, FormGrid, Input, Textarea, Select, ReportToolbar, useToast,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";
import { printPurchaseDoc } from "../utils/purchaseDocPrint";
import QtyStepper from "../components/QtyStepper";
import { computePurchaseEditorTotals, computePurchaseLinePayable, computePurchaseLineVat, computePurchaseSimpleTotal, deriveEffectiveUnitCost, deriveTotalCost, deriveUnitCost, formatCostInput, formatDiscountPercent, formatTaxRatePercent, lineHasPurchaseDiscount, purchaseQtyStepForUnit } from "../utils/purchaseTotals";
import PurchaseDocDetailItems from "./PurchaseDocDetailItems";
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

function itemBaseUnitName(it) {
  const units = Array.isArray(it.units) ? it.units : [];
  const base = units.find((u) => Number(u.conversion_to_base) === 1);
  if (base?.unit_name) return base.unit_name;
  if (it.product_unit) return it.product_unit;
  return "حبة";
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

function emptyPurchaseLine() {
  return {
    line_key: newInvoiceLineKey(),
    product_id: null,
    name: "",
    barcode: "",
    product_unit: null,
    is_weighed: 0,
    quantity: "",
    unit_id: null,
    units: [],
    total_cost: "",
    unit_cost: "",
    cost_mode: "unit",
    discount_pct: "",
    bonus_quantity: "",
    expiry_date: "",
    last_purchase_cost: null,
    sell_price: null,
    min_price: null,
    max_price: null,
    sell_price_prompted_for: null,
    priceManual: false,
    manualKey: null,
    suggestedKey: null,
    priceHint: "",
    priceMissing: false,
  };
}

function returnPriceContextKey(pricing, productId, unitId) {
  if (!pricing?.supplierId || !productId) return "";
  return [pricing.supplierId, productId, unitId || "", pricing.asOf || "", pricing.invoiceId || ""].join("|");
}

function ItemEditor({ items, setItems, withVat, defaultTaxRate = 0, scope = "retail", membership = null, showExpiry = true, priceMode = "last-any", pricing = null }) {
  const [sellPricePrompt, setSellPricePrompt] = useState(null);
  const [lineError, setLineError] = useState(null);
  const pendingFocusRef = useRef(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    if (!pendingFocusRef.current) return;
    const key = pendingFocusRef.current;
    pendingFocusRef.current = null;
    focusInvoiceProduct(key);
  }, [items]);

  const lineLookupSig = items.map((it) => `${it.line_key}:${it.product_id || ""}:${it.unit_id || ""}`).join(",");

  useEffect(() => {
    if (priceMode !== "supplier") return;
    if (!pricing?.supplierId) {
      setItems((prev) => {
        let changed = false;
        const next = prev.map((x) => {
          if (!x.suggestedKey && !x.priceHint && !x.priceMissing) return x;
          changed = true;
          return { ...x, suggestedKey: null, priceHint: "", priceMissing: false };
        });
        return changed ? next : prev;
      });
      return;
    }
    setItems((prev) => {
      let changed = false;
      const next = prev.map((x) => {
        if (!x.product_id) return x;
        const key = returnPriceContextKey(pricing, x.product_id, x.unit_id);
        if (x.priceManual && x.manualKey === key) return x;
        if (x.suggestedKey === key || !x.suggestedKey) return x;
        changed = true;
        return {
          ...x,
          unit_cost: "",
          total_cost: "",
          suggestedKey: null,
          priceHint: "",
          priceMissing: false,
        };
      });
      return changed ? next : prev;
    });
    const controllers = [];
    const snapshot = itemsRef.current;
    for (const it of snapshot) {
      if (!it.product_id || !it.unit_id) continue;
      const key = returnPriceContextKey(pricing, it.product_id, it.unit_id);
      if (!key) continue;
      if (it.suggestedKey === key) continue;
      if (it.priceManual && it.manualKey === key) continue;
      const ac = new AbortController();
      controllers.push(ac);
      const lineKey = it.line_key;
      fetchSupplierPurchaseUnitPrice({
        supplierId: pricing.supplierId,
        productId: it.product_id,
        unitId: it.unit_id,
        asOf: pricing.asOf,
        invoiceId: pricing.invoiceId || undefined,
        signal: ac.signal,
      })
        .then((result) => {
          setItems((prev) =>
            prev.map((x) => {
              if (x.line_key !== lineKey) return x;
              const currentKey = returnPriceContextKey(pricing, x.product_id, x.unit_id);
              if (currentKey !== key) return x;
              if (x.priceManual && x.manualKey === key) return x;
              if (result?.found && result.unit_cost != null) {
                const qty = Number(x.quantity) || 0;
                const unitCostStr = formatCostInput(result.unit_cost);
                return {
                  ...x,
                  unit_cost: unitCostStr,
                  total_cost: deriveTotalCost(unitCostStr, qty),
                  cost_mode: "unit",
                  suggestedKey: key,
                  priceHint: supplierPurchasePriceHint(result.source),
                  priceMissing: false,
                  last_purchase_cost: result.unit_cost,
                };
              }
              return {
                ...x,
                suggestedKey: key,
                priceHint: "",
                priceMissing: true,
                last_purchase_cost: null,
              };
            })
          );
        })
        .catch((err) => {
          if (err?.code === "ERR_CANCELED" || err?.name === "CanceledError" || err?.name === "AbortError") return;
        });
    }
    return () => controllers.forEach((c) => c.abort());
  }, [priceMode, pricing?.supplierId, pricing?.asOf, pricing?.invoiceId, lineLookupSig, setItems]);

  async function applyProduct(i, p) {
    const useSupplierPrice = priceMode === "supplier";
    const [units, pricingInfo] = await Promise.all([
      fetchProductUnits(p.id),
      useSupplierPrice ? Promise.resolve(null) : fetchLastPurchaseCost(p.id),
    ]);
    const last = pricingInfo?.last_purchase;
    const lastCost = last?.unit_cost ?? null;
    let unitId = pickDefaultPurchaseUnit(units);
    if (last?.product_unit_id && units.some((u) => u.id === Number(last.product_unit_id))) {
      unitId = Number(last.product_unit_id);
    }
    const unitCostStr = !useSupplierPrice && lastCost != null ? formatCostInput(lastCost) : "";
    setItems((prev) => prev.map((x, idx) => {
      if (idx !== i) return x;
      const nextQty = x.quantity === "" || x.quantity == null ? 1 : Number(x.quantity) || 1;
      const totalCostStr = unitCostStr !== "" ? deriveTotalCost(unitCostStr, nextQty) : "";
      return {
        ...x,
        product_id: p.id,
        name: p.name,
        barcode: p.barcode,
        product_unit: p.unit || null,
        is_weighed: Number(p.is_weighed) === 1 ? 1 : 0,
        quantity: nextQty,
        unit_id: unitId,
        units,
        total_cost: totalCostStr,
        unit_cost: unitCostStr,
        cost_mode: unitCostStr !== "" ? "unit" : "total",
        last_purchase_cost: lastCost,
        sell_price: pricingInfo?.sell_price ?? p.price ?? null,
        min_price: pricingInfo?.min_price ?? p.min_price ?? null,
        max_price: pricingInfo?.max_price ?? p.max_price ?? null,
        sell_price_prompted_for: null,
        priceManual: false,
        manualKey: null,
        suggestedKey: null,
        priceHint: "",
        priceMissing: false,
      };
    }));
    setLineError(null);
  }

  function addEmptyRow() {
    const last = items[items.length - 1];
    if (last && !last.product_id) {
      setLineError({ line_key: last.line_key, message: "اختر الصنف أولاً" });
      focusInvoiceProduct(last.line_key);
      return;
    }
    if (last && last.product_id && !invoiceLineQtyValid(last)) {
      setLineError({ line_key: last.line_key, message: "أدخل كمية أكبر من صفر" });
      focusInvoiceField(last.line_key, "qty");
      return;
    }
    const row = emptyPurchaseLine();
    pendingFocusRef.current = row.line_key;
    setItems((prev) => [...prev, row]);
    setLineError(null);
  }
  function handleUnitCostBlur(i) {
    if (priceMode === "supplier") return;
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
  function markManualPrice(row, extra) {
    const key = returnPriceContextKey(pricing, row.product_id, extra?.unit_id ?? row.unit_id);
    return {
      ...row,
      ...extra,
      priceManual: true,
      manualKey: key || row.manualKey,
      priceMissing: false,
    };
  }
  function update(i, key, val) {
    setItems((prev) => prev.map((x, idx) => {
      if (idx !== i) return x;
      if (key === "unit_id" && priceMode === "supplier") {
        return {
          ...x,
          unit_id: val,
          unit_cost: "",
          total_cost: "",
          priceManual: false,
          manualKey: null,
          suggestedKey: null,
          priceHint: "",
          priceMissing: false,
        };
      }
      return { ...x, [key]: val };
    }));
  }
  function updateTotalCost(i, val) {
    setItems((prev) => prev.map((x, idx) => {
      if (idx !== i) return x;
      const qty = Number(x.quantity) || 0;
      return markManualPrice(x, {
        total_cost: val,
        unit_cost: deriveUnitCost(val, qty),
        cost_mode: "total",
      });
    }));
  }
  function updateUnitCost(i, val) {
    setItems((prev) => prev.map((x, idx) => {
      if (idx !== i) return x;
      const qty = Number(x.quantity) || 0;
      return markManualPrice(x, {
        unit_cost: val,
        total_cost: deriveTotalCost(val, qty),
        cost_mode: "unit",
      });
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
      if (priceMode === "supplier") {
        next.unit_cost = "";
        next.total_cost = "";
        next.priceManual = false;
        next.manualKey = null;
        next.suggestedKey = null;
        next.priceHint = "";
        next.priceMissing = false;
      }
      if (x.cost_mode === "unit" && x.unit_cost !== "" && priceMode !== "supplier") {
        next.total_cost = deriveTotalCost(x.unit_cost, qty);
      } else if (x.total_cost !== "" && priceMode !== "supplier") {
        next.unit_cost = deriveUnitCost(x.total_cost, qty);
      }
      return next;
    }));
  }
  function remove(i) { setItems((prev) => prev.filter((_, idx) => idx !== i)); }

  const simpleTotals = !withVat ? computePurchaseSimpleTotal(items) : null;
  const vatTotals = withVat ? computePurchaseEditorTotals(items, defaultTaxRate) : null;
  const colSpan = showExpiry ? 10 : 9;

  return (
    <div
      className="purchase-item-editor"
      data-enter-nav="invoice-lines"
      onKeyDownCapture={(e) => handleInvoiceTableEnterKeyDown(e, {
        items,
        addEmptyRow,
        onInvalid: (err, row) => setLineError({ line_key: row?.line_key, message: err.message }),
      })}
    >
      <div className="purchase-item-editor__toolbar">
        <Button type="button" variant="outline" icon="plus" onClick={addEmptyRow}>إضافة صنف</Button>
      </div>
      {withVat ? (
        <div className="purchase-item-editor__hint">الأسعار شامل ضريبة القيمة المضافة</div>
      ) : null}
      {lineError?.message ? (
        <div className="purchase-item-editor__error">{lineError.message}</div>
      ) : null}
      <div className="ui-table-wrap">
        <table className="ui-table">
          <colgroup>
            <col style={{ width: "18%" }} />
            <col style={{ width: "9%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "10%" }} />
            {showExpiry ? <col style={{ width: "11%" }} /> : null}
            <col style={{ width: "7%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "11%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>الصنف</th>
              <th title="كلفة الوحدة">سعر</th>
              <th>الوحدة</th>
              <th>الكمية</th>
              {showExpiry ? <th>تاريخ الصلاحية</th> : null}
              <th title="خصم %">خصم</th>
              <th title="بونص مجاني">بونص</th>
              <th title="إجمالي الكلفة قبل الخصم">إجمالي</th>
              <th title="الإجمالي بعد الخصم">الإجمالي</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={colSpan} style={{ textAlign: "center", color: "var(--office-panel-muted)", padding: "1rem" }}>أضف أصنافاً عبر «إضافة صنف»</td></tr>}
            {items.map((it, i) => {
              const qtyNum = Number(it.quantity) || 0;
              const bonusNum = Number(it.bonus_quantity) || 0;
              const totalNum = Number(it.total_cost) || 0;
              const lineVat = withVat
                ? computePurchaseLineVat(it.total_cost, it.discount_pct, "", defaultTaxRate)
                : null;
              const linePayable = !withVat ? computePurchaseLinePayable(it.total_cost, it.discount_pct) : null;
              const payable = lineVat ? lineVat.lineTotal : linePayable ? linePayable.payable : totalNum;
              const effectiveUnitCost = deriveEffectiveUnitCost(payable, qtyNum);
              const showEffective = lineHasPurchaseDiscount(it.discount_pct) && effectiveUnitCost !== "";
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
              <tr key={it.line_key || `${it.product_id}-${i}`} data-invoice-line={it.line_key || `${i}`}>
                <td className="purchase-item-editor__name">
                  <InvoiceLineProductCell
                    value={it.product_id}
                    productName={it.name}
                    onPick={(p) => applyProduct(i, p)}
                    scope={scope}
                    membership={membership}
                    kind={membership ? "workspace" : null}
                    lineKey={it.line_key}
                  />
                </td>
                <td>
                  <input className="ui-input" type="number" min="0" step="0.01" placeholder="0" value={it.unit_cost ?? ""} onFocus={selectInputOnFocus} onChange={(e) => updateUnitCost(i, e.target.value)} onBlur={() => handleUnitCostBlur(i)} />
                  {showEffective ? <div className="purchase-item-editor__meta">الكلفة الفعلية {ils(effectiveUnitCost)}</div> : null}
                  {priceMode === "supplier" && it.priceHint ? (
                    <div className="purchase-item-editor__meta">{it.priceHint}</div>
                  ) : null}
                  {priceMode === "supplier" && it.priceMissing ? (
                    <div className="purchase-item-editor__meta purchase-item-editor__meta--accent">لا يوجد سعر شراء سابق لهذا المورد</div>
                  ) : null}
                </td>
                <td>
                  {selectable.length > 0 ? (
                    <select className="ui-input" data-invoice-field="unit" value={it.unit_id ?? ""} onChange={(e) => update(i, "unit_id", e.target.value ? Number(e.target.value) : null)}>
                      {selectable.map((u) => <option key={u.id} value={u.id}>{u.unit_name}</option>)}
                    </select>
                  ) : <span style={{ color: "var(--office-panel-muted)" }}>—</span>}
                </td>
                <td>
                  <QtyStepper className="ui-input" min={0} step={purchaseQtyStepForUnit(selectedUnit)} value={it.quantity} data-invoice-field="qty" onFocus={selectInputOnFocus} onChange={(e) => updateQuantity(i, e.target.value)} />
                  {conv > 1 && qtyNum > 0 ? <div className="purchase-item-editor__meta">= {fmtQty(baseQty)} {itemBaseUnitName(it)}</div> : null}
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
                {showExpiry ? (
                  <td>
                    <Input
                      type="date"
                      data-invoice-field="expiry"
                      value={it.expiry_date || ""}
                      onChange={(e) => update(i, "expiry_date", e.target.value)}
                    />
                    <div className="purchase-item-editor__meta">اختياري — فارغ = غير محدد</div>
                  </td>
                ) : null}
                <td><input className="ui-input" type="number" min="0" max="100" step="0.1" placeholder="0" value={it.discount_pct ?? ""} onFocus={selectInputOnFocus} onChange={(e) => update(i, "discount_pct", e.target.value)} /></td>
                <td>
                  <QtyStepper className="ui-input" min={0} step={purchaseQtyStepForUnit(selectedUnit)} value={it.bonus_quantity ?? ""} onFocus={selectInputOnFocus} onChange={(e) => update(i, "bonus_quantity", e.target.value)} />
                  {bonusNum > 0 ? (
                    <div className="purchase-item-editor__meta purchase-item-editor__meta--accent">
                      + {fmtQty(bonusNum)} بونص{stockBaseQty > baseQty ? ` = ${fmtQty(stockBaseQty)} ${itemBaseUnitName(it)}` : ""}
                    </div>
                  ) : null}
                </td>
                <td><input className="ui-input" type="number" min="0" step="0.01" placeholder="0" value={it.total_cost} onFocus={selectInputOnFocus} onChange={(e) => updateTotalCost(i, e.target.value)} /></td>
                <td className="num purchase-item-editor__total-final">{ils(lineVat ? lineVat.lineTotal : linePayable ? linePayable.payable : totalNum)}</td>
                <td className="purchase-item-editor__actions"><Button variant="ghost" size="sm" icon="trash" aria-label="حذف" onClick={() => remove(i)} /></td>
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

export default function Purchases({
  workspace = null,
  forcedTab = null,
  hideOrders = false,
  title,
  subtitle,
}) {
  const isBakery = workspace === "bakery";
  const guardSubmit = useSubmitGuard();
  const toast = useToast();
  const [tab, setTab] = useState(forcedTab || "invoices");
  const [listFrom, setListFrom] = useState("");
  const [listTo, setListTo] = useState("");
  const [suppliers, setSuppliers] = useState([]);
  const [store, setStore] = useState({});
  const [orders, setOrders] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [returns, setReturns] = useState([]);
  const [loading, setLoading] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [supplierId, setSupplierId] = useState("");
  const [docDate, setDocDate] = useState(todayISO());
  const [refText, setRefText] = useState("");
  const [notes, setNotes] = useState("");
  const [sourceInvoiceId, setSourceInvoiceId] = useState("");
  const [supplierInvoices, setSupplierInvoices] = useState([]);
  const [items, setItems] = useState([]);
  const [saving, setSaving] = useState(false);
  const [editId, setEditId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [postingAll, setPostingAll] = useState(false);
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
      const params = isBakery ? { membership: "bakery" } : undefined;
      const { data } = await api.get(path, { headers: getAuthHeaders(), params });
      if (which === "orders") setOrders(data);
      else if (which === "returns") setReturns(data);
      else setInvoices(data);
    } catch { toast.error("تعذّر التحميل"); }
    finally { setLoading(false); }
  }, [toast, isBakery]);

  useEffect(() => { loadSuppliers(); loadSettings(); }, [loadSuppliers, loadSettings]);
  useEffect(() => { loadList(tab); }, [tab, loadList]);
  useEffect(() => {
    if (forcedTab && forcedTab !== tab) setTab(forcedTab);
  }, [forcedTab, tab]);

  useEffect(() => {
    if (tab !== "returns" || !supplierId) {
      setSupplierInvoices([]);
      return;
    }
    let cancelled = false;
    api.get("/api/purchases/invoices", {
      params: { supplier_id: supplierId, status: "posted", limit: "all" },
      headers: getAuthHeaders(),
    })
      .then(({ data }) => {
        if (!cancelled) setSupplierInvoices(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setSupplierInvoices([]);
      });
    return () => { cancelled = true; };
  }, [tab, supplierId]);

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
    setSupplierId(""); setDocDate(todayISO());
    setRefText(""); setNotes(""); setSourceInvoiceId(""); setItems([]); setShowForm(true);
  }

  async function fillFormFromDoc(which, data, id) {
    setSupplierId(String(data.supplier_id));
    const docDateValue = which === "returns" ? data.return_date : which === "orders" ? data.order_date : data.invoice_date;
    setDocDate(docDateValue?.slice(0, 10) || todayISO());
    setRefText(data.ref_text || "");
    setNotes(data.notes || "");
    setSourceInvoiceId(data.invoice_id ? String(data.invoice_id) : "");
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
          line_key: newInvoiceLineKey(),
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
          expiry_date: it.expiry_date || "",
          last_purchase_cost: pricing?.last_purchase?.unit_cost ?? null,
          sell_price: pricing?.sell_price ?? null,
          min_price: pricing?.min_price ?? null,
          max_price: pricing?.max_price ?? null,
          sell_price_prompted_for: null,
          priceManual: true,
          manualKey: returnPriceContextKey(
            { supplierId: data.supplier_id, asOf: docDateValue?.slice(0, 10), invoiceId: data.invoice_id },
            it.product_id,
            it.product_unit_id
          ),
          suggestedKey: returnPriceContextKey(
            { supplierId: data.supplier_id, asOf: docDateValue?.slice(0, 10), invoiceId: data.invoice_id },
            it.product_id,
            it.product_unit_id
          ),
          priceHint: "",
          priceMissing: false,
        };
      })
    );
    setItems(mapped);
    setEditId(id);
    setShowForm(true);
  }

  async function persist() {
    if (!supplierId) { toast.error("اختر المورد"); return null; }
    const lines = completeInvoiceLines(items);
    if (lines.length === 0) { toast.error("أضف أصنافاً"); return null; }
    const bad = lines.find((it) => !invoiceLineQtyValid(it));
    if (bad) {
      toast.error("أدخل كمية أكبر من صفر لكل صنف");
      return null;
    }
    setSaving(true);
    const payload = {
      supplier_id: Number(supplierId),
      notes,
      items: lines.map((it) => ({
        product_id: it.product_id,
        quantity: Number(it.quantity),
        unit_id: it.unit_id != null ? Number(it.unit_id) : undefined,
        total_cost: Number(it.total_cost),
        discount_pct: it.discount_pct === "" ? undefined : Number(it.discount_pct),
        bonus_quantity: it.bonus_quantity === "" ? undefined : Number(it.bonus_quantity),
        expiry_date: it.expiry_date || undefined,
      })),
    };
    try {
      if (tab === "returns") {
        payload.return_date = docDate;
        payload.invoice_id = sourceInvoiceId ? Number(sourceInvoiceId) : null;
      }
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
      toast.error(apiErrorMessage(e, "فشل الحفظ"));
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
    await guardSubmit(async () => {
    const id = await persist();
    if (id == null) return;
    try {
      const path = tab === "returns" ? `/api/purchases/returns/${id}/post` : `/api/purchases/invoices/${id}/post`;
      await api.post(path, {}, { headers: getAuthHeaders() });
      toast.success("تم الترحيل");
      setShowForm(false);
      setEditId(null);
      loadList(tab);
    } catch (e) { toast.error(apiErrorMessage(e, "فشل الترحيل")); }
    });
  }

  async function saveAndPrint() {
    const id = await persist();
    if (id == null) return;
    printDoc(tab, id);
  }

  async function postDoc(which, id) {
    if (!window.confirm("ترحيل هذا المستند سيحدّث المخزون وأرصدة المورد. متابعة؟")) return;
    await guardSubmit(async () => {
    try {
      const path = which === "returns" ? `/api/purchases/returns/${id}/post` : `/api/purchases/invoices/${id}/post`;
      await api.post(path, {}, { headers: getAuthHeaders() });
      toast.success("تم الترحيل");
      loadList(tab);
    } catch (e) { toast.error(apiErrorMessage(e, "فشل الترحيل")); }
    });
  }

  async function postAllDocs() {
    if (tab === "orders") return;
    const rows = tab === "returns" ? returns : invoices;
    const hasDrafts = rows.some((r) => r.status === "draft");
    if (!hasDrafts) {
      toast.error("لا توجد مسودات للترحيل");
      return;
    }
    if (!window.confirm("ترحيل كل المسودات؟ سيحدّث المخزون وأرصدة المورد. لا يمكن التراجع.")) return;
    await guardSubmit(async () => {
      setPostingAll(true);
      try {
        if (isBakery) {
          const drafts = rows.filter((r) => r.status === "draft");
          let n = 0;
          const errors = [];
          for (const doc of drafts) {
            const path = tab === "returns" ? `/api/purchases/returns/${doc.id}/post` : `/api/purchases/invoices/${doc.id}/post`;
            try {
              await api.post(path, {}, { headers: getAuthHeaders() });
              n += 1;
            } catch (e) {
              errors.push({ id: doc.id, error: apiErrorMessage(e, "فشل الترحيل") });
            }
          }
          const failed = errors.length;
          if (n === 0 && failed === 0) toast.error("لا توجد مسودات للترحيل");
          else if (n === 0) toast.error(errors[0]?.error || "فشل الترحيل");
          else if (failed) toast.error(`تم ترحيل ${n} مستند — فشل ${failed}`);
          else toast.success(`تم ترحيل ${n} مستند`);
          loadList(tab);
          return;
        }
        const path = tab === "returns" ? "/api/purchases/returns/post-all" : "/api/purchases/invoices/post-all";
        const { data } = await api.post(path, {}, { headers: getAuthHeaders() });
        const n = Number(data?.posted_count) || 0;
        const failed = Array.isArray(data?.errors) ? data.errors.length : 0;
        if (n === 0 && failed === 0) {
          toast.error("لا توجد مسودات للترحيل");
        } else if (n === 0) {
          toast.error(data.errors[0]?.error || "فشل الترحيل");
        } else if (failed) {
          toast.error(`تم ترحيل ${n} مستند — فشل ${failed}`);
        } else {
          toast.success(`تم ترحيل ${n} مستند`);
        }
        loadList(tab);
      } catch (e) {
        toast.error(apiErrorMessage(e, "فشل الترحيل"));
      } finally {
        setPostingAll(false);
      }
    });
  }

  async function removeDoc(which, id) {
    if (!window.confirm("حذف هذه المسودة؟")) return;
    try {
      const path = which === "orders" ? `/api/purchases/orders/${id}` : which === "returns" ? `/api/purchases/returns/${id}` : `/api/purchases/invoices/${id}`;
      await api.delete(path, { headers: getAuthHeaders() });
      toast.success("تم الحذف");
      loadList(tab);
    } catch (e) { toast.error(apiErrorMessage(e, "فشل الحذف")); }
  }

  async function openDetail(which, id) {
    try {
      const path = which === "orders" ? `/api/purchases/orders/${id}` : which === "returns" ? `/api/purchases/returns/${id}` : `/api/purchases/invoices/${id}`;
      const { data } = await api.get(path, {
        headers: getAuthHeaders(),
        params: isBakery && which !== "orders" ? { membership: "bakery" } : undefined,
      });
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
    { key: "supplier_name", header: "المورد", nameColumn: true, wrap: true },
    { key: "invoice_date", header: "التاريخ", value: (r) => dateOnly(r.invoice_date), render: (r) => dateOnly(r.invoice_date) },
    ...(isBakery
      ? [
          {
            key: "bakery_total",
            header: "إجمالي أصناف المخبز",
            align: "left",
            className: "num",
            value: (r) => ils(r.bakery_total),
            render: (r) => ils(r.bakery_total),
          },
          {
            key: "total",
            header: "إجمالي الفاتورة",
            align: "left",
            className: "num",
            value: (r) => ils(r.invoice_total ?? r.total),
            render: (r) => (
              <span>
                {ils(r.invoice_total ?? r.total)}
                {r.mixed ? <span className="ui-field__hint"> مختلطة</span> : null}
              </span>
            ),
          },
        ]
      : [
          { key: "total", header: "الإجمالي", align: "left", className: "num", value: (r) => ils(r.total), render: (r) => ils(r.total) },
        ]),
    { key: "status", header: "الحالة", value: (r) => STATUS_LABEL[r.status], render: (r) => <StatusPill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</StatusPill> },
    {
      key: "actions", header: "إجراءات",
      render: (r) => (
        <div className="ui-table__actions">
          <Button variant="ghost" size="sm" onClick={() => openDetail("invoices", r.id)}>عرض</Button>
          <Button variant="ghost" size="sm" icon="print" onClick={() => printDoc("invoices", r.id)}>طباعة</Button>
          {r.status === "draft" && <Button variant="outline" size="sm" icon="check" onClick={() => postDoc("invoices", r.id)}>ترحيل</Button>}
          {r.status === "draft" && <Button variant="ghost" size="sm" icon="trash" iconOnly aria-label="حذف" onClick={() => removeDoc("invoices", r.id)} />}
        </div>
      ),
    },
  ];

  const returnCols = [
    { key: "return_no", header: "رقم", value: (r) => `#${r.return_no ?? r.id}`, render: (r) => `#${r.return_no ?? r.id}` },
    { key: "supplier_name", header: "المورد", nameColumn: true, wrap: true },
    { key: "return_date", header: "التاريخ", value: (r) => dateOnly(r.return_date), render: (r) => dateOnly(r.return_date) },
    ...(isBakery
      ? [
          {
            key: "bakery_total",
            header: "إجمالي أصناف المخبز",
            align: "left",
            className: "num",
            value: (r) => ils(r.bakery_total),
            render: (r) => ils(r.bakery_total),
          },
          {
            key: "total",
            header: "إجمالي المرتجع",
            align: "left",
            className: "num",
            value: (r) => ils(r.invoice_total ?? r.total),
            render: (r) => (
              <span>
                {ils(r.invoice_total ?? r.total)}
                {r.mixed ? <span className="ui-field__hint"> مختلط</span> : null}
              </span>
            ),
          },
        ]
      : [
          { key: "total", header: "الإجمالي", align: "left", className: "num", value: (r) => ils(r.total), render: (r) => ils(r.total) },
        ]),
    { key: "status", header: "الحالة", value: (r) => STATUS_LABEL[r.status], render: (r) => <StatusPill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</StatusPill> },
    {
      key: "actions", header: "إجراءات",
      render: (r) => (
        <div className="ui-table__actions">
          <Button variant="ghost" size="sm" onClick={() => openDetail("returns", r.id)}>عرض</Button>
          <Button variant="ghost" size="sm" icon="print" onClick={() => printDoc("returns", r.id)}>طباعة</Button>
          {r.status === "draft" && <Button variant="outline" size="sm" icon="check" onClick={() => postDoc("returns", r.id)}>ترحيل</Button>}
          {r.status === "draft" && <Button variant="ghost" size="sm" icon="trash" iconOnly aria-label="حذف" onClick={() => removeDoc("returns", r.id)} />}
        </div>
      ),
    },
  ];

  const orderCols = [
    { key: "order_no", header: "رقم", value: (r) => `#${r.order_no ?? r.id}`, render: (r) => `#${r.order_no ?? r.id}` },
    { key: "supplier_name", header: "المورد", nameColumn: true, wrap: true },
    { key: "order_date", header: "التاريخ", value: (r) => dateOnly(r.order_date), render: (r) => dateOnly(r.order_date) },
    { key: "total_amount", header: "الإجمالي", align: "left", className: "num", value: (r) => ils(r.total_amount), render: (r) => ils(r.total_amount) },
    { key: "status", header: "الحالة", value: (r) => STATUS_LABEL[r.status], render: (r) => <StatusPill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</StatusPill> },
    {
      key: "actions", header: "إجراءات",
      render: (r) => (
        <div className="ui-table__actions">
          <Button variant="ghost" size="sm" onClick={() => openDetail("orders", r.id)}>عرض</Button>
          <Button variant="ghost" size="sm" icon="print" onClick={() => printDoc("orders", r.id)}>طباعة</Button>
          {r.status !== "received" && <Button variant="ghost" size="sm" icon="trash" iconOnly aria-label="حذف" onClick={() => removeDoc("orders", r.id)} />}
        </div>
      ),
    },
  ];

  const dateKey = tab === "orders" ? "order_date" : tab === "returns" ? "return_date" : "invoice_date";
  const allRows = tab === "orders" ? orders : tab === "returns" ? returns : invoices;
  const rows = allRows.filter((r) => {
    const d = String(r[dateKey] || "").slice(0, 10);
    if (listFrom && d && d < listFrom) return false;
    if (listTo && d && d > listTo) return false;
    return true;
  });
  const cols = tab === "orders" ? orderCols : tab === "returns" ? returnCols : invoiceCols;
  const newLabel = tab === "orders" ? "أمر شراء جديد" : tab === "returns" ? "مرتجع جديد" : "فاتورة شراء جديدة";
  const reportTitle = tab === "orders" ? "أوامر الشراء" : tab === "returns" ? "مرتجعات الشراء" : "فواتير الشراء";
  const pageTitle = title || (isBakery ? (tab === "returns" ? "مرتجعات موردي المخبز" : "مشتريات المخبز") : "فاتورة مشتريات");
  const pageSubtitle = subtitle || (isBakery
    ? "الفواتير التي تحتوي أصناف مخبز — الإجمالي الكامل للحساب، وأصناف المخبز للملخص"
    : "فواتير وأوامر ومرتجعات الشراء");
  const purchaseTabs = [
    { id: "invoices", label: "فواتير الشراء", icon: "vouchers" },
    ...(!hideOrders && !isBakery ? [{ id: "orders", label: "أوامر الشراء", icon: "purchases" }] : []),
    ...(!forcedTab ? [{ id: "returns", label: "مرتجعات الشراء", icon: "refunds" }] : []),
  ];

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader icon="purchases" title={pageTitle} subtitle={pageSubtitle}
        actions={
          <>
            <ReportToolbar
              title={reportTitle}
              columns={pickExportColumns(cols)}
              rows={rows}
              filename={`purchases-${tab}`}
              disabled={loading}
            />
            {tab !== "orders" && (
              <Button variant="outline" onClick={postAllDocs} disabled={postingAll}>
                {postingAll ? "جاري الترحيل…" : "ترحيل الكل"}
              </Button>
            )}
            <Button icon="plus" onClick={openForm}>{newLabel}</Button>
          </>
        } />

      {purchaseTabs.length > 1 ? (
        <Tabs active={tab} onChange={setTab} tabs={purchaseTabs} />
      ) : null}

      <FilterBar
        onReset={() => { setListFrom(""); setListTo(""); }}
      >
        <FormField label="من تاريخ" className="ui-field--date">
          <Input type="date" value={listFrom} onChange={(e) => setListFrom(e.target.value)} />
        </FormField>
        <FormField label="إلى تاريخ" className="ui-field--date">
          <Input type="date" value={listTo} onChange={(e) => setListTo(e.target.value)} />
        </FormField>
      </FilterBar>

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
            <Select value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setSourceInvoiceId(""); }}>
              <option value="">— اختر —</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </FormField>
          <FormField label="التاريخ"><Input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} /></FormField>
          {tab === "invoices" && <FormField label="مرجع الفاتورة"><Input value={refText} onChange={(e) => setRefText(e.target.value)} /></FormField>}
          {tab === "returns" && (
            <FormField label="فاتورة الشراء الأصلية">
              <Select value={sourceInvoiceId} onChange={(e) => setSourceInvoiceId(e.target.value)} disabled={!supplierId}>
                <option value="">— بدون فاتورة أصل —</option>
                {supplierInvoices.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    #{inv.invoice_no ?? inv.id} — {dateOnly(inv.invoice_date)} — {ils(inv.total)}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
        </FormGrid>
        <div style={{ margin: "1rem 0 0.5rem", fontWeight: 700 }}>الأصناف</div>
        <ItemEditor
          items={items}
          setItems={setItems}
          withVat={tab === "invoices"}
          defaultTaxRate={store.default_tax_rate}
          showExpiry={tab !== "orders"}
          scope={isBakery ? null : "retail"}
          membership={isBakery ? "bakery" : null}
          priceMode={tab === "returns" ? "supplier" : "last-any"}
          pricing={tab === "returns" ? { supplierId, asOf: docDate, invoiceId: sourceInvoiceId } : null}
        />
        {isBakery ? (
          <p className="ui-field__hint">البحث لا يحذف أصنافاً أخرى — يمكن خلط أصناف المخبز والمتجر في فاتورة واحدة.</p>
        ) : null}
        <FormField label="ملاحظات" className="ui-field--full"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></FormField>
      </Modal>

      <Modal
        open={!!detail}
        title={detail ? `تفاصيل المستند #${detail.doc.invoice_no ?? detail.doc.return_no ?? detail.doc.order_no ?? detail.doc.id}` : ""}
        onClose={() => setDetail(null)}
        size="full"
        className="purchase-doc-detail-modal"
        footer={detail ? <Button icon="print" onClick={() => printPurchaseDoc(detail.doc, detail.which, store)}>طباعة</Button> : null}
      >
        {detail && (
          <div className="purchase-doc-detail">
            <div className="detail-header">
              <div>المورد: <strong>{detail.doc.supplier_name}</strong></div>
              <div>الحالة: <StatusPill tone={STATUS_TONE[detail.doc.status]}>{STATUS_LABEL[detail.doc.status]}</StatusPill></div>
            </div>
            {isBakery && (detail.doc.bakery_total != null) ? (
              <p className="dashboard-meta-line">
                إجمالي أصناف المخبز: <strong>{ils(detail.doc.bakery_total)}</strong>
                {" · "}
                إجمالي المستند: <strong>{ils(detail.doc.invoice_total ?? detail.doc.total)}</strong>
                {detail.doc.mixed ? " — فاتورة مختلطة" : null}
                {" "}
                <Link
                  className="dashboard-inline-link"
                  to={detail.which === "returns" ? `/purchases?returnId=${detail.doc.id}` : `/purchases?invoiceId=${detail.doc.id}`}
                >
                  فتح المستند الكامل
                </Link>
              </p>
            ) : null}
            <PurchaseDocDetailItems items={detail.doc.items} />
          </div>
        )}
      </Modal>
    </div>
  );
}

export { pickDefaultPurchaseUnit, ItemEditor };
