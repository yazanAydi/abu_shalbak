import Button from "./Button";

export default function FilterBar({
  children,
  actions,
  className = "",
  onReset,
  resetLabel = "إعادة تعيين",
  sticky,
}) {
  return (
    <div className={`ui-toolbar ui-filter-bar ${sticky ? "ui-filter-bar--sticky" : ""} ${className}`.trim()}>
      <div className="ui-filter-bar__fields">{children}</div>
      <div className="ui-filter-bar__actions">
        {actions}
        {onReset ? (
          <Button type="button" variant="secondary" size="sm" onClick={onReset}>
            {resetLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
