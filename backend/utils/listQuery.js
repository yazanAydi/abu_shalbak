/**
 * Explicit list pagination. Default matches the historical silent 300-row cap.
 * `limit=all` (or 0) is office-only when a role is provided (admin/accountant),
 * hard-capped at 10000. POS / non-office roles are capped at 500.
 * When role is omitted, keep the 10000 cap so office routes that do not pass
 * role stay compatible.
 */
export function listLimitSql(query, defaultLimit = 300, role = null) {
  const office = role === "admin" || role === "accountant";
  const raw = query?.limit;
  const wantsAll = raw === "all" || raw === "0" || Number(raw) === 0;
  const hardCap = office || role == null ? 10000 : 500;
  const parsed = Number.parseInt(raw, 10);
  const limit = wantsAll
    ? (office || role == null ? hardCap : 500)
    : Math.min(hardCap, Math.max(1, Number.isFinite(parsed) ? parsed : defaultLimit));
  const offset = Math.max(0, Number.parseInt(query?.offset, 10) || 0);
  return { limit, offset, sql: ` LIMIT ${limit} OFFSET ${offset}` };
}
