const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

/** Estimated stock after this line is sold. Negative is allowed (warning only). */
function estimatedAfter(it) {
  const stock = Number(it.stock);
  if (!Number.isFinite(stock)) return null;
  return stock - Number(it.quantity || 0);
}

export default function PosCartTable({
  cartItems,
  displayTotal,
  onQuantityChange,
  onRemoveItem,
}) {
  const negativeLines = cartItems.filter((it) => {
    const after = estimatedAfter(it);
    return after != null && after < 0;
  });

  return (
    <section className="pos-cart-panel" aria-label="سلة المشتريات">
      <div className="pos-cart-total-banner">{ils(displayTotal)}</div>
      {negativeLines.length > 0 ? (
        <div className="pos-cart-stock-warn" role="status" aria-live="polite">
          تنبيه: المخزون سيصبح بالسالب لـ {negativeLines.length} صنف — البيع مسموح وسيستمر
        </div>
      ) : null}
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
                    {(() => {
                      const after = estimatedAfter(it);
                      if (after == null) return null;
                      return (
                        <span
                          className={`pos-stock-hint${after < 0 ? " pos-stock-hint-neg" : ""}`}
                        >
                          مخزون: {Number(it.stock)} ← {after}
                        </span>
                      );
                    })()}
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
