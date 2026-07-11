import SearchableSelect from "./SearchableSelect";
import {
  focusNextField,
  handleEnterNavKeyDown,
  shouldHandleEnterOnField,
} from "../../utils/focusNavigation";

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

export function Input({ className = "", onKeyDown, ...rest }) {
  function handleKeyDown(e) {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === "Enter" && shouldHandleEnterOnField(e.target)) {
      e.preventDefault();
      focusNextField(e.target);
    }
  }

  return (
    <input className={`ui-input ${className}`} {...rest} onKeyDown={handleKeyDown} />
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
