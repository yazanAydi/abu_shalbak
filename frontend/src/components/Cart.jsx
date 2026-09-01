import "./Cart.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

export default function Cart({ cartItems, onQuantityChange, onRemoveItem }) {
  const subtotal = cartItems.reduce((s, it) => s + (it.subtotal || 0), 0);
  const total = subtotal;

  return (
    <div className="cart">
      <h2 className="cart-heading">سلة المشتريات</h2>
      <div className="cart-table-wrap">
        <table className="cart-table">
          <thead>
            <tr>
              <th className="col-name">المنتج</th>
              <th className="col-qty">الكمية</th>
              <th className="col-price">السعر</th>
              <th className="col-sub">المجموع</th>
              <th className="col-x" />
            </tr>
          </thead>
          <tbody>
            {cartItems.length === 0 ? (
              <tr>
                <td colSpan={5} className="cart-empty">
                  لا توجد أصناف
                </td>
              </tr>
            ) : (
              cartItems.map((it) => (
                <tr key={it.id}>
                  <td className="col-name">{it.name}</td>
                  <td className="col-qty">
                    <input
                      type="number"
                      className="qty-input"
                      min={1}
                      step="any"
                      value={it.quantity}
                      aria-label="الكمية"
                      onChange={(e) => {
                        const next = Number(e.target.value);
                        if (!(next > 0)) return;
                        onQuantityChange(it.id, next);
                      }}
                    />
                  </td>
                  <td className="col-price">{ils(it.price)}</td>
                  <td className="col-sub">{ils(it.subtotal)}</td>
                  <td className="col-x">
                    <button
                      type="button"
                      className="remove-x"
                      onClick={() => onRemoveItem(it.id)}
                      aria-label="حذف"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="cart-totals">
        <div className="tot-row">
          <span>المجموع الفرعي</span>
          <span>{ils(subtotal)}</span>
        </div>
        <div className="tot-row tot-grand">
          <span>الإجمالي</span>
          <span>{ils(total)}</span>
        </div>
      </div>
    </div>
  );
}
