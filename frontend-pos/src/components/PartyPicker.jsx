import { useEffect, useRef, useState } from "react";
import { searchPartiesApi } from "../utils/partySearch";

/** Autocomplete picker for customers and suppliers. */
export default function PartyPicker({
  value = null,
  onPick,
  placeholder = "ابحث بالاسم أو الرقم…",
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    if (value) {
      setQ("");
      setResults([]);
      setOpen(false);
      return undefined;
    }

    const term = q.trim();
    if (!term) {
      setResults([]);
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const rows = await searchPartiesApi(term);
        setResults(rows);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => window.clearTimeout(timer);
  }, [q, value]);

  function clear() {
    onPick(null);
    setQ("");
    setResults([]);
    setOpen(false);
  }

  if (value) {
    return (
      <div className="party-picker party-picker--selected" ref={ref}>
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
    <div className="party-picker" ref={ref}>
      <div style={{ position: "relative" }}>
        <input
          value={q}
          placeholder={placeholder}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          style={{ width: "100%", padding: "0.4rem 0.6rem", border: "1px solid #cbd5e0", borderRadius: 5 }}
        />
        {open && q.trim() && loading && (
          <p className="search-dropdown-hint" style={{ margin: "0.35rem 0", fontSize: "0.85rem" }}>
            جاري البحث…
          </p>
        )}
        {open && q.trim() && !loading && results.length === 0 && (
          <p className="search-dropdown-hint" style={{ margin: "0.35rem 0", fontSize: "0.85rem" }}>
            لا توجد نتائج
          </p>
        )}
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
                key={`${p.type}-${p.id}`}
                onClick={() => {
                  onPick(p);
                  setQ("");
                  setOpen(false);
                  setResults([]);
                }}
              >
                <span className="party-badge">{p.badge}</span>
                <strong>{p.name}</strong>
                {p.code ? (
                  <span style={{ color: "#718096", marginInlineStart: 8 }}>
                    {p.code}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
