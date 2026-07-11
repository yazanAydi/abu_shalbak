/** Format decimal hours as Arabic hours/minutes (e.g. 8س 15د). */
export function formatHoursAr(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) return "0";
  const h = Math.floor(n);
  const m = Math.round((n - h) * 60);
  const parts = [];
  if (h > 0) parts.push(`${h}س`);
  if (m > 0) parts.push(`${m}د`);
  return parts.length ? parts.join(" ") : "0";
}

export const SHIFT_STATUS_LABELS = {
  open: "مفتوحة",
  pending_count: "بانتظار العد",
  closed: "مغلقة",
};

export function formatShiftStatus(status) {
  return SHIFT_STATUS_LABELS[status] || status || "—";
}

export function formatDateTimeAr(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("ar-EG", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
