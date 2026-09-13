import { useEffect, useRef, useState } from "react";
import { lookupProductByBarcode, looksLikeBarcodeQuery, normalizeBarcode } from "../utils/barcode";
import { searchProductsApi } from "../utils/productSearch";
import { displayProductSku } from "../utils/entityCodeDisplay";
import { SCANNER_SUBMIT_EVENT } from "../utils/blockDevToolsShortcuts";
import CameraBarcodeButton from "./barcode/CameraBarcodeButton";
import Icon from "./icons/Icon";
import "./barcode/barcode-scanner.css";

/** Autocomplete product picker. onPick(product) called on selection. */
export default function ProductPicker({
  onPick,
  placeholder = "ابحث عن منتج بالاسم أو الباركود…",
  enableCamera = true,
  scope = "retail",
  showIdentity = false,
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [scanErr, setScanErr] = useState("");
  const ref = useRef(null);
  const inputRef = useRef(null);
  const qRef = useRef("");
  const resultsRef = useRef([]);
  const loadingRef = useRef(false);
  const inFlightRef = useRef(false);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  qRef.current = q;
  resultsRef.current = results;
  loadingRef.current = loading;

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

  function clearQuery() {
    setQ("");
    setOpen(false);
    setResults([]);
  }

  async function handleCameraScan(code) {
    setScanErr("");
    try {
      const product = await lookupProductByBarcode(code);
      if (scope && String(product.inventory_scope || "retail") !== scope) {
        throw new Error(scope === "bakery" ? "هذا الصنف ليس من مواد المخبز" : "هذا الصنف ليس من منتجات المتجر");
      }
      onPickRef.current(product);
      clearQuery();
    } catch (e) {
      setScanErr(e.message || "تعذّر البحث");
    }
  }

  function pickProduct(product) {
    onPickRef.current(product);
    clearQuery();
  }

  async function submitScannedQuery() {
    const code = normalizeBarcode(qRef.current);
    if (!code || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      if (looksLikeBarcodeQuery(code)) {
        await handleCameraScan(code);
        return;
      }
      if (!loadingRef.current && resultsRef.current.length > 0) {
        pickProduct(resultsRef.current[0]);
      }
    } finally {
      inFlightRef.current = false;
    }
  }

  function onSearchKeyDown(e) {
    if (e.key === "Tab" && looksLikeBarcodeQuery(qRef.current)) {
      e.preventDefault();
      void submitScannedQuery();
      return;
    }
    if (e.key !== "Enter" || e.defaultPrevented) return;
    e.preventDefault();
    void submitScannedQuery();
  }

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return undefined;
    function onScannerSubmit() {
      void submitScannedQuery();
    }
    el.addEventListener(SCANNER_SUBMIT_EVENT, onScannerSubmit);
    return () => el.removeEventListener(SCANNER_SUBMIT_EVENT, onScannerSubmit);
  }, []);

  return (
    <div ref={ref}>
      <div className="barcode-input-row">
        <div className="ui-search" style={{ position: "relative", flex: 1 }}>
          <Icon name="search" />
          <input
            ref={inputRef}
            className="ui-input"
            value={q}
            placeholder={placeholder}
            autoComplete="off"
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
                    {showIdentity
                      ? `الرقم ${displayProductSku(p.sku)} · الباركود ${p.matched_barcode || p.barcode || "—"}`
                      : `${p.matched_barcode || p.barcode} · مخزون ${p.stock} · كلفة ${Number(p.cost).toFixed(2)}`}
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

export function invalidateProductCache() {
  /* search-only picker — no catalog cache */
}
