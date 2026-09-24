import { useEffect, useRef, useState } from "react";
import { createAbortController } from "../../apiClient";
import { searchProductsApi } from "../../utils/productSearch";
import { lookupProductByBarcode } from "../../utils/barcode";
import { isKgSoldUnit, mapLookupToCartProduct } from "../../utils/cartProduct";
import { focusBarcodeInput } from "../../utils/focusBarcodeInput";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

/**
 * Which code a name/search pick should look up.
 * A typed scale label or bare PLU wins over the regular barcode.
 * A name pick of a scale-only product uses the PLU, which has no weight.
 */
export async function pickSearchProduct(product, typed, onProductFound) {
  const scale = product.scale_code ? String(product.scale_code) : "";
  const code = resolveSearchPickCode(product, typed);
  try {
    if (code) {
      const data = await lookupProductByBarcode(code);
      onProductFound(mapLookupToCartProduct(data));
    } else if (isKgSoldUnit(product) || Number(product.is_weighed) === 1 || Number(product.scale_only) === 1) {
      onProductFound(mapLookupToCartProduct({
        product,
        ...product,
        needs_weight: true,
        unit_name: product.unit_name || "كغم",
      }));
    } else {
      onProductFound(mapLookupToCartProduct({ product, ...product }));
    }
  } catch {
    if (isKgSoldUnit(product) || scale) {
      onProductFound(mapLookupToCartProduct({
        product,
        ...product,
        needs_weight: true,
        unit_name: product.unit_name || "كغم",
      }));
    } else {
      onProductFound(mapLookupToCartProduct({ product, ...product }));
    }
  }
}

export function resolveSearchPickCode(product, typed) {
  const scale = product?.scale_code ? String(product.scale_code) : "";
  const regular = product?.barcode ? String(product.barcode) : "";
  const typedCode = String(typed || "").trim();
  if (scale && typedCode && (typedCode === scale || typedCode.startsWith(scale))) {
    return typedCode;
  }
  const regularCode = product?.matched_barcode || regular;
  if (regularCode) return String(regularCode);
  if (scale) return scale;
  return "";
}

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
    await pickSearchProduct(product, query.trim(), onProductFound);
    setQuery("");
    setResults([]);
    setTimeout(() => focusBarcodeInput(), 0);
  }

  const trimmed = query.trim();
  const showDropdown = trimmed.length >= 2 && (loading || results.length > 0);

  return (
    <div className="pos-product-search" data-enter-nav-skip="">
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
                {p.name} — {p.barcode || (p.scale_code ? `كود الميزان ${p.scale_code}` : p.matched_barcode || "")} ({ils(p.price)})
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
