import Icon from "../icons/Icon";

const TONE_ICON = {
  info: "help",
  success: "check",
  warn: "alert",
  danger: "alert",
};

export default function Notice({
  tone = "info",
  children,
  details,
  detailsLabel = "تفاصيل تقنية",
  className = "",
}) {
  const role = tone === "danger" ? "alert" : "status";
  return (
    <div className={`ui-notice ui-notice--${tone} ${className}`.trim()} role={role}>
      <div className="ui-notice__icon" aria-hidden>
        <Icon name={TONE_ICON[tone] || "alert"} size={18} />
      </div>
      <div className="ui-notice__body">
        <div>{children}</div>
        {details ? (
          <details className="ui-notice__details">
            <summary>{detailsLabel}</summary>
            <pre style={{ whiteSpace: "pre-wrap", margin: "0.35rem 0 0", fontSize: "0.78rem" }}>
              {details}
            </pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}
