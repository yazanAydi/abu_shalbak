import { Children, useEffect, useMemo, useRef, useState } from "react";

function optionText(node) {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(optionText).join("");
  if (node.props && node.props.children !== undefined) return optionText(node.props.children);
  return "";
}

function parseOptions(children) {
  const out = [];
  Children.toArray(children).forEach((child) => {
    if (!child || !child.props) return;
    out.push({
      value: child.props.value ?? "",
      label: optionText(child.props.children),
      disabled: !!child.props.disabled,
    });
  });
  return out;
}

/**
 * Type-to-search combobox that is a drop-in replacement for a native <select>.
 * Keeps the same API: `value`, `onChange` (called as { target: { value } }), and
 * `<option>` children. Filters options client-side as the user types.
 */
export default function SearchableSelect({
  className = "",
  children,
  value,
  onChange,
  disabled = false,
  placeholder,
  id,
  name,
  // eslint-disable-next-line no-unused-vars
  required,
  ...rest
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const rootRef = useRef(null);
  const listRef = useRef(null);

  const options = useMemo(() => parseOptions(children), [children]);

  const selected = useMemo(
    () => options.find((o) => String(o.value) === String(value ?? "")),
    [options, value]
  );
  const isPlaceholderSelected = !selected || String(selected.value) === "";
  const placeholderText =
    placeholder ?? options.find((o) => String(o.value) === "")?.label ?? "اختر…";
  const displayLabel = isPlaceholderSelected ? "" : selected.label;

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return options;
    return options.filter((o) => o.label.toLowerCase().includes(term));
  }, [options, query]);

  useEffect(() => {
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function commit(opt) {
    if (!opt || opt.disabled) return;
    onChange?.({ target: { value: String(opt.value) } });
    setOpen(false);
    setQuery("");
    setHighlight(-1);
  }

  function openList() {
    if (disabled) return;
    setOpen(true);
    setQuery("");
    const idx = filtered.findIndex((o) => String(o.value) === String(value ?? ""));
    setHighlight(idx);
  }

  function onKeyDown(e) {
    if (disabled) return;
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      openList();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min((h < 0 ? -1 : h) + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max((h < 0 ? filtered.length : h) - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlight >= 0 && highlight < filtered.length) commit(filtered[highlight]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  }

  useEffect(() => {
    if (!open || highlight < 0 || !listRef.current) return;
    const el = listRef.current.children[highlight];
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  return (
    <div className={`ui-combobox ${disabled ? "ui-combobox--disabled" : ""}`} ref={rootRef}>
      <input
        {...rest}
        id={id}
        type="text"
        className={`ui-select ui-combobox__input ${className}`}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholderText}
        value={open ? query : displayLabel}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={openList}
        onClick={openList}
        onKeyDown={onKeyDown}
      />
      {name ? <input type="hidden" name={name} value={value ?? ""} /> : null}
      {open && (
        <ul className="ui-combobox__list" ref={listRef}>
          {filtered.length === 0 ? (
            <li className="ui-combobox__empty">لا توجد نتائج</li>
          ) : (
            filtered.map((o, i) => (
              <li
                key={`${o.value}-${i}`}
                className={`ui-combobox__option${i === highlight ? " is-active" : ""}${
                  String(o.value) === String(value ?? "") ? " is-selected" : ""
                }${o.disabled ? " is-disabled" : ""}`}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(o);
                }}
              >
                {o.label || "\u00A0"}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
