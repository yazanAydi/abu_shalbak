import { Children, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { focusNextField } from "../../utils/focusNavigation";

const LIST_MAX_HEIGHT = 240;

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
      width: rect.width,
      top: openUp ? rect.top - maxHeight - gap : rect.bottom + gap,
      maxHeight,
      zIndex: 2000,
    });
  }, []);

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
      const t = e.target;
      if (rootRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
      setQuery("");
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    placeMenu();
    const onReposition = () => placeMenu();
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, filtered.length, placeMenu]);

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
    placeMenu();
  }

  function onKeyDown(e) {
    if (disabled) return;
    if (!open && e.key === "ArrowDown") {
      openList();
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min((h < 0 ? -1 : h) + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max((h < 0 ? filtered.length : h) - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (highlight >= 0 && highlight < filtered.length) {
        commit(filtered[highlight]);
        requestAnimationFrame(() => focusNextField(e.target));
      }
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
      {open &&
        menuStyle &&
        createPortal(
          <ul
            className="ui-combobox__list"
            ref={listRef}
            style={menuStyle}
            onWheel={(e) => e.stopPropagation()}
          >
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
          </ul>,
          document.body
        )}
    </div>
  );
}
