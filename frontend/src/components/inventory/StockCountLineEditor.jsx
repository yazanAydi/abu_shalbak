import { useEffect, useRef, useState } from "react";
import api from "../../apiClient";
import InvoiceLineProductCell from "../invoice/InvoiceLineProductCell";
import QtyStepper from "../QtyStepper";
import { Button, Input } from "../ui";
import { getAuthHeaders } from "../../utils/auth";
import { dateOnly, dmyToYmd } from "../../utils/format";
import { toLatinDigits } from "../../utils/forceLatinDigits";
import {
  focusInvoiceField,
  focusInvoiceProduct,
  handleInvoiceTableEnterKeyDown,
} from "../../utils/invoiceLineEntry";
import { UNDATED_BATCH_LABEL } from "../../utils/stockBatchLabels";
import {
  attachCountExpiryPicture,
  countDocumentDepartment,
  emptyCountLine,
  seedCountExpiry,
  validateCountLine,
} from "../../utils/stockCountEntry";
import "../../pages/purchase-item-editor.css";

function selectInputOnFocus(e) {
  e.target.select();
}

function isNativeDatePickerTarget(el) {
  if (!el) return false;
  if (el.classList?.contains("ui-date__picker")) return true;
  return el.tagName === "INPUT" && String(el.type || "").toLowerCase() === "date";
}

function invalidTypedExpiry(el) {
  if (!el || el.tagName !== "INPUT") return false;
  if (!el.closest?.(".ui-date")) return false;
  if (isNativeDatePickerTarget(el)) return false;
  const text = toLatinDigits(String(el.value || "").trim());
  if (!text) return false;
  return !dmyToYmd(text);
}

function CountExpiryCell({ row, readOnly, onChange }) {
  const known = Array.isArray(row.known_expiries) ? row.known_expiries : [];
  const showChoices = !readOnly && (known.length > 1 || (known.length === 1 && !row.expiry_date));
  return (
    <div className="stock-count-expiry">
      {showChoices ? (
        <select
          className="ui-input"
          aria-label="تواريخ الصلاحية المسجلة"
          data-testid="count-expiry-choices"
          value={known.includes(row.expiry_date) ? row.expiry_date : ""}
          onChange={(e) => onChange({
            expiry_date: e.target.value,
            expiry_touched: true,
            expiry_invalid: false,
          })}
        >
          <option value="">اختر تاريخاً مسجلاً</option>
          {known.map((date) => (
            <option key={date} value={date}>{dateOnly(date)}</option>
          ))}
        </select>
      ) : null}
      <Input
        type="date"
        data-invoice-field="expiry"
        data-testid="count-expiry"
        aria-label="تاريخ الصلاحية"
        keepInvalid
        readOnly={readOnly}
        value={row.expiry_date || ""}
        onChange={(e) => onChange({ expiry_date: e.target.value, expiry_touched: true, expiry_invalid: false })}
        onInvalid={() => onChange({ expiry_invalid: true })}
      />
      <div className="purchase-item-editor__meta">فارغ = {UNDATED_BATCH_LABEL}</div>
      {row.product_expiry ? (
        <div className="purchase-item-editor__meta" data-testid="count-product-expiry">
          تاريخ الصنف المسجل: {dateOnly(row.product_expiry)}
        </div>
      ) : null}
      {row.expiry_picture_loaded && !row.product_expiry && known.length === 0 ? (
        <div className="purchase-item-editor__meta" data-testid="count-no-expiry">لا يوجد تاريخ مسجل</div>
      ) : null}
    </div>
  );
}

