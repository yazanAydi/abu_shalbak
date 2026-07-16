/**
 * Shop calendar helpers — Ramallah / Palestine local time (Asia/Hebron).
 */

export const SHOP_TZ = process.env.REACT_APP_SHOP_TZ || "Asia/Hebron";
export const SHOP_TZ_LABEL = "Ramallah";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const ymdFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SHOP_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function parseYmd(ymd) {
  if (typeof ymd !== "string" || !YMD_RE.test(ymd.trim())) return null;
  return ymd.trim();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * @param {Date|number} [date=new Date()]
 * @returns {string}
 */
export function shopYmdFromDate(date = new Date()) {
  const ms = date instanceof Date ? date.getTime() : Number(date);
  if (Number.isNaN(ms)) return "";
  return ymdFormatter.format(new Date(ms));
}

export function shopTodayYmd() {
  return shopYmdFromDate(new Date());
}

/**
 * @param {string} ymd
 * @param {number} delta
 * @returns {string|null}
 */
export function addShopDays(ymd, delta) {
  const base = parseYmd(ymd);
  if (!base || !Number.isFinite(delta)) return null;
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta, 12, 0, 0));
  return shopYmdFromDate(dt);
}

export function shopYesterdayYmd() {
  return addShopDays(shopTodayYmd(), -1) || "";
}

export function shopFirstOfMonthYmd(date = new Date()) {
  const today = shopYmdFromDate(date);
  return `${today.slice(0, 8)}01`;
}

export function shopFirstOfLastMonthYmd() {
  const today = shopTodayYmd();
  const [y, m] = today.split("-").map(Number);
  const prev = m === 1 ? [y - 1, 12] : [y, m - 1];
  return `${prev[0]}-${pad2(prev[1])}-01`;
}

export function shopLastOfLastMonthYmd() {
  const firstThis = shopFirstOfMonthYmd();
  return addShopDays(firstThis, -1) || "";
}

export function shopStartOfWeekYmd() {
  const today = shopTodayYmd();
  const [y, m, d] = today.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: SHOP_TZ,
    weekday: "short",
  }).format(noon);
  const map = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const diff = map[weekday] ?? 0;
  return addShopDays(today, -diff) || today;
}
