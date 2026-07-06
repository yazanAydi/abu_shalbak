import Icon from "../icons/Icon";

export default function StatCard({
  label,
  value,
  icon,
  tone = "teal",
  alert,
  className = "",
}) {
  const iconTone =
    tone === "green"
      ? "green"
      : tone === "orange"
        ? "orange"
        : tone === "red"
          ? "red"
          : "teal";

  return (
    <div
      className={`ui-stat ${alert ? "ui-stat--alert" : ""} ${className}`.trim()}
    >
      {icon ? (
        <div className={`ui-stat__icon ui-stat__icon--${iconTone}`} aria-hidden>
          {typeof icon === "string" ? <Icon name={icon} /> : icon}
        </div>
      ) : null}
      <div>
        {label ? <div className="ui-stat__label">{label}</div> : null}
        <div className="ui-stat__value">{value}</div>
      </div>
    </div>
  );
}
