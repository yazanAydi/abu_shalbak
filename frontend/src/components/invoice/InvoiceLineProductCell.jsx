import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { searchProductsApi } from "../../utils/productSearch";
import { displayProductSku } from "../../utils/entityCodeDisplay";
import { normalizeBarcode } from "../../utils/barcode";
import { focusNextField } from "../../utils/focusNavigation";

/**
 * In-row searchable product selector for purchase/sales invoice lines.
 */
export default function InvoiceLineProductCell({
  value,
  productName,
  onPick,
  scope = "retail",
  membership = null,
  kind = null,
  autoFocus = false,
  lineKey,
  commitScan = false,
  duplicate = false,
}) {
  const [q, setQ] = useState(productName || "");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [menuStyle, setMenuStyle] = useState(null);
  const ref = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const listId = useId();
  const pendingScanRef = useRef("");
  const resultQueryRef = useRef("");

  const showList = open && dirty && q.trim() && !loading && results.length > 0;

  const placeMenu = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const gap = 4;
    const width = Math.max(rect.width, 256);
    const maxHeight = 220;
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const openUp = spaceBelow < 120 && rect.top > spaceBelow;
    setMenuStyle({
      position: "fixed",
      left: Math.min(rect.left, window.innerWidth - width - 8),
      width,
      top: openUp ? Math.max(8, rect.top - maxHeight - gap) : rect.bottom + gap,
      maxHeight,
      zIndex: 2400,
    });
  }, []);

  useEffect(() => {
    if (!dirty) setQ(productName || "");
  }, [productName, dirty]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus, lineKey]);

  useEffect(() => {
    const onDoc = (e) => {
      const t = e.target;
      if (ref.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
      if (productName) {
        setQ(productName);
        setDirty(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [productName]);

  useEffect(() => {
    if (!dirty) return undefined;
    const term = q.trim();
    if (!term) {
      setResults([]);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
                    const rows = await searchProductsApi(term, {
                      limit: 20,
                      ...(scope ? { scope } : {}),
                      ...(membership ? { membership, ...(kind ? { kind } : {}) } : {}),
                    });
        resultQueryRef.current = term;
        setResults(rows);
        setHighlight(0);
      } catch {
        resultQueryRef.current = term;
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [q, scope, membership, kind, dirty]);

  useEffect(() => {
    if (!showList) return undefined;
    placeMenu();
    const onReposition = () => placeMenu();
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [showList, results.length, placeMenu]);

  const pickProduct = useCallback((product, { deferFocus = false } = {}) => {
    if (!product) return;
    const accepted = onPick(product);
    if (accepted === false) {
      setOpen(false);
      setResults([]);
      setQ(productName || "");
      setDirty(false);
      return;
    }
    setQ(product.name || "");
    setDirty(false);
    setOpen(false);
    setResults([]);
    // Stock counts focus quantity synchronously in onPick, including touch taps.
    if (!deferFocus && !commitScan) {
      requestAnimationFrame(() => {
        if (inputRef.current) focusNextField(inputRef.current);
      });
    }
  }, [onPick, productName, commitScan]);

  const resolveScan = useCallback((query, rows, highlighted) => {
    const code = normalizeBarcode(query);
    const isBarcode = /^\d{4,14}$/.test(code);
    if (isBarcode) {
      const hits = rows.filter((product) => (
        [product?.matched_barcode, product?.barcode, product?.unit_barcode].some(
          (value) => value && normalizeBarcode(value) === code
        )
      ));
      if (hits.length === 1) pickProduct(hits[0], { deferFocus: true });
      return;
    }
    if (rows.length > 0) {
      const idx = highlighted >= 0 && highlighted < rows.length ? highlighted : 0;
      pickProduct(rows[idx], { deferFocus: commitScan });
    }
  }, [commitScan, pickProduct]);

  useEffect(() => {
    if (!commitScan || loading) return;
    const pending = pendingScanRef.current;
    if (!pending || pending !== q.trim() || resultQueryRef.current !== pending) return;
    pendingScanRef.current = "";
    resolveScan(pending, results, highlight);
  }, [commitScan, loading, q, results, highlight, resolveScan]);

  function onSearchKeyDown(e) {
    if (e.key === "ArrowDown") {
      if (open && results.length > 0) {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, results.length - 1));
      }
      return;
    }
    if (e.key === "ArrowUp") {
      if (open && results.length > 0) {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
      }
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
      if (productName) {
        setQ(productName);
        setDirty(false);
      }
      return;
    }
    const scanKey = e.key === "Enter" || (commitScan && e.key === "Tab");
    if (!scanKey || e.defaultPrevented || e.repeat) return;
    const query = q.trim();
    if (commitScan && query) {
      e.preventDefault();
      e.stopPropagation();
      if (loading || resultQueryRef.current !== query) {
        pendingScanRef.current = query;
        return;
      }
      resolveScan(query, results, highlight);
      return;
    }
    if (e.key === "Enter" && open && dirty && query && !loading && results.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      const idx = highlight >= 0 && highlight < results.length ? highlight : 0;
      pickProduct(results[idx]);
    }
  }

  return (
    <div className={`invoice-product-cell ${value ? "invoice-product-cell--picked" : ""} ${duplicate ? "invoice-product-cell--duplicate" : ""}`} ref={ref}>
      <input
        ref={inputRef}
        className="ui-input"
        role="combobox"
        aria-expanded={Boolean(open && dirty && q.trim())}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-describedby={duplicate ? `${listId}-duplicate` : undefined}
        data-invoice-field="product"
        data-invoice-product={lineKey || ""}
        value={q}
        placeholder="اسم أو باركود…"
        autoComplete="off"
        inputMode="text"
        onChange={(e) => {
          setQ(e.target.value);
          setDirty(true);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onSearchKeyDown}
      />
      {duplicate ? (
        <p id={`${listId}-duplicate`} className="invoice-product-cell__duplicate">الصنف مكرر في الجرد</p>
      ) : null}
      {open && dirty && q.trim() && loading ? (
        <p className="invoice-product-cell__hint">جاري البحث…</p>
      ) : null}
      {showList && menuStyle
        ? createPortal(
          <ul
            id={listId}
            className="search-dropdown invoice-product-cell__list"
            role="listbox"
            ref={listRef}
            style={menuStyle}
          >
            {results.map((p, i) => (
              <li
                key={p.id}
                className={i === highlight ? "is-active" : ""}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (!commitScan) pickProduct(p);
                }}
                onClick={commitScan ? () => pickProduct(p) : undefined}
              >
                <strong>{p.name}</strong>
                <span>
                  {`${p.matched_barcode || p.barcode || displayProductSku(p.sku) || ""} · مخزون ${p.stock}`}
                </span>
              </li>
            ))}
          </ul>,
          document.body
        )
        : null}
      {open && dirty && q.trim() && !loading && results.length === 0 ? (
        <p className="invoice-product-cell__hint">لا توجد نتائج</p>
      ) : null}
    </div>
  );
}
