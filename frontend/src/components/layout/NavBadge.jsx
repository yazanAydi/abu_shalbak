/** Pill notification counter for office navbar links. */
export default function NavBadge({ count }) {
  const n = Number(count) || 0;
  if (n <= 0) return null;

  const label = n > 99 ? "99+" : String(n);

  return (
    <span className="office-nav-badge" aria-label={`${n} تنبيه${n === 1 ? "" : "ات"}`}>
      {label}
    </span>
  );
}
