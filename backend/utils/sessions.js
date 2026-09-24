import { getCachedUserRow } from "./accountantPermissions.js";
import { CACHE_KEYS, cacheInvalidate } from "./cache.js";

const SESSION_MESSAGE = "انتهت الجلسة. سجّل الدخول من جديد";

let lastPurgeAt = 0;

export function sessionRevokedError() {
  const err = new Error(SESSION_MESSAGE);
  err.status = 401;
  err.code = "SESSION_REVOKED";
  return err;
}

/**
 * Drop expired logout records so the table does not grow without bound.
 * @param {object} db
 * @param {{ force?: boolean }} [opts]
 */
export async function purgeExpiredRevocations(db, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastPurgeAt < 60_000) return;
  lastPurgeAt = now;
  await db.run("DELETE FROM revoked_tokens WHERE expires_at <= ?", [now]);
}

/**
 * Reject missing users, legacy tokens, version mismatches, and logged-out jti values.
 * There is no user-disable column; deletion removes the row and fails this check.
 * @param {object} db
 * @param {{ id?: number, sv?: number, jti?: string }} payload
 */
export async function assertTokenSession(db, payload) {
  if (payload?.sv == null || payload?.jti == null || String(payload.jti) === "") {
    throw sessionRevokedError();
  }
  await purgeExpiredRevocations(db);
  const row = await getCachedUserRow(db, payload.id);
  if (!row) throw sessionRevokedError();
  if (Number(row.session_version) !== Number(payload.sv)) throw sessionRevokedError();
  const revoked = await db.get(
    "SELECT jti FROM revoked_tokens WHERE jti = ? AND expires_at > ?",
    [String(payload.jti), Date.now()]
  );
  if (revoked) throw sessionRevokedError();
  return row;
}

/**
 * Invalidate every token for the account (password reset or role change).
 * @param {object} db
 * @param {number} userId
 */
export async function bumpSessionVersion(db, userId) {
  await db.run(
    "UPDATE users SET session_version = COALESCE(session_version, 0) + 1 WHERE id = ?",
    [userId]
  );
  cacheInvalidate(CACHE_KEYS.user(userId));
}

/**
 * Revoke one presented token. Other sessions for the same account stay valid.
 * @param {object} db
 * @param {{ jti?: string, exp?: number, userId?: number }} auth
 */
export async function revokePresentedSession(db, auth) {
  if (!auth?.jti) return;
  const expMs = Number(auth.exp) > 0 ? Number(auth.exp) * 1000 : Date.now() + 8 * 60 * 60 * 1000;
  await db.run(
    "INSERT OR REPLACE INTO revoked_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)",
    [String(auth.jti), Number(auth.userId) || 0, expMs]
  );
  await purgeExpiredRevocations(db, { force: true });
}
