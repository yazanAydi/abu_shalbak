import { useEffect, useRef } from "react";
import { focusBarcodeInput } from "../../utils/focusBarcodeInput";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

function preventButtonFocus(e) {
  e.preventDefault();
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
                امسح باركوداً أو اضغط زراً سريعاً
              </td>
            </tr>
          ) : (
            cartItems.map((it, i) => {
              const units = it.availableUnits || [];
              const multiUnit = units.length > 1;
              const key = cartKey(it);
              return (
                <tr key={key} data-cart-key={key}>
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
                          focusBarcodeInput();
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
                    <div className="pos-qty-controls">
                      <button
                        type="button"
                        className="pos-qty-btn"
                        onMouseDown={preventButtonFocus}
                        onClick={() => {
                          onQuantityChange(key, Math.max(1, it.quantity - 1));
                          focusBarcodeInput();
                        }}
                        aria-label="نقص"
                      >
                        −
                      </button>
                      <span className="pos-qty-val">{it.quantity}</span>
                      <button
                        type="button"
                        className="pos-qty-btn"
                        onMouseDown={preventButtonFocus}
                        onClick={() => {
                          onQuantityChange(key, it.quantity + 1);
                          focusBarcodeInput();
                        }}
                        aria-label="زيادة"
                      >
                        +
                      </button>
                    </div>
                  </td>
                  <td className="pos-col-money">{ils(it.price)}</td>
                  <td className="pos-col-money">{ils(it.subtotal)}</td>
                  <td className="pos-col-actions">
                    <button
                      type="button"
                      className="pos-remove-btn"
                      onMouseDown={preventButtonFocus}
                      onClick={() => {
                        onRemoveItem(key);
                        focusBarcodeInput();
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
  onQuantityChange,
  onRemoveItem,
  onUnitChange,
}) {
  return (
    <section className="pos-cart-panel" aria-label="سلة المشتريات">
      <CartTableHeader />
      <CartTableBody
        cartItems={cartItems}
        scrollToCartKey={scrollToCartKey}
        onQuantityChange={onQuantityChange}
        onRemoveItem={onRemoveItem}
        onUnitChange={onUnitChange}
      />
    </section>
  );
}
