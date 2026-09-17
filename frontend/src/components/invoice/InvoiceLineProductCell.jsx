import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { searchProductsApi } from "../../utils/productSearch";
import { displayProductSku } from "../../utils/entityCodeDisplay";
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
        setResults(rows);
        setHighlight(0);
      } catch {
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

  function pickProduct(product) {
    if (!product) return;
    onPick(product);
    setQ(product.name || "");
    setDirty(false);
    setOpen(false);
    setResults([]);
    requestAnimationFrame(() => {
      if (inputRef.current) focusNextField(inputRef.current);
    });
  }

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
    if (e.key !== "Enter" || e.defaultPrevented) return;
    if (open && dirty && q.trim() && !loading && results.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      const idx = highlight >= 0 && highlight < results.length ? highlight : 0;
      pickProduct(results[idx]);
    }
  }

  return (
    <div className={`invoice-product-cell ${value ? "invoice-product-cell--picked" : ""}`} ref={ref}>
      <input
        ref={inputRef}
        className="ui-input"
        role="combobox"
        aria-expanded={Boolean(open && dirty && q.trim())}
        aria-autocomplete="list"
        data-invoice-field="product"
        data-invoice-product={lineKey || ""}
        value={q}
        placeholder="اسم أو باركود…"
        autoComplete="off"
        onChange={(e) => {
          setQ(e.target.value);
          setDirty(true);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onSearchKeyDown}
      />
      {open && dirty && q.trim() && loading ? (
        <p className="invoice-product-cell__hint">جاري البحث…</p>
      ) : null}
      {showList && menuStyle
        ? createPortal(
          <ul
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
                  pickProduct(p);
                }}
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
