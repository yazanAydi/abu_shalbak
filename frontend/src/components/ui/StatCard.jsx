import Icon from "../icons/Icon";
import HelpTip from "./HelpTip";
import StatusPill from "./StatusPill";

export default function StatCard({
  label,
  value,
  hint,
  icon,
  tone = "teal",
  alert,
  help,
  status,
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
      <div className="ui-stat__body">
        {label ? (
          <div className="ui-stat__label-row">
            <div className="ui-stat__label">{label}</div>
            {help ? <HelpTip>{help}</HelpTip> : null}
          </div>
        ) : null}
        <div className="ui-stat__value">{value}</div>
        {hint ? <div className="ui-stat__hint">{hint}</div> : null}
        {status ? (
          <div className="ui-stat__status">
            <StatusPill tone={status.tone || (alert ? "orange" : "neutral")} noDot={false}>
              {status.icon ? <Icon name={status.icon} size={12} /> : null}
              {status.label}
            </StatusPill>
          </div>
        ) : null}
      </div>
    </div>
  );
}
