import { dmyToYmd } from "./format";
import { toLatinDigits } from "./forceLatinDigits";
import { addShopDays, SHOP_TZ, shopTodayYmd } from "./shopTime";

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const hebronPartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: SHOP_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** @param {number} ms */
export function hebronWallParts(ms) {
  if (!Number.isFinite(ms)) return null;
  const parts = hebronPartsFormatter.formatToParts(new Date(ms));
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  let hour = Number(pick("hour"));
  const minute = Number(pick("minute"));
  if (!year || !month || !day || !Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour === 24) hour = 0;
  return { ymd: `${year}-${month}-${day}`, hour, minute };
}

/** Offset of the Hebron wall clock at `ms`, such as "+03" or "+02". */
export function hebronOffsetLabel(ms) {
  const wall = hebronWallParts(ms);
  if (!wall) return "";
  const [y, m, d] = wall.ymd.split("-").map(Number);
  const asUtc = Date.UTC(y, m - 1, d, wall.hour, wall.minute, 0);
  const diffMin = Math.round((asUtc - ms) / 60000);
  const sign = diffMin >= 0 ? "+" : "-";
  const abs = Math.abs(diffMin);
  const hh = pad2(Math.floor(abs / 60));
  const mm = abs % 60;
  return mm === 0 ? `${sign}${hh}` : `${sign}${hh}:${pad2(mm)}`;
}

/**
 * Map an Asia/Hebron wall time to the instants that actually display it.
 * A spring-forward gap has no match. A fall-back hour has two.
 * @returns {{ status: "ok", ms: number } | { status: "missing" } | { status: "ambiguous", options: { ms: number, offset: string }[] }}
 */
export function resolveHebronWall(ymd, hour, minute) {
  if (!YMD_RE.test(String(ymd || "")) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { status: "missing" };
  }
  const [y, m, d] = ymd.split("-").map(Number);
  const start = Date.UTC(y, m - 1, d - 1, 0, 0, 0);
  const end = Date.UTC(y, m - 1, d + 2, 0, 0, 0);
  const matches = [];
  for (let ms = start; ms < end; ms += 60000) {
    const wall = hebronWallParts(ms);
    if (wall && wall.ymd === ymd && wall.hour === hour && wall.minute === minute) {
      matches.push(ms);
    }
  }
  if (matches.length === 0) return { status: "missing" };
  if (matches.length === 1) return { status: "ok", ms: matches[0] };
  return {
    status: "ambiguous",
    options: matches.map((ms) => ({ ms, offset: hebronOffsetLabel(ms) })),
  };
}

/**
 * @param {string} raw
 * @returns {{ empty: true } | { error: string } | { value: string, hour: number, minute: number }}
 */
export function normalizeTimeText(raw) {
  const text = toLatinDigits(String(raw ?? "")).trim().replace(/\s+/g, "");
  if (!text) return { empty: true };
  let hour;
  let minute;
  const colon = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (colon) {
    hour = Number(colon[1]);
    minute = Number(colon[2]);
  } else if (/^\d{4}$/.test(text)) {
    hour = Number(text.slice(0, 2));
    minute = Number(text.slice(2, 4));
  } else if (/^\d{3}$/.test(text)) {
    hour = Number(text.slice(0, 1));
    minute = Number(text.slice(1, 3));
  } else {
    return { error: "صيغة الوقت غير صحيحة. استخدم HH:mm مثل 08:30" };
  }
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) {
    return { error: "الوقت غير صالح. الساعات من 00 إلى 23 والدقائق من 00 إلى 59" };
  }
  return { value: `${pad2(hour)}:${pad2(minute)}`, hour, minute };
}

/**
 * @param {string} raw
 * @returns {{ empty: true } | { error: string } | { iso: string, value: string }}
 */
export function normalizeDateText(raw) {
  const text = toLatinDigits(String(raw ?? "")).trim();
  if (!text) return { empty: true };
  const iso = dmyToYmd(text);
  if (!iso) return { error: "التاريخ غير صالح. استخدم DD/MM/YYYY" };
  const match = YMD_RE.exec(iso);
  return { iso, value: `${match[3]}/${match[2]}/${match[1]}` };
}

export function ymdToDmy4(ymd) {
  const match = YMD_RE.exec(String(ymd || "").trim());
  if (!match) return "";
  return `${match[3]}/${match[2]}/${match[1]}`;
}

/** Current Asia/Hebron date (YYYY-MM-DD) and time (HH:mm). */
export function hebronNowParts(date = new Date()) {
  const wall = hebronWallParts(date.getTime());
  if (!wall) return { ymd: shopTodayYmd(), time: "" };
  return { ymd: wall.ymd, time: `${pad2(wall.hour)}:${pad2(wall.minute)}` };
}

export function hebronYesterdayYmd(date = new Date()) {
  return addShopDays(hebronNowParts(date).ymd, -1) || "";
}

/**
 * Stored UTC timestamp → Hebron wall fields, keeping the exact instant when the hour is ambiguous.
 * @param {string|null|undefined} sql
 */
export function fieldsFromStoredInstant(sql) {
  if (!sql) return null;
  const str = String(sql).trim();
  const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(str);
  const ms = Date.parse(naive ? `${str.replace(" ", "T")}Z` : str);
  if (!Number.isFinite(ms)) return null;
  const wall = hebronWallParts(ms);
  if (!wall) return null;
  const resolved = resolveHebronWall(wall.ymd, wall.hour, wall.minute);
  const pinMs = resolved.status === "ambiguous" ? ms : null;
  return {
    ymd: wall.ymd,
    time: `${pad2(wall.hour)}:${pad2(wall.minute)}`,
    pinMs,
    ms,
  };
}

/**
 * @param {{ ymd?: string, time?: string, pinMs?: number|null }} input
 * @returns {{ empty: true } | { error: string, ambiguous?: { ms: number, offset: string }[], displayTime?: string } | { ms: number, sql: string, displayTime: string, ymd: string }}
 */
export function attendanceInstantFromFields({ ymd, time, pinMs = null }) {
  const date = normalizeDateText(ymdToDmy4(ymd));
  if (date.empty) return { empty: true };
  if (date.error || date.iso !== ymd) return { error: date.error || "التاريخ غير صالح" };
  const clock = normalizeTimeText(time);
  if (clock.empty) return { empty: true };
  if (clock.error) return { error: clock.error };
  const resolved = resolveHebronWall(date.iso, clock.hour, clock.minute);
  if (resolved.status === "missing") {
    return { error: "هذا الوقت غير موجود في الخليل بسبب التوقيت الصيفي. اختر وقتاً موجوداً." };
  }
  if (resolved.status === "ambiguous") {
    const chosen = resolved.options.find((option) => option.ms === pinMs);
    if (!chosen) {
      return {
        error: "هذا الوقت يتكرر عند تغيير التوقيت. اختر التوقيت الصيفي أو الشتوي.",
        ambiguous: resolved.options,
        displayTime: clock.value,
      };
    }
    return {
      ms: chosen.ms,
      sql: new Date(chosen.ms).toISOString(),
      displayTime: clock.value,
      ymd: date.iso,
    };
  }
  return {
    ms: resolved.ms,
    sql: `${date.iso} ${clock.value}:00`,
    displayTime: clock.value,
    ymd: date.iso,
  };
}

export function attendanceDurationHours(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return Math.round(((endMs - startMs) / 3600000) * 100) / 100;
}
