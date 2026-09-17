import Icon from "../icons/Icon";

export default function EmptyState({
  icon = "inbox",
  title = "لا توجد بيانات",
  hint,
  action,
  className = "",
}) {
  return (
    <div className={`ui-empty ${className}`.trim()}>
      <div className="ui-empty__icon" aria-hidden>
        <Icon name={icon} size={28} />
      </div>
      <div className="ui-empty__title">{title}</div>
      {hint && <div className="ui-empty__hint">{hint}</div>}
      {action && <div className="ui-mt-md">{action}</div>}
    </div>
  );
}
