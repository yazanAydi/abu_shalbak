import {
  focusNextField,
  focusPrevField,
  getFocusableFields,
  handleEnterNavKeyDown,
  shouldHandleEnterOnField,
} from "./focusNavigation";

export function newInvoiceLineKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `line-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function invoiceLineHasProduct(it) {
  return Boolean(it && it.product_id);
}

export function invoiceLineQtyValid(it) {
  const qty = Number(it?.quantity);
  return Number.isFinite(qty) && qty > 0;
}

export function validateInvoiceLine(it) {
  if (!invoiceLineHasProduct(it)) {
    return { field: "product", message: "اختر الصنف أولاً" };
  }
  if (!invoiceLineQtyValid(it)) {
    return { field: "qty", message: "أدخل كمية أكبر من صفر" };
  }
  return null;
}

export function completeInvoiceLines(items) {
  return (items || []).filter(invoiceLineHasProduct);
}

function escapeAttr(value) {
  const s = String(value);
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function focusInvoiceProduct(lineKey) {
  if (!lineKey) return;
  const run = () => {
    const el = document.querySelector(`[data-invoice-product="${escapeAttr(String(lineKey))}"]`);
    if (el) {
      el.focus();
      return true;
    }
    return false;
  };
  if (run()) return;
  requestAnimationFrame(() => {
    if (run()) return;
    requestAnimationFrame(run);
  });
}

export function focusInvoiceField(lineKey, field) {
  const run = () => {
    const el = document.querySelector(
      `[data-invoice-line="${escapeAttr(String(lineKey))}"] [data-invoice-field="${field}"]`
    );
    if (el) {
      el.focus();
      if (typeof el.select === "function") el.select();
      return true;
    }
    return false;
  };
  if (run()) return;
  requestAnimationFrame(() => {
    if (run()) return;
    requestAnimationFrame(run);
  });
}

/**
 * Invoice-table Enter: next cell, next row product, or add a row.
 * Returns true when handled.
 */
export function handleInvoiceTableEnterKeyDown(e, { items, addEmptyRow, onInvalid }) {
  if (e.key !== "Enter" || e.defaultPrevented) return false;
  if (e.isComposing || e.keyCode === 229) return false;

  const rowEl = e.target.closest?.("[data-invoice-line]");
  if (!rowEl) return handleEnterNavKeyDown(e);

  if (!shouldHandleEnterOnField(e.target, e)) return false;

  const tableRoot = e.target.closest("[data-enter-nav='invoice-lines']") || rowEl.closest("tbody")?.parentElement;
  const lineKey = rowEl.getAttribute("data-invoice-line");
  const rowFields = getFocusableFields(rowEl);
  const idx = rowFields.indexOf(e.target);
  const backward = Boolean(e.shiftKey);

  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return true;

  if (backward) {
    if (idx > 0) {
      rowFields[idx - 1].focus();
      return true;
    }
    const prevRow = rowEl.previousElementSibling;
    if (prevRow?.hasAttribute("data-invoice-line")) {
      const prevFields = getFocusableFields(prevRow);
      if (prevFields.length) prevFields[prevFields.length - 1].focus();
    }
    return true;
  }

  if (idx >= 0 && idx < rowFields.length - 1) {
    rowFields[idx + 1].focus();
    return true;
  }

  const nextRow = rowEl.nextElementSibling;
  if (nextRow?.hasAttribute("data-invoice-line")) {
    const nextProduct = nextRow.querySelector("[data-invoice-field='product']");
    if (nextProduct) nextProduct.focus();
    else getFocusableFields(nextRow)[0]?.focus();
    return true;
  }

  const current = (items || []).find((it) => String(it.line_key) === String(lineKey));
  const invalid = validateInvoiceLine(current);
  if (invalid) {
    onInvalid?.(invalid, current);
    focusInvoiceField(lineKey, invalid.field);
    return true;
  }

  addEmptyRow?.();
  return true;
}

export { focusNextField, focusPrevField };
