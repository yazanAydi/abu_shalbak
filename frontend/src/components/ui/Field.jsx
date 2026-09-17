import { Children, cloneElement, isValidElement, useId } from "react";
import SearchableSelect from "./SearchableSelect";
import DateField from "./DateField";
import { handleEnterNavKeyDown } from "../../utils/focusNavigation";

function bindControl(child, { id, describedBy, invalid }) {
  if (!isValidElement(child)) return child;
  const next = { ...child.props };
  if (id && !child.props.id) next.id = id;
  if (describedBy) {
    next["aria-describedby"] = [child.props["aria-describedby"], describedBy].filter(Boolean).join(" ");
  }
  if (invalid) {
    next["aria-invalid"] = true;
    next.invalid = child.props.invalid ?? true;
  }
  return cloneElement(child, next);
}

export function FormField({
  label,
  required,
  optional,
  hint,
  error,
  htmlFor,
  children,
  className = "",
}) {
  const autoId = useId();
  const fieldId = htmlFor || autoId;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const kids = Children.toArray(children);
  const bound =
    kids.length === 1
      ? bindControl(kids[0], { id: fieldId, describedBy, invalid: Boolean(error) })
      : children;

  return (
    <div className={`ui-field ${className}`}>
      {label && (
        <label className="ui-field__label" htmlFor={fieldId}>
          {label}
          {required ? (
            <span className="ui-field__req">
              *<span className="ui-sr-only"> مطلوب</span>
            </span>
          ) : null}
          {optional ? <span className="ui-field__opt">اختياري</span> : null}
        </label>
      )}
      {bound}
      {hint ? (
        <span id={hintId} className="ui-field__hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className="ui-field__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function Input({ className = "", onKeyDown, type, invalid, ...rest }) {
  function handleKeyDown(e) {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    handleEnterNavKeyDown(e);
  }

  if (type === "date") {
    return (
      <DateField
        className={`ui-input ${invalid ? "is-invalid" : ""} ${className}`.trim()}
        onKeyDown={handleKeyDown}
        aria-invalid={invalid || undefined}
        {...rest}
      />
    );
  }

  if (type === "checkbox") {
    return (
      <input className={`ui-check ${className}`.trim()} type="checkbox" {...rest} />
    );
  }

  return (
    <input
      className={`ui-input ${invalid ? "is-invalid" : ""} ${className}`.trim()}
      type={type}
      aria-invalid={invalid || undefined}
      {...rest}
      onKeyDown={handleKeyDown}
    />
  );
}

export function Select(props) {
  return <SearchableSelect {...props} />;
}

export function Textarea({ className = "", invalid, ...rest }) {
  return (
    <textarea
      className={`ui-textarea ${invalid ? "is-invalid" : ""} ${className}`.trim()}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
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
