import SearchableSelect from "./SearchableSelect";
import DateField from "./DateField";
import { handleEnterNavKeyDown } from "../../utils/focusNavigation";

export function FormField({ label, required, hint, children, className = "" }) {
  return (
    <div className={`ui-field ${className}`}>
      {label && (
        <label className="ui-field__label">
          {label}
          {required && <span className="ui-field__req">*</span>}
        </label>
      )}
      {children}
      {hint && <span className="ui-field__hint">{hint}</span>}
    </div>
  );
}

export function Input({ className = "", onKeyDown, type, ...rest }) {
  function handleKeyDown(e) {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    handleEnterNavKeyDown(e);
  }

  if (type === "date") {
    return (
      <DateField className={`ui-input ${className}`} onKeyDown={handleKeyDown} {...rest} />
    );
  }

  if (type === "checkbox") {
    return (
      <input className={`ui-check ${className}`.trim()} type="checkbox" {...rest} />
    );
  }

  return (
    <input className={`ui-input ${className}`} type={type} {...rest} onKeyDown={handleKeyDown} />
  );
}

export function Select(props) {
  return <SearchableSelect {...props} />;
}

export function Textarea({ className = "", ...rest }) {
  return <textarea className={`ui-textarea ${className}`} {...rest} />;
}

export function FormGrid({ children, className = "" }) {
  return (
    <div
      className={`ui-form-grid ${className}`}
      data-enter-nav=""
      onKeyDown={handleEnterNavKeyDown}
    >
      {children}
    </div>
  );
}
