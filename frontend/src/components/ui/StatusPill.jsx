import Icon from "../icons/Icon";

export default function StatusPill({ tone = "neutral", children, noDot, icon }) {
  return (
    <span className={`ui-pill ui-pill--${tone} ${noDot ? "ui-pill--no-dot" : ""}`}>
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}
