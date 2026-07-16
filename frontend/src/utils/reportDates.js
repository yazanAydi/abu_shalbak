/** Date helpers for sales report presets (YYYY-MM-DD, Ramallah shop calendar). */

import {
  addShopDays,
  shopFirstOfLastMonthYmd,
  shopFirstOfMonthYmd,
  shopLastOfLastMonthYmd,
  shopStartOfWeekYmd,
  shopTodayYmd,
  shopYesterdayYmd,
} from "./shopTime.js";

export function todayYmd() {
  return shopTodayYmd();
}

export function yesterdayYmd() {
  return shopYesterdayYmd();
}

export function firstOfMonthYmd(date = new Date()) {
  return shopFirstOfMonthYmd(date);
}

export function firstOfLastMonthYmd() {
  return shopFirstOfLastMonthYmd();
}

export function lastOfLastMonthYmd() {
  return shopLastOfLastMonthYmd();
}

export function startOfWeekYmd() {
  return shopStartOfWeekYmd();
}

/** @typedef {{ id: string, label: string, mode: 'day' | 'range', date?: string, from?: string, to?: string }} DatePreset */

/** @returns {DatePreset[]} */
export function getDatePresets() {
  const today = todayYmd();
  return [
    { id: "today", label: "اليوم", mode: "day", date: today },
    { id: "yesterday", label: "أمس", mode: "day", date: yesterdayYmd() },
    {
      id: "this-week",
      label: "هذا الأسبوع",
      mode: "range",
      from: startOfWeekYmd(),
      to: today,
    },
    {
      id: "this-month",
      label: "هذا الشهر",
      mode: "range",
      from: firstOfMonthYmd(),
      to: today,
    },
    {
      id: "last-month",
      label: "الشهر الماضي",
      mode: "range",
      from: firstOfLastMonthYmd(),
      to: lastOfLastMonthYmd(),
    },
  ];
}

export function firstOfCurrentMonthYmd() {
  return firstOfMonthYmd();
}

export { addShopDays };
