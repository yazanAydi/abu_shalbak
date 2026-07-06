export default function StatusPill({ tone = "neutral", children, noDot }) {
  return (
    <span className={`ui-pill ui-pill--${tone} ${noDot ? "ui-pill--no-dot" : ""}`}>
      {children}
    </span>
  );
}
