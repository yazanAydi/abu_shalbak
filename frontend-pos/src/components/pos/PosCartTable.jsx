import { useEffect, useRef } from "react";
import { focusBarcodeInput } from "../../utils/focusBarcodeInput";
import { cartItemPromoKey, computeDealLineTotal } from "../../utils/posTotals";
import { isKgSoldUnit } from "../../utils/cartProduct";
import Icon from "../icons/Icon";
import { handleEnterNavKeyDown } from "../../utils/focusNavigation";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

function selectedSoldUnit(it) {
  const units = it.availableUnits || [];
  return units.find((u) => Number(u.id) === Number(it.unitId)) || {
    id: it.unitId,
    unit_name: it.unitName,
    price: it.price,
  };
}

function isKgCartLine(it) {
  return isKgSoldUnit(selectedSoldUnit(it)) || isKgSoldUnit(it);
}

function formatQty(it) {
  if (isKgCartLine(it)) return `${Number(it.quantity).toFixed(3)} كغم`;
  return it.quantity;
}

function formatUnitPrice(it) {
  if (isKgCartLine(it)) return `${ils(it.price)}/كغم`;
  return ils(it.price);
}

function preventButtonFocus(e) {
  e.preventDefault();
}

export function bumpQty(value, delta, decimals) {
  return Number((Number(value) + delta).toFixed(decimals));
}

function CartQtyStepper({
  value,
  min,
  step,
  decimals,
  ariaLabel,
  inputClassName,
  inputStep,
  onChange,
  autoFocus = false,
  placeholder,
}) {
  const qty = Number(value);
  const hasQty = Number.isFinite(qty) && qty > 0;
  const canMinus = hasQty && qty > min;

  const applyBump = (delta) => {
    if (!hasQty) return;
    const next = bumpQty(qty, delta, decimals);
    if (!(next > 0) || next < min) return;
    onChange(next);
    focusBarcodeInput({ releaseCartEdit: true });
  };

  return (
    <div className="pos-qty-controls" dir="ltr">
      <button
        type="button"
        className="pos-qty-btn"
        disabled={!canMinus}
        onMouseDown={preventButtonFocus}
        onClick={() => applyBump(-step)}
        aria-label="إنقاص الكمية"
      >
        −
      </button>
      <input
        type="number"
        className={inputClassName}
        min={min}
        step={inputStep}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.repeat) return;
          const next = Number(e.currentTarget.value);
          if (!(next > 0)) return;
          e.preventDefault();
          e.stopPropagation();
          focusBarcodeInput({ releaseCartEdit: true });
        }}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") {
            onChange("");
            return;
          }
          const next = Number(raw);
          if (!(next > 0)) return;
          onChange(next);
        }}
      />
      <button
        type="button"
        className="pos-qty-btn"
        disabled={!hasQty}
        onMouseDown={preventButtonFocus}
        onClick={() => applyBump(step)}
        aria-label="زيادة الكمية"
      >
        +
      </button>
    </div>
  );
}

function cartKey(it) {
  return it.cartKey ?? `${it.id}-${it.unitId ?? "0"}`;
}

function CartColGroup() {
  return (
    <colgroup>
      <col className="pos-col-index" />
      <col className="pos-col-name-col" />
      <col className="pos-col-unit-col" />
      <col className="pos-col-qty" />
      <col className="pos-col-price" />
      <col className="pos-col-subtotal" />
      <col className="pos-col-actions" />
    </colgroup>
  );
}

function CartTableHeader() {
  return (
    <div className="pos-cart-table-header">
      <table className="pos-cart-table pos-cart-table--head">
        <CartColGroup />
        <thead>
          <tr>
            <th>#</th>
            <th>الصنف</th>
            <th>الوحدة</th>
            <th>كم</th>
            <th>سعر</th>
            <th>مجموع</th>
            <th />
          </tr>
        </thead>
      </table>
    </div>
  );
}