export default function StockCountLineEditor({
  items,
  setItems,
  readOnly = false,
  scope = "retail",
  membership = null,
}) {
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

  function addEmptyRow() {
    const last = itemsRef.current[itemsRef.current.length - 1];
    if (last && !last.product_id) {
      setLineError({ line_key: last.line_key, message: "اختر الصنف أولاً" });
      focusInvoiceProduct(last.line_key);
      return;
    }
    if (last?.product_id) {
      const issue = validateCountLine(last);
      if (issue) {
        setLineError({ line_key: last.line_key, message: issue.message });
        focusInvoiceField(last.line_key, issue.field);
        return;
      }
    }
    const row = emptyCountLine();
    pendingFocusRef.current = row.line_key;
    setItems((prev) => [...prev, row]);
    setLineError(null);
  }

  function updateRow(index, patch) {
    setItems((prev) => prev.map((row, idx) => (idx === index ? { ...row, ...patch } : row)));
  }

  function applyProduct(index, product) {
    const lineKey = itemsRef.current[index]?.line_key;
    if (!lineKey || !product) return false;
    const expected = countDocumentDepartment(scope, membership);
    if (String(product.inventory_scope || "retail") !== expected) {
      setLineError({
        line_key: lineKey,
        message: expected === "bakery"
          ? "هذا الصنف لا يتبع مخزون المخبز"
          : "هذا الصنف لا يتبع مخزون السوبرماركت",
      });
      return false;
    }
    const previous = itemsRef.current[index];
    const switching = previous?.product_id && Number(previous.product_id) !== Number(product.id);
    const requestId = Number(previous?.picture_request || 0) + 1;
    setItems((prev) => prev.map((row) => {
      if (row.line_key !== lineKey) return row;
      return {
        ...row,
        product_id: product.id,
        name: product.name || "",
        barcode: product.barcode || "",
        picture_request: requestId,
        expiry_picture_loaded: false,
        ...(switching ? {
          expiry_date: "",
          expiry_touched: false,
          expiry_invalid: false,
          known_expiries: [],
          product_expiry: "",
        } : {}),
      };
    }));
    setLineError(null);
    api.get("/api/inventory/stock-sources", {
      headers: getAuthHeaders(),
      params: { product_id: product.id },
    }).then(({ data }) => {
      setItems((prev) => {
        const current = prev.find((row) => row.line_key === lineKey);
        if (!current || Number(current.picture_request) !== requestId) return prev;
        if (Number(current.product_id) !== Number(product.id)) return prev;
        return prev.map((row) => (
          row.line_key === lineKey ? seedCountExpiry(row, data, prev) : row
        ));
      });
    }).catch(() => {
      setItems((prev) => prev.map((row) => (
        row.line_key === lineKey && Number(row.picture_request) === requestId
          ? { ...row, expiry_picture_loaded: true }
          : row
      )));
    });
    return true;
  }

  useEffect(() => {
    const pending = items.filter((row) => (
      row.product_id && row.expiry_picture_loaded === false && !row.picture_request
    ));
    if (!pending.length) return undefined;
    let cancelled = false;
    const ids = [...new Set(pending.map((row) => row.product_id))];
    (async () => {
      const byId = {};
      await Promise.all(ids.map(async (id) => {
        try {
          const { data } = await api.get("/api/inventory/stock-sources", {
            headers: getAuthHeaders(),
            params: { product_id: id },
          });
          byId[id] = data;
        } catch {
          byId[id] = null;
        }
      }));
      if (cancelled) return;
      setItems((prev) => prev.map((row) => {
        if (!row.product_id || row.expiry_picture_loaded || row.picture_request) return row;
        if (!(row.product_id in byId)) return row;
        const picture = byId[row.product_id];
        if (!picture) return { ...row, expiry_picture_loaded: true };
        return attachCountExpiryPicture(row, picture);
      }));
    })();
    return () => {
      cancelled = true;
    };
  }, [items, setItems]);

  function remove(index) {
    setItems((prev) => prev.filter((_, idx) => idx !== index));
  }

  return (
    <div
      className="purchase-item-editor"
      data-enter-nav="invoice-lines"
      data-testid="stock-count-editor"
      onKeyDownCapture={(e) => {
        if (readOnly || e.key !== "Enter") return;
        if (isNativeDatePickerTarget(e.target)) return;
        if (invalidTypedExpiry(e.target)) {
          e.preventDefault();
          e.stopPropagation();
          const lineKey = e.target.closest?.("[data-invoice-line]")?.getAttribute("data-invoice-line");
          const index = itemsRef.current.findIndex((row) => String(row.line_key) === String(lineKey));
          if (index >= 0) updateRow(index, { expiry_invalid: true });
          setLineError({ line_key: lineKey, message: "تاريخ الصلاحية غير صالح" });
          return;
        }
        handleInvoiceTableEnterKeyDown(e, {
          items: itemsRef.current,
          addEmptyRow,
          validateLine: validateCountLine,
          onInvalid: (err, row) => setLineError({ line_key: row?.line_key, message: err.message }),
        });
      }}
    >
      {readOnly ? null : (
        <div className="purchase-item-editor__toolbar">
          <Button type="button" variant="outline" icon="plus" onClick={addEmptyRow}>إضافة صنف</Button>
        </div>
      )}
      <p className="purchase-item-editor__hint">
        الكمية هي الموجودة فعلياً. فارغ في تاريخ الصلاحية يعني {UNDATED_BATCH_LABEL}، والصفر كمية معدودة.
      </p>
      {lineError?.message ? (
        <div className="purchase-item-editor__error">{lineError.message}</div>
      ) : null}
      <div className="ui-table-wrap">
        <table className="ui-table" data-testid="stock-count-lines">
          <colgroup>
            <col style={{ width: "46%" }} />
            <col style={{ width: "22%" }} />
            <col style={{ width: "24%" }} />
            <col style={{ width: "8%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>الصنف</th>
              <th>الكمية المعدودة</th>
              <th>تاريخ الصلاحية</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ textAlign: "center", color: "var(--office-panel-muted)", padding: "1rem" }}>
                  أضف أصنافاً عبر «إضافة صنف»
                </td>
              </tr>
            ) : items.map((it, i) => (
              <tr key={it.line_key} data-invoice-line={it.line_key}>
                <td className="purchase-item-editor__name">
                  {readOnly ? (
                    <span>{it.name || "—"}</span>
                  ) : (
                    <InvoiceLineProductCell
                      value={it.product_id}
                      productName={it.name}
                      onPick={(product) => applyProduct(i, product)}
                      scope={membership ? null : scope}
                      membership={membership}
                      kind={membership ? "workspace" : null}
                      lineKey={it.line_key}
                    />
                  )}
                </td>
                <td>
                  <QtyStepper
                    className="ui-input"
                    min={0}
                    step="any"
                    placeholder="لم يُجرَد"
                    value={it.counted_qty}
                    data-invoice-field="qty"
                    data-testid="count-qty"
                    aria-label="الكمية المعدودة"
                    readOnly={readOnly}
                    onFocus={selectInputOnFocus}
                    onChange={(e) => updateRow(i, { counted_qty: e.target.value })}
                  />
                </td>
                <td>
                  <CountExpiryCell
                    row={it}
                    readOnly={readOnly}
                    onChange={(patch) => updateRow(i, patch)}
                  />
                </td>
                <td className="purchase-item-editor__actions">
                  {readOnly ? null : (
                    <Button variant="ghost" size="sm" icon="trash" aria-label="حذف" onClick={() => remove(i)} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
