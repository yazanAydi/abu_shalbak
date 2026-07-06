/**
 * Quantity input with custom +/- controls that step by whole numbers
 * while preserving any decimal part (e.g. 40.6 + 1 = 41.6).
 */
function roundQty(n) {
  return Math.round(n * 1000) / 1000;
}

function clampQty(value, min, max) {
  let next = roundQty(value);
  if (min != null && Number.isFinite(Number(min))) {
    next = Math.max(next, Number(min));
  }
  if (max != null && Number.isFinite(Number(max))) {
    next = Math.min(next, Number(max));
  }
  return next;
}

function formatQtyValue(n) {
  const rounded = roundQty(n);
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded);
}

export default function QtyStepper({
  value,
  onChange,
  onFocus,
  min,
  max,
  className = "",
  style,
  disabled = false,
  placeholder,
  "aria-label": ariaLabel,
}) {
  const stepBy = (delta) => {
    if (disabled) return;
    const current = Number(value);
    const base = Number.isFinite(current) ? current : 0;
    const next = clampQty(base + delta, min, max);
    onChange?.({ target: { value: formatQtyValue(next) } });
  };

  const handleKeyDown = (e) => {
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
        disabled={disabled}
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
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={onChange}
        onFocus={onFocus}
        onKeyDown={handleKeyDown}
      />
      <button
        type="button"
        className="qty-stepper-btn"
        aria-label="زيادة"
        disabled={disabled}
        tabIndex={-1}
        onClick={() => stepBy(1)}
      >
        +
      </button>
    </div>
  );
}
