/** Shared display formatting helpers (currency, numbers, dates). */

export function ils(n) {
  const v = Number(n ?? 0);
  return `₪${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function num(n, digits = 2) {
  return Number(n ?? 0).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function qty(n) {
  const v = Number(n ?? 0);
  return Number.isInteger(v) ? String(v) : v.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

/** YYYY-MM-DD HH:MM from an ISO-ish string */
export function dateTime(s) {
  if (!s) return "—";
  return String(s).replace("T", " ").slice(0, 16);
}

export function dateOnly(s) {
  if (!s) return "—";
  return String(s).slice(0, 10);
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
