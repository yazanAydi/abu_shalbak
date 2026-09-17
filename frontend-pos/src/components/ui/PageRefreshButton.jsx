import Button from "./Button";

export default function PageRefreshButton({
  onClick,
  refreshing = false,
  disabled = false,
  className = "",
  ...rest
}) {
  const cls = [refreshing ? "ui-btn--spin-icon" : "", className].filter(Boolean).join(" ");
  return (
    <Button
      type="button"
      variant="secondary"
      icon="refresh"
      onClick={onClick}
      disabled={disabled || refreshing}
      aria-label="تحديث"
      aria-busy={refreshing || undefined}
      className={cls}
      {...rest}
    >
      {refreshing ? "جاري التحديث…" : "تحديث"}
    </Button>
  );
}
