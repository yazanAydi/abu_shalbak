import Icon from "../icons/Icon";

export default function Button({
  variant = "primary",
  size,
  block,
  icon,
  children,
  className = "",
  ...rest
}) {
  const cls = [
    "ui-btn",
    `ui-btn--${variant}`,
    size ? `ui-btn--${size}` : "",
    block ? "ui-btn--block" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={cls} {...rest}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}
