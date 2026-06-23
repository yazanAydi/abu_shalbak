import Icon from "../icons/Icon";

export default function EmptyState({ icon = "inbox", title = "لا توجد بيانات", hint, action }) {
  return (
    <div className="ui-empty">
      <div className="ui-empty__icon" aria-hidden>
        <Icon name={icon} size={28} />
      </div>
      <div className="ui-empty__title">{title}</div>
      {hint && <div className="ui-empty__hint">{hint}</div>}
      {action && <div style={{ marginTop: "1rem" }}>{action}</div>}
    </div>
  );
}
