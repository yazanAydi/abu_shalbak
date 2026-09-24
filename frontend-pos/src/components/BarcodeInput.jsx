import { useEffect, useRef, useState, useCallback } from "react";
import { createAbortController } from "../apiClient";
import { focusBarcodeInput } from "../utils/focusBarcodeInput";
import { lookupProductByBarcode, normalizeBarcode } from "../utils/barcode";
import { searchProductsApi } from "../utils/productSearch";
import { pickSearchProduct } from "./pos/PosProductSearch";
import {
  playProductNotFound,
  unlockPosAudio,
  warmPosSounds,
} from "../utils/posSounds";
import "./BarcodeInput.css";

const notFoundCache = new Set();

function isNotFoundError(e) {
  const status = e.response?.status;
  const apiError = e.response?.data?.error || e.message || "";
  return (
    status === 404 || /غير موجود|لم يُعثر|not found/i.test(String(apiError))
  );
}

export function resetBarcodeNotFoundCacheForTests() {
  notFoundCache.clear();
}

export function seedBarcodeNotFoundCacheForTests(code) {
  const normalized = normalizeBarcode(code);
  if (normalized) notFoundCache.add(normalized);
}

export function barcodeNotFoundCacheHasForTests(code) {
  return notFoundCache.has(normalizeBarcode(code));
}

export default function BarcodeInput({ onProductFound, onError }) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");
  const inputRef = useRef(null);
  const errTimer = useRef(null);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const inFlightRef = useRef(false);
  const inFlightCodeRef = useRef(null);
  const queueRef = useRef([]);
  const searchReqRef = useRef(0);
  const pickGenRef = useRef(0);
  const onProductFoundRef = useRef(onProductFound);
  onProductFoundRef.current = onProductFound;

  const clearErrLater = useCallback(() => {
    if (errTimer.current) clearTimeout(errTimer.current);
    errTimer.current = setTimeout(() => setErr(""), 3000);
  }, []);

  useEffect(() => {
    focusBarcodeInput();
    return () => {
      if (errTimer.current) clearTimeout(errTimer.current);
    };
  }, []);

  useEffect(() => {
    const q = value.trim();
    setHighlight(-1);
    if (q.length < 2 || inFlightRef.current) {
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
  }, [value]);

  const search = useCallback(
    async (raw) => {
      const code = normalizeBarcode(raw);
      if (!code) return;
      searchReqRef.current += 1;
      pickGenRef.current += 1;
      setResults([]);
      setHighlight(-1);
      if (inFlightRef.current) {
        if (code === inFlightCodeRef.current || queueRef.current.includes(code)) {
          return;
        }
        queueRef.current.push(code);
        return;
      }
      inFlightRef.current = true;
      inFlightCodeRef.current = code;
      unlockPosAudio();
      warmPosSounds();

      const notFoundMsg = `لم يُعثر على المنتج (${code}) — أضفه من «إدارة المنتجات» أو جرّب 1234567890`;

      try {
        try {
          const data = await lookupProductByBarcode(code);
          notFoundCache.delete(code);
          onProductFoundRef.current?.(data);
          setErr("");
        } catch (e) {
          const notFound = isNotFoundError(e);
          if (notFound) {
            notFoundCache.add(code);
            playProductNotFound();
          }
          const msg = notFound
            ? notFoundMsg
            : e.response?.data?.error || e.message || "تعذّر البحث";
          setErr(msg);
          onError?.(msg);
          clearErrLater();
        }
        if (queueRef.current.length === 0) {
          setValue("");
          setTimeout(() => focusBarcodeInput(), 0);
        }
      } finally {
        inFlightRef.current = false;
        inFlightCodeRef.current = null;
        const next = queueRef.current.shift();
        if (next) search(next);
      }
    },
    [onError, clearErrLater]
  );

  async function chooseSuggestion(product) {
    if (!product || inFlightRef.current) return;
    const gen = pickGenRef.current;
    const typed = inputRef.current?.value ?? value;
    searchReqRef.current += 1;
    setResults([]);
    setHighlight(-1);
    await pickSearchProduct(product, typed, (cartProduct) => {
      if (gen !== pickGenRef.current) return;
      onProductFoundRef.current?.(cartProduct);
    });
    if (gen !== pickGenRef.current) return;
    setValue("");
    setErr("");
    setTimeout(() => focusBarcodeInput(), 0);
  }

  function onKeyDown(ev) {
    if (ev.key === "ArrowDown" && results.length) {
      ev.preventDefault();
      setHighlight((index) => (index + 1) % results.length);
      return;
    }
    if (ev.key === "ArrowUp" && results.length) {
      ev.preventDefault();
      setHighlight((index) => (index <= 0 ? results.length - 1 : index - 1));
      return;
    }
    if (ev.key === "Escape") {
      searchReqRef.current += 1;
      setResults([]);
      setHighlight(-1);
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      const live = ev.currentTarget?.value ?? value;
      const code = normalizeBarcode(live);
      const row = highlight >= 0 ? results[highlight] : null;
      if (row && !/^\d+$/.test(code)) {
        chooseSuggestion(row);
        return;
      }
      search(live);
    }
  }

  return (
    <div className="barcode-wrap" data-enter-nav-skip="">
      <label className="barcode-label">مسح الباركود</label>
      <input
        ref={inputRef}
        className="barcode-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="امسح الباركود أو ابحث باسم المنتج أو رقمه"
        autoComplete="off"
        role="combobox"
        aria-expanded={results.length > 0 || loading}
        aria-controls="pos-scan-results"
        aria-activedescendant={highlight >= 0 ? `pos-scan-opt-${highlight}` : undefined}
      />
      {value.trim().length >= 2 && (loading || results.length > 0) ? (
        <ul id="pos-scan-results" className="search-dropdown pos-product-search-dropdown" role="listbox">
          {loading && results.length === 0 ? (
            <li className="pos-product-search-status">جاري البحث…</li>
          ) : (
            results.map((product, index) => (
              <li
                key={product.id}
                id={`pos-scan-opt-${index}`}
                role="option"
                aria-selected={index === highlight}
                className={index === highlight ? "is-active" : undefined}
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => chooseSuggestion(product)}
              >
                {product.name}
                {" — "}
                {product.sku || product.barcode || (product.scale_code ? `كود الميزان ${product.scale_code}` : "")}
                {product.price != null ? ` (₪${Number(product.price).toFixed(2)})` : ""}
              </li>
            ))
          )}
        </ul>
      ) : null}
      {err ? <div className="barcode-err">{err}</div> : null}
    </div>
  );
}
