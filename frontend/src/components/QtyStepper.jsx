/**
 * Quantity number field. Values change by typing only.
 */
import { focusNextField, shouldHandleEnterOnField } from "../utils/focusNavigation";

export default function QtyStepper({
  value,
  onChange,
  onFocus,
  min,
  max,
  step = "any",
  className = "",
  style,
  disabled = false,
  placeholder,
  "aria-label": ariaLabel,
}) {
  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.defaultPrevented && shouldHandleEnterOnField(e.target)) {
      e.preventDefault();
      focusNextField(e.target);
    }
  };

  return (
    <input
      type="number"
      step={step}
      min={min}
      max={max}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className={className || "ui-input"}
      style={style}
      onChange={onChange}
      onFocus={onFocus}
      onKeyDown={handleKeyDown}
    />
  );
}
