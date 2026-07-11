import { useEffect, useRef, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { lookupProductByBarcode } from "../utils/barcode";
import { searchProductsApi } from "../utils/productSearch";
import CameraBarcodeButton from "./barcode/CameraBarcodeButton";
import { Icon } from "./ui";
import "./barcode/barcode-scanner.css";

const cacheByScope = new Map();

async function loadProducts(scope = "retail") {
  const cacheKey = scope || "all";
  const now = Date.now();
  const cached = cacheByScope.get(cacheKey);
  if (cached && now - cached.time < 60000) return cached.data;
  const params = scope ? { scope } : {};
  const { data } = await api.get("/api/products", { params, headers: getAuthHeaders() });
  const rows = Array.isArray(data?.data ?? data) ? (data?.data ?? data) : [];
  cacheByScope.set(cacheKey, { data: rows, time: now });
  return rows;
}

/** Autocomplete product picker. onPick(product) called on selection. */
export default function ProductPicker({
  onPick,
  placeholder = "ابحث عن منتج بالاسم أو الباركود…",
  enableCamera = true,
  scope = "retail",
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [scanErr, setScanErr] = useState("");
  const ref = useRef(null);

  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults([]);
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const rows = await searchProductsApi(term, { limit: 20, scope });
        setResults(rows);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => window.clearTimeout(timer);
  }, [q, scope]);

  async function handleCameraScan(code) {
    setScanErr("");
    try {
      const product = await lookupProductByBarcode(code);
      if (scope && String(product.inventory_scope || "retail") !== scope) {
        throw new Error(scope === "bakery" ? "هذا الصنف ليس من مواد المخبز" : "هذا الصنف ليس من منتجات المتجر");
      }
      onPick(product);
      setQ("");
      setOpen(false);
      setResults([]);
    } catch (e) {
      setScanErr(e.message || "تعذّر البحث");
    }
  }

  function pickProduct(product) {
    onPick(product);
    setQ("");
    setOpen(false);
    setResults([]);
  }

  function onSearchKeyDown(e) {
    if (e.key !== "Enter" || e.defaultPrevented) return;
    if (open && q.trim() && !loading && results.length > 0) {
      e.preventDefault();
      pickProduct(results[0]);
    }
  }

  return (
    <div ref={ref}>
      <div className="barcode-input-row">
        <div className="ui-search" style={{ position: "relative", flex: 1 }}>
          <Icon name="search" />
          <input
            className="ui-input"
            value={q}
            placeholder={placeholder}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
              setScanErr("");
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onSearchKeyDown}
          />
          {open && q.trim() && !loading && results.length > 0 && (
            <ul
              className="search-dropdown"
              style={{
                position: "absolute",
                insetInlineStart: 0,
                insetInlineEnd: 0,
                zIndex: 20,
              }}
            >
              {results.map((p) => (
                <li
                  key={p.id}
                  onClick={() => pickProduct(p)}
                >
                  <strong>{p.name}</strong>
                  <span
                    style={{
                      color: "var(--office-panel-muted)",
                      marginInlineStart: 8,
                    }}
                  >
                    {p.matched_barcode || p.barcode} · مخزون {p.stock} · كلفة{" "}
                    {Number(p.cost).toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {open && q.trim() && loading && (
            <p className="search-dropdown-hint" style={{ margin: "0.35rem 0", fontSize: "0.85rem" }}>
              جاري البحث…
            </p>
          )}
        </div>
        {enableCamera ? <CameraBarcodeButton onScan={handleCameraScan} /> : null}
      </div>
      {scanErr ? <div className="barcode-scan-err">{scanErr}</div> : null}
    </div>
  );
}

export function invalidateProductCache(scope) {
  if (scope) {
    cacheByScope.delete(scope);
    return;
  }
  cacheByScope.clear();
}

export { loadProducts };
