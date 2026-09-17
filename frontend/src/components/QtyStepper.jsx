/**
 * Quantity number field. Values change by typing only.
 */
import { handleEnterNavKeyDown } from "../utils/focusNavigation";

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
  onKeyDown,
  ...rest
}) {
  const handleKeyDown = (e) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    handleEnterNavKeyDown(e);
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
      {...rest}
    />
  );
}
