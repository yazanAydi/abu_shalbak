/**
 * Quantity / amount number field. Values change by typing only.
 */
import { handleEnterNavKeyDown } from "../utils/focusNavigation";

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
  readOnly = false,
  title,
  autoFocus = false,
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
      className={className}
      style={style}
      onChange={onChange}
      onFocus={onFocus}
      onKeyDown={handleKeyDown}
      {...rest}
    />
  );
}
