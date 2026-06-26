import { useEffect, useState } from "react";
import api from "../../apiClient";
import { getAuthHeaders } from "../../utils/auth";
import { searchProductsApi } from "../../utils/productSearch";
import { mapLookupToCartProduct } from "../../utils/cartProduct";
import { focusBarcodeInput } from "../../utils/focusBarcodeInput";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

export default function PosProductSearch({ onProductFound }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const rows = await searchProductsApi(q, { limit: 15 });
        setResults(rows);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => window.clearTimeout(timer);
  }, [query]);

  async function pickProduct(product) {
    const code = product.matched_barcode || product.barcode;
    try {
      if (code) {
        const { data } = await api.get(
          `/api/products/by-barcode/${encodeURIComponent(String(code))}`,
          { headers: getAuthHeaders() }
        );
        onProductFound(mapLookupToCartProduct(data));
      } else {
        onProductFound(mapLookupToCartProduct({ product, ...product }));
      }
    } catch {
      onProductFound(mapLookupToCartProduct({ product, ...product }));
    }
    setQuery("");
    setResults([]);
    setTimeout(() => focusBarcodeInput(), 0);
  }

  const trimmed = query.trim();
  const showDropdown = trimmed.length >= 2 && (loading || results.length > 0);

  return (
    <div className="pos-product-search">
      <input
        type="text"
        className="pos-product-search-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="بحث بالاسم أو الباركود…"
        autoComplete="off"
      />
      {showDropdown ? (
        <ul className="search-dropdown pos-product-search-dropdown">
          {loading ? (
            <li className="pos-product-search-status">جاري البحث…</li>
          ) : (
            results.map((p) => (
              <li key={p.id} onClick={() => pickProduct(p)}>
                {p.name} — {p.matched_barcode || p.barcode} ({ils(p.price)})
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
