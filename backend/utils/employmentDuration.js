/**
 * Elapsed shop-calendar span from an employment start date to a shop today.
 * The result is display-only and is never stored.
 * @param {string|null|undefined} startYmd
 * @param {string} todayYmd
 * @returns {string|null}
 */
export function formatEmploymentDuration(startYmd, todayYmd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startYmd || ""))) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(todayYmd || ""))) return null;
  if (startYmd > todayYmd) return null;

  const [sy, sm, sd] = startYmd.split("-").map(Number);
  const [ty, tm, td] = todayYmd.split("-").map(Number);
  let years = ty - sy;
  let months = tm - sm;
  if (td < sd) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  if (years > 0 && months > 0) return `${years} سنة و ${months} أشهر`;
  if (years > 0) return `${years} سنة`;
  if (months > 0) return `${months} أشهر`;
  const dayCount = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(sy, sm - 1, sd)) / 86400000);
  return `${dayCount} يوم`;
}
