import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isPartyValue, searchPartiesApi } from "../utils/partySearch";

const LIST_MAX_HEIGHT = 240;

/** Autocomplete picker for customers and suppliers. */
export default function PartyPicker({
  value = null,
  onPick,
  placeholder = "ابحث بالاسم أو الرقم…",
}) {
  const picked = isPartyValue(value);
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [menuStyle, setMenuStyle] = useState(null);
  const rootRef = useRef(null);
  const listRef = useRef(null);

  const placeMenu = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const gap = 4;
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const openUp = spaceBelow < 140 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(120, Math.min(LIST_MAX_HEIGHT, openUp ? spaceAbove : spaceBelow));
    setMenuStyle({
      position: "fixed",
      left: rect.left,
      width: Math.max(rect.width, 240),
      top: openUp ? rect.top - maxHeight - gap : rect.bottom + gap,
      maxHeight,
      zIndex: 2100,
    });
  }, []);

  useEffect(() => {
    const onDoc = (e) => {
      const t = e.target;
      if (rootRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    if (picked) {
      setQ("");
      setResults([]);
      setOpen(false);
      setLoading(false);
      return undefined;
    }
    if (!open) return undefined;

    let cancelled = false;
    setLoading(true);
    const term = q.trim();
    const timer = window.setTimeout(async () => {
      try {
        const rows = await searchPartiesApi(term);
        if (!cancelled) setResults(rows);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, term ? 300 : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [q, picked, open]);

  useEffect(() => {
    if (!open || picked) return undefined;
    placeMenu();
    const onReposition = () => placeMenu();
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, picked, results.length, loading, placeMenu]);

  function clear() {
    onPick(null);
    setQ("");
    setResults([]);
    setOpen(false);
  }

  function pickParty(p) {
    if (!isPartyValue(p)) return;
    onPick(p);
    setQ("");
    setOpen(false);
    setResults([]);
  }

  function onSearchKeyDown(e) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key !== "Enter" || e.defaultPrevented) return;
    if (open && !loading && results.length > 0) {
      e.preventDefault();
      pickParty(results[0]);
    }
  }

  if (picked) {
    return (
      <div className="party-picker party-picker--selected" ref={rootRef}>
        <div className="party-picker-selected">
          <span className="party-badge">{value.badge}</span>
          <strong>{value.name}</strong>
          {value.code ? (
            <span className="party-picker-code">{value.code}</span>
          ) : null}
          <button type="button" className="btn-link party-picker-clear" onClick={clear} aria-label="مسح">
            ✕
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="party-picker" ref={rootRef}>
      <input
        className="ui-input"
        value={q}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        autoComplete="off"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={onSearchKeyDown}
      />
      {open &&
        menuStyle &&
        createPortal(
          <div
            className="search-dropdown party-picker__list"
            ref={listRef}
            style={menuStyle}
            onWheel={(e) => e.stopPropagation()}
          >
            {loading ? (
              <p className="search-dropdown-hint">جاري البحث…</p>
            ) : results.length === 0 ? (
              <p className="search-dropdown-hint">لا توجد نتائج</p>
            ) : (
              <ul>
                {results.map((p) => (
                  <li
                    key={`${p.type}-${p.id}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickParty(p);
                    }}
                  >
                    <span className="party-badge">{p.badge}</span>
                    <strong>{p.name}</strong>
                    {p.code ? (
                      <span className="party-picker-code">{p.code}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
