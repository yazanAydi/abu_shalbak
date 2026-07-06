/**
 * Standard filter toolbar — date/status fields + optional action buttons.
 */
export default function FilterBar({ children, actions, className = "" }) {
  return (
    <div className={`ui-toolbar ui-filter-bar ${className}`.trim()}>
      <div className="ui-filter-bar__fields">{children}</div>
      {actions ? <div className="ui-filter-bar__actions">{actions}</div> : null}
    </div>
  );
}
