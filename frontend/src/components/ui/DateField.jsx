import { useEffect, useState } from "react";
import { dmyToYmd, ymdToDmy } from "../../utils/format";

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function toIso(value) {
  const str = String(value || "").trim();
  return ISO_RE.test(str) ? str : "";
}

function emitChange(onChange, iso, name) {
  onChange?.({ target: { value: iso, name: name || undefined } });
}

export default function DateField({
  value = "",
  onChange,
  onKeyDown,
  className = "",
  disabled,
  readOnly,
  style,
  name,
  id,
  required,
  ...rest
}) {
  const isoValue = toIso(value);
  const [text, setText] = useState(() => (isoValue ? ymdToDmy(isoValue) : ""));

  useEffect(() => {
    setText(isoValue ? ymdToDmy(isoValue) : "");
  }, [isoValue]);

  function handleTextChange(e) {
    const next = e.target.value;
    setText(next);
    if (!next.trim()) {
      emitChange(onChange, "", name);
      return;
    }
    const iso = dmyToYmd(next);
    if (iso) emitChange(onChange, iso, name);
  }

  function handleBlur() {
    if (!text.trim()) {
      setText("");
      return;
    }
    const iso = dmyToYmd(text);
    if (iso) setText(ymdToDmy(iso));
    else setText(isoValue ? ymdToDmy(isoValue) : "");
  }

  function handlePickerChange(e) {
    const iso = e.target.value;
    emitChange(onChange, iso, name);
    setText(iso ? ymdToDmy(iso) : "");
  }

  return (
    <div className="ui-date" style={style}>
      <input
        {...rest}
        id={id}
        name={name}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="DD/MM/YY"
        className={className}
        value={text}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
        onChange={handleTextChange}
        onBlur={handleBlur}
        onKeyDown={onKeyDown}
      />
      <span className="ui-date__cal" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
      </span>
      <input
        type="date"
        className="ui-date__picker"
        value={isoValue}
        disabled={disabled || readOnly}
        tabIndex={-1}
        aria-hidden="true"
        onChange={handlePickerChange}
      />
    </div>
  );
}
