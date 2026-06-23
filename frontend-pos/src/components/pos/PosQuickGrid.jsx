import { useEffect, useState } from "react";
import api from "../../apiClient";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

export default function PosQuickGrid({ onProductFound }) {
  const [categories, setCategories] = useState([]);
  const [buttonsByCategory, setButtonsByCategory] = useState({});
  const [activeCategory, setActiveCategory] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get("/api/pos/quick-buttons")
      .then(({ data }) => {
        const cats = Array.isArray(data?.categories) ? data.categories : [];
        const byCat =
          data?.buttonsByCategory && typeof data.buttonsByCategory === "object"
            ? data.buttonsByCategory
            : {};
        setCategories(cats);
        setButtonsByCategory(byCat);
        setActiveCategory(cats[0] ?? null);
      })
      .catch(() => {
        setCategories([]);
        setButtonsByCategory({});
        setActiveCategory(null);
      })
      .finally(() => setLoading(false));
  }, []);

  function tap(p) {
    onProductFound({
      id: p.id,
      barcode: p.barcode,
      name: p.name,
      price: p.price,
      stock: p.stock,
      tax_rate: p.tax_rate,
    });
  }

  const items =
    activeCategory && Array.isArray(buttonsByCategory[activeCategory])
      ? buttonsByCategory[activeCategory]
      : [];

  return (
    <section className="pos-quick-panel" aria-label="أزرار سريعة">
      <p className="pos-quick-title">أزرار سريعة</p>
      {categories.length > 0 && (
        <nav className="pos-quick-tabs" aria-label="أقسام الأزرار السريعة">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`pos-quick-tab${activeCategory === cat ? " pos-quick-tab--active" : ""}`}
              onClick={() => setActiveCategory(cat)}
              aria-pressed={activeCategory === cat}
            >
              {cat}
            </button>
          ))}
        </nav>
      )}
      <div className="pos-quick-grid">
        {loading ? (
          <p className="pos-quick-empty">جاري التحميل…</p>
        ) : categories.length === 0 ? (
          <p className="pos-quick-empty">
            لا توجد أقسام مُعدّة.
            <br />
            يضيفها المدير من إعدادات المتجر.
          </p>
        ) : items.length === 0 ? (
          <p className="pos-quick-empty">لا توجد أزرار في هذا القسم</p>
        ) : (
          items.map((p) => {
            const outOfStock = Number(p.stock) <= 0;
            return (
            <button
              key={p.id}
              type="button"
              className={`pos-quick-btn${outOfStock ? " pos-quick-btn--no-stock" : ""}`}
              onClick={() => tap(p)}
              title={outOfStock ? `${p.barcode} — الرصيد: 0` : p.barcode}
            >
              <span>{p.name}</span>
              <span className="pos-quick-price">{ils(p.price)}</span>
            </button>
            );
          })
        )}
      </div>
    </section>
  );
}
