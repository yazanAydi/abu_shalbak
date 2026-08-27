/**
 * Explicit list pagination. Default matches the historical silent 300-row cap.
 * Pass limit=all (or limit=0) to return the full set, hard-capped at 10000.
 */
export function listLimitSql(query, defaultLimit = 300) {
  const raw = query?.limit;
  const unlimited = raw === "all" || raw === "0" || Number(raw) === 0;
  const limit = unlimited
    ? 10000
    : Math.min(10000, Math.max(1, Number.parseInt(raw, 10) || defaultLimit));
  const offset = Math.max(0, Number.parseInt(query?.offset, 10) || 0);
  return { limit, offset, sql: ` LIMIT ${limit} OFFSET ${offset}` };
}
