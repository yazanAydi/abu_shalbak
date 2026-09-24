import { useEffect, useRef, useState } from "react";
import { dmyToYmd, ymdToDmy } from "../../utils/format";
import { toLatinDigits } from "../../utils/forceLatinDigits";

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FULL_YEAR_RE = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/;

function toIso(value) {
  const str = String(value || "").trim();
  return ISO_RE.test(str) ? str : "";
}

function displayIso(iso, yearDigits) {
  if (!iso) return "";
  if (yearDigits === 4) {
    const match = ISO_RE.exec(iso);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : "";
  }
  return ymdToDmy(iso);
}

function parseTyped(text, yearDigits) {
  const str = toLatinDigits(String(text || "").trim());
  if (!str) return "";
  if (yearDigits === 4 && !FULL_YEAR_RE.test(str)) return "";
  return dmyToYmd(str);
}

function emitChange(onChange, iso, name) {
  onChange?.({ target: { value: iso, name: name || undefined } });
}

export default function DateField({
  value = "",
  onChange,
  onKeyDown,
  onBlur,
  className = "",
  disabled,
  readOnly,
  style,
  name,
  id,
  required,
  yearDigits = 2,
  keepInvalid = false,
  syncToken = 0,
  invalid,
  onInvalid,
  ...rest
}) {
  const isoValue = toIso(value);
  const [text, setText] = useState(() => displayIso(isoValue, yearDigits));
  const focused = useRef(false);

  useEffect(() => {
    if (focused.current) return;
    setText(displayIso(isoValue, yearDigits));
  }, [isoValue, yearDigits, syncToken]);

  function handleTextChange(e) {
    const next = e.target.value;
    setText(next);
    if (!next.trim()) {
      emitChange(onChange, "", name);
      return;
    }
    const iso = parseTyped(next, yearDigits);
    if (iso) emitChange(onChange, iso, name);
  }

  function handleBlur(e) {
    const next = e?.currentTarget?.value ?? text;
    if (!String(next).trim()) {
      setText("");
      emitChange(onChange, "", name);
      focused.current = false;
      onBlur?.(e);
      return;
    }
    const iso = dmyToYmd(toLatinDigits(String(next).trim()));
    if (iso) {
      setText(displayIso(iso, yearDigits));
      emitChange(onChange, iso, name);
    } else if (keepInvalid) {
      setText(next);
      onInvalid?.(next);
    } else {
      setText(displayIso(isoValue, yearDigits));
    }
    focused.current = false;
    onBlur?.(e);
  }

  function handlePickerChange(e) {
    const iso = e.target.value;
    emitChange(onChange, iso, name);
    setText(displayIso(iso, yearDigits));
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
        placeholder={yearDigits === 4 ? "DD/MM/YYYY" : "DD/MM/YY"}
        dir="ltr"
        className={className}
        value={text}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
        aria-invalid={invalid || undefined}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={handleTextChange}
        onBlur={handleBlur}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.isComposing) handleBlur(e);
          onKeyDown?.(e);
        }}
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
        data-enter-nav-skip=""
        onChange={handlePickerChange}
      />
    </div>
  );
}
