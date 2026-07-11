/** Date helpers for sales report presets (YYYY-MM-DD). */

export function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

export function yesterdayYmd() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function firstOfMonthYmd(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
}

export function firstOfLastMonthYmd() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return firstOfMonthYmd(d);
}

export function lastOfLastMonthYmd() {
  const d = new Date();
  d.setDate(0);
  return d.toISOString().slice(0, 10);
}

export function startOfWeekYmd() {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d.toISOString().slice(0, 10);
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
