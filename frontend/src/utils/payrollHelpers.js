import { formatDateTimeShopAr } from "./format.js";

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

export const SHIFT_FLAG_LABELS = {
  missing_snapshot: "أجر الساعة غير محفوظ لهذه الوردية",
  open: "وردية مفتوحة",
  pending_count: "وردية بانتظار العد",
  long_shift: "وردية طويلة جداً — راجع الساعات",
  overlapping: "تداخل مع وردية أخرى",
};

export const INCOMPLETE_REASON_LABELS = {
  missing_snapshot: "أجر الساعة غير محفوظ لهذه الوردية",
  open_shift: "وردية مفتوحة",
  pending_count: "وردية بانتظار العد",
  long_shift: "وردية طويلة جداً — راجع الساعات",
  overlapping: "تداخل مع وردية أخرى",
};

export function formatShiftStatus(status) {
  return SHIFT_STATUS_LABELS[status] || status || "—";
}

export function formatShiftFlag(flag) {
  return SHIFT_FLAG_LABELS[flag] || flag || "";
}

export function formatShiftFlags(flags, labels) {
  if (labels?.length) return labels.join("؛ ");
  if (!flags?.length) return "";
  return flags.map(formatShiftFlag).join("؛ ");
}

export function formatIncompleteReasons(reasons, labels) {
  if (labels?.length) return labels.join("، ");
  if (!reasons?.length) return "";
  return reasons.map((reason) => INCOMPLETE_REASON_LABELS[reason] || reason).join("، ");
}

export function recordedHoursOf(preview) {
  if (preview?.recorded_hours != null && preview.recorded_hours !== "") {
    return Number(preview.recorded_hours);
  }
  return (preview?.shifts || []).reduce((sum, shift) => sum + Number(shift.hours || 0), 0);
}

export function eligibleHoursOf(preview) {
  if (preview?.eligible_hours != null && preview.eligible_hours !== "") {
    return Number(preview.eligible_hours);
  }
  return Number(preview?.posted_hours || 0);
}

export function isPreviewPayIncomplete(preview) {
  if (!preview) return false;
  if (preview.preview_pay_incomplete === true) return true;
  return Number(preview.missing_snapshot_count || 0) > 0;
}

export function formatDateTimeAr(iso) {
  return formatDateTimeShopAr(iso);
}
