import { useEffect, useRef, useState } from "react";
import { createAbortController } from "../../apiClient";
import { searchProductsApi } from "../../utils/productSearch";
import { lookupProductByBarcode } from "../../utils/barcode";
import { mapLookupToCartProduct } from "../../utils/cartProduct";
import { focusBarcodeInput } from "../../utils/focusBarcodeInput";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

export default function PosProductSearch({ onProductFound }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const searchReqRef = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    const ac = createAbortController();
    const reqId = ++searchReqRef.current;
    const timer = window.setTimeout(async () => {
      try {
        const rows = await searchProductsApi(q, { limit: 15, signal: ac.signal });
        if (reqId !== searchReqRef.current) return;
        setResults(rows);
      } catch (e) {
        if (e.code === "ERR_CANCELED" || e.name === "CanceledError") return;
        if (reqId !== searchReqRef.current) return;
        setResults([]);
      } finally {
        if (reqId === searchReqRef.current) setLoading(false);
      }
    }, 300);

    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [query]);

  async function pickProduct(product) {
    const code = product.matched_barcode || product.barcode;
    try {
      if (code) {
        const data = await lookupProductByBarcode(code);
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
