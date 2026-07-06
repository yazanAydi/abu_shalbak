/**
 * Number input with custom +/- controls that step by whole numbers
 * while preserving any decimal part (e.g. 40.6 + 1 = 41.6, 0.09 + 1 = 1.09).
 */
function makeRound(precision) {
  const factor = 10 ** precision;
  return (n) => Math.round(n * factor) / factor;
}

function makeFormat(round) {
  return (n) => {
    const rounded = round(n);
    if (Number.isInteger(rounded)) return String(rounded);
    return String(rounded);
  };
}

function makeClamp(round) {
  return (value, min, max) => {
    let next = round(value);
    if (min != null && Number.isFinite(Number(min))) {
      next = Math.max(next, Number(min));
    }
    if (max != null && Number.isFinite(Number(max))) {
      next = Math.min(next, Number(max));
    }
    return next;
  };
}

export default function QtyStepper({
  value,
  onChange,
  onFocus,
  min,
  max,
  precision = 3,
  className = "",
  style,
  disabled = false,
  placeholder,
  readOnly = false,
  title,
  autoFocus = false,
  "aria-label": ariaLabel,
}) {
  const round = makeRound(precision);
  const formatValue = makeFormat(round);
  const clamp = makeClamp(round);

  const stepBy = (delta) => {
    if (disabled || readOnly) return;
    const current = Number(value);
    const base = Number.isFinite(current) ? current : 0;
    const next = clamp(base + delta, min, max);
    onChange?.({ target: { value: formatValue(next) } });
  };

  const handleKeyDown = (e) => {
    if (readOnly) return;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      stepBy(1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      stepBy(-1);
    }
  };

  return (
    <div className={`qty-stepper ${className}`.trim()} style={style}>
      <button
        type="button"
        className="qty-stepper-btn"
        aria-label="نقص"
        disabled={disabled || readOnly}
        tabIndex={-1}
        onClick={() => stepBy(-1)}
      >
        −
      </button>
      <input
        type="number"
        step="any"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        readOnly={readOnly}
        placeholder={placeholder}
        title={title}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        onChange={onChange}
        onFocus={onFocus}
        onKeyDown={handleKeyDown}
      />
      <button
        type="button"
        className="qty-stepper-btn"
        aria-label="زيادة"
        disabled={disabled || readOnly}
        tabIndex={-1}
        onClick={() => stepBy(1)}
      >
        +
      </button>
    </div>
  );
}
