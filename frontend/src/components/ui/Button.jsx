import Icon from "../icons/Icon";

export default function Button({
  variant = "primary",
  size,
  block,
  icon,
  iconOnly,
  children,
  className = "",
  type = "button",
  ...rest
}) {
  const onlyIcon = Boolean(iconOnly || (icon && !children));
  if (process.env.NODE_ENV !== "production" && onlyIcon && !rest["aria-label"]) {
    // eslint-disable-next-line no-console
    console.warn("Button icon-only requires aria-label");
  }
  const cls = [
    "ui-btn",
    `ui-btn--${variant}`,
    size ? `ui-btn--${size}` : "",
    block ? "ui-btn--block" : "",
    onlyIcon ? "ui-btn--icon" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} className={cls} {...rest}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}