function CartTableBody({
  cartItems,
  scrollToCartKey,
  lineDiscounts,
  activePromos,
  onQuantityChange,
  onRemoveItem,
  onUnitChange,
}) {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!scrollToCartKey) return;
    const escaped =
      typeof CSS !== "undefined" && CSS.escape
        ? CSS.escape(scrollToCartKey)
        : scrollToCartKey.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const row = scrollRef.current?.querySelector(`[data-cart-key="${escaped}"]`);
    row?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [scrollToCartKey, cartItems]);

  return (
    <div className="pos-cart-scroll" ref={scrollRef}>
      <table className="pos-cart-table pos-cart-table--body">
        <CartColGroup />
        <tbody>
          {cartItems.length === 0 ? (
            <tr>
              <td colSpan={7} className="pos-cart-empty">
                <Icon name="purchases" size={28} className="pos-cart-empty-icon" />
                <span>امسح باركوداً أو اضغط زراً سريعاً</span>
              </td>
            </tr>
          ) : (
            cartItems.map((it, i) => {
              const units = it.availableUnits || [];
              const multiUnit = units.length > 1;
              const key = cartKey(it);
              const promoKey = cartItemPromoKey(it);
              const lineDiscount = Number(lineDiscounts?.[promoKey]) || 0;
              const lineTotal = computeDealLineTotal(it, activePromos);
              const kgLine = isKgCartLine(it);
              const rowClass = [
                lineDiscount > 0 ? "pos-line--deal" : "",
                kgLine ? "pos-line--weight" : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined;
              return (
                <tr key={key} data-cart-key={key} className={rowClass}>
                  <td>{i + 1}</td>
                  <td className="pos-col-name" title={it.name}>
                    {it.name}
                  </td>
                  <td className="pos-col-unit">
                    {multiUnit ? (
                      <select
                        className="pos-unit-select"
                        value={it.unitId ?? ""}
                        onChange={(e) => {
                          onUnitChange?.(key, Number(e.target.value));
                          focusBarcodeInput({ releaseCartEdit: true });
                        }}
                        aria-label="وحدة البيع"
                      >
                        {units.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.unit_name} ({ils(u.price)})
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span>{it.unitName || "حبة"}</span>
                    )}
                  </td>
                  <td className="pos-col-qty">
                    {kgLine && it.weighed ? (
                      // Scale-printed weight barcode: qty is fixed by the label — read-only.
                      <span className="pos-qty-val pos-qty-val--weight">{formatQty(it)}</span>
                    ) : kgLine ? (
                      // KG unit without a scale weight: cashier must type the kilograms.
                      <CartQtyStepper
                        value={it.quantity === "" || it.quantity == null ? "" : it.quantity}
                        min={0.001}
                        step={0.1}
                        decimals={3}
                        inputStep="0.001"
                        inputClassName="pos-qty-input pos-qty-input--kg"
                        ariaLabel="الكمية (كغم)"
                        placeholder="الوزن"
                        autoFocus={Boolean(it.awaitingWeight) && key === scrollToCartKey}
                        onChange={(next) => onQuantityChange(key, next)}
                      />
                    ) : (
                      <CartQtyStepper
                        value={it.quantity}
                        min={1}
                        step={1}
                        decimals={0}
                        inputStep="any"
                        inputClassName="pos-qty-input"
                        ariaLabel="الكمية"
                        onChange={(next) => onQuantityChange(key, next)}
                      />
                    )}
                  </td>
                  <td className="pos-col-money">{formatUnitPrice(it)}</td>
                  <td className="pos-col-money">
                    {ils(lineTotal)}
                    {lineDiscount > 0 ? <span className="pos-line-deal-hint">عرض</span> : null}
                  </td>
                  <td className="pos-col-actions">
                    <button
                      type="button"
                      className="pos-remove-btn"
                      onMouseDown={preventButtonFocus}
                      onClick={() => {
                        onRemoveItem(key);
                        focusBarcodeInput({ releaseCartEdit: true });
                      }}
                      aria-label="حذف"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function PosCartTable({
  cartItems,
  scrollToCartKey,
  lineDiscounts,
  activePromos,
  onQuantityChange,
  onRemoveItem,
  onUnitChange,
}) {
  return (
    <section className="pos-cart-panel" aria-label="سلة المشتريات" data-enter-nav="" onKeyDown={handleEnterNavKeyDown}>
      <CartTableHeader />
      <CartTableBody
        cartItems={cartItems}
        scrollToCartKey={scrollToCartKey}
        lineDiscounts={lineDiscounts}
        activePromos={activePromos}
        onQuantityChange={onQuantityChange}
        onRemoveItem={onRemoveItem}
        onUnitChange={onUnitChange}
      />
    </section>
  );
}
