import { formatDateTimeShopAr, round2 } from "./format.js";

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

function shiftIsOpen(shift) {
  return !shift?.end_time || shift.status === "open" || (shift.flags || []).includes("open");
}

function rateForShift(shift, liveHourlyRate) {
  const snap = Number(shift?.hourly_rate);
  if (Number.isFinite(snap) && snap > 0) return snap;
  const live = Number(liveHourlyRate);
  if (Number.isFinite(live) && live > 0) return live;
  return null;
}

/** Hours that can be multiplied by a rate (ended shifts only). */
export function payableHoursOf(hours, liveHourlyRate) {
  const live = liveHourlyRate ?? hours?.live_hourly_rate;
  let total = 0;
  for (const shift of hours?.shifts || []) {
    if (shiftIsOpen(shift)) continue;
    const h = Number(shift.hours);
    if (!Number.isFinite(h) || h <= 0) continue;
    if (rateForShift(shift, live) == null) continue;
    total += h;
  }
  return round2(total);
}

function shiftPayAmount(shift, liveHourlyRate) {
  if (shiftIsOpen(shift)) return 0;
  const h = Number(shift.hours);
  const rate = rateForShift(shift, liveHourlyRate);
  if (!Number.isFinite(h) || h <= 0 || rate == null) return 0;
  return round2(rate * h);
}

/**
 * Preview wage: ended shifts × snapshot (or live rate if the shift has no snapshot).
 * Open shifts stay out. This is a display/prefill number — payout remains manual.
 */
export function estimatedCashierPay(hours, liveHourlyRate) {
  const live = liveHourlyRate ?? hours?.live_hourly_rate;
  const shifts = hours?.shifts || [];
  if (!shifts.length) {
    const posted = Number(hours?.posted_pay);
    return Number.isFinite(posted) && posted > 0 ? round2(posted) : null;
  }
  let total = 0;
  let any = false;
  for (const shift of shifts) {
    const pay = shiftPayAmount(shift, live);
    if (pay > 0) {
      total = round2(total + pay);
      any = true;
    }
  }
  if (any) return total;
  const posted = Number(hours?.posted_pay);
  return Number.isFinite(posted) && posted > 0 ? round2(posted) : null;
}

export function estimatedShiftPay(shift, liveHourlyRate) {
  return shiftPayAmount(shift, liveHourlyRate);
}

export function formatDateTimeAr(iso) {
  return formatDateTimeShopAr(iso);
}
