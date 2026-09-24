import { useEffect, useRef, useState } from "react";
import { normalizeTimeText } from "../../utils/attendanceDateTime";

function emit(onChange, value, name) {
  onChange?.({ target: { value, name: name || undefined } });
}

export default function TimeField({
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
  invalid,
  syncToken = 0,
  ...rest
}) {
  const [text, setText] = useState(value || "");
  const focused = useRef(false);

  useEffect(() => {
    if (focused.current) return;
    setText(value || "");
  }, [value, syncToken]);

  function commit(next) {
    const normalized = normalizeTimeText(next);
    if (normalized.empty) {
      setText("");
      emit(onChange, "", name);
      return;
    }
    if (normalized.error) {
      setText(next);
      emit(onChange, next, name);
      return;
    }
    setText(normalized.value);
    emit(onChange, normalized.value, name);
  }

  return (
    <div className="ui-time" style={style}>
      <input
        {...rest}
        id={id}
        name={name}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="HH:mm"
        dir="ltr"
        className={`ui-input ui-time__input ${invalid ? "is-invalid" : ""} ${className}`.trim()}
        value={text}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
        aria-invalid={invalid || undefined}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          emit(onChange, next, name);
        }}
        onBlur={(e) => {
          commit(e.currentTarget.value);
          focused.current = false;
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.isComposing) commit(e.currentTarget.value);
          onKeyDown?.(e);
        }}
      />
    </div>
  );
}
