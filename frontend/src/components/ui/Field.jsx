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

export function Input({ className = "", ...rest }) {
  return <input className={`ui-input ${className}`} {...rest} />;
}

export function Select({ className = "", children, ...rest }) {
  return (
    <select className={`ui-select ${className}`} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({ className = "", ...rest }) {
  return <textarea className={`ui-textarea ${className}`} {...rest} />;
}

export function FormGrid({ children, className = "" }) {
  return <div className={`ui-form-grid ${className}`}>{children}</div>;
}
