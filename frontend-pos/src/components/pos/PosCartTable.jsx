const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

export default function PosCartTable({
  cartItems,
  displayTotal,
  onQuantityChange,
  onRemoveItem,
}) {
  return (
    <section className="pos-cart-panel" aria-label="سلة المشتريات">
      <div className="pos-cart-total-banner">{ils(displayTotal)}</div>
      <div className="pos-cart-scroll">
        <table className="pos-cart-table">
          <thead>
            <tr>
              <th>#</th>
              <th>الصنف</th>
              <th>كم</th>
              <th>سعر</th>
              <th>مجموع</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cartItems.length === 0 ? (
              <tr>
                <td colSpan={6} className="pos-cart-empty">
                  امسح باركوداً أو اضغط زراً سريعاً
                </td>
              </tr>
            ) : (
              cartItems.map((it, i) => (
                <tr key={it.id}>
                  <td>{i + 1}</td>
                  <td className="pos-col-name" title={it.name}>
                    {it.name}
                  </td>
                  <td>
                    <div className="pos-qty-controls">
                      <button
                        type="button"
                        className="pos-qty-btn"
                        onClick={() =>
                          onQuantityChange(it.id, Math.max(1, it.quantity - 1))
                        }
                        aria-label="نقص"
                      >
                        −
                      </button>
                      <span className="pos-qty-val">{it.quantity}</span>
                      <button
                        type="button"
                        className="pos-qty-btn"
                        onClick={() => onQuantityChange(it.id, it.quantity + 1)}
                        aria-label="زيادة"
                      >
                        +
                      </button>
                    </div>
                  </td>
                  <td>{ils(it.price)}</td>
                  <td>{ils(it.subtotal)}</td>
                  <td>
                    <button
                      type="button"
                      className="pos-remove-btn"
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
    </section>
  );
}
