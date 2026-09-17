export default function HelpPanel({ title = "طريقة الحساب", children, className = "" }) {
  return (
    <details className={`ui-help-panel ${className}`.trim()}>
      <summary>{title}</summary>
      <div className="ui-help-panel__body">{children}</div>
    </details>
  );
}
