import { handleTelegramUpdate } from "./telegramUpdateService.js";
import { HttpError, notFound } from "../utils/httpError.js";

export const TELEGRAM_HANDLE_FAILURE_LIMIT = 3;

export function isTelegramHandleFailure(result) {
  return result?.action === "error";
}

export async function loadPollOffset(db, botKind) {
  if (!db?.get) return 0;
  try {
    const row = await db.get(
      "SELECT next_offset FROM telegram_poll_offsets WHERE bot_kind = ?",
      [botKind]
    );
    return row ? Number(row.next_offset) || 0 : 0;
  } catch {
    return 0;
  }
}

export async function persistPollOffset(db, botKind, nextOffset) {
  if (!db?.run) return;
  await db.run(
    `INSERT INTO telegram_poll_offsets (bot_kind, next_offset, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(bot_kind) DO UPDATE SET
       next_offset = excluded.next_offset,
       updated_at = datetime('now')`,
    [botKind, Number(nextOffset) || 0]
  );
}

async function markFailureRetriedIfPresent(db, botKind, updateId) {
  if (!db?.run || updateId == null) return;
  await db.run(
    `UPDATE telegram_poll_failures
     SET status = 'retried', updated_at = datetime('now')
     WHERE bot_kind = ? AND update_id = ? AND status IN ('pending', 'skipped')`,
    [botKind, Number(updateId)]
  );
}

export async function recordPollFailure(db, { botKind, updateId, payloadJson, error, status = "pending" }) {
  const existing = await db.get(
    "SELECT id, attempts FROM telegram_poll_failures WHERE bot_kind = ? AND update_id = ?",
    [botKind, updateId]
  );
  if (existing) {
    const attempts = Number(existing.attempts) + 1;
    await db.run(
      `UPDATE telegram_poll_failures
       SET error = ?, attempts = ?, status = ?, payload_json = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [String(error || ""), attempts, status, payloadJson, existing.id]
    );
    return { id: existing.id, attempts, status };
  }
  const ins = await db.run(
    `INSERT INTO telegram_poll_failures
       (bot_kind, update_id, payload_json, error, attempts, status)
     VALUES (?, ?, ?, ?, 1, ?)`,
    [botKind, updateId, payloadJson, String(error || ""), status]
  );
  return { id: ins.lastID, attempts: 1, status };
}

/**
 * Handle a polled update first; persist offset only after success or after N failures.
 * A non-advanced failure must stop the current getUpdates batch so later updates
 * are not acked while this one is still retrying.
 */
export async function processPolledUpdate(db, botKind, update, options = {}) {
  const handle = options.handle || handleTelegramUpdate;
  const maxAttempts = options.maxAttempts ?? TELEGRAM_HANDLE_FAILURE_LIMIT;
  const updateId = update?.update_id;

  try {
    const result = await handle(db, update);
    if (isTelegramHandleFailure(result)) {
      throw new Error("Telegram handle returned error");
    }
    if (updateId != null) {
      await persistPollOffset(db, botKind, Number(updateId) + 1);
      await markFailureRetriedIfPresent(db, botKind, updateId);
    }
    return { advanced: updateId != null, skipped: false, result };
  } catch (e) {
    if (updateId == null) throw e;
    const rec = await recordPollFailure(db, {
      botKind,
      updateId: Number(updateId),
      payloadJson: JSON.stringify(update),
      error: e?.message || String(e),
      status: "pending",
    });
    if (rec.attempts >= maxAttempts) {
      await db.run(
        `UPDATE telegram_poll_failures
         SET status = 'skipped', updated_at = datetime('now')
         WHERE id = ?`,
        [rec.id]
      );
      await persistPollOffset(db, botKind, Number(updateId) + 1);
      return {
        advanced: true,
        skipped: true,
        attempts: rec.attempts,
        failureId: rec.id,
      };
    }
    return {
      advanced: false,
      skipped: false,
      attempts: rec.attempts,
      failureId: rec.id,
    };
  }
}

export async function listTelegramPollFailures(db, { status, limit = 100 } = {}) {
  const cap = Math.min(200, Math.max(1, Number(limit) || 100));
  if (status) {
    return db.all(
      `SELECT * FROM telegram_poll_failures
       WHERE status = ?
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
      [String(status), cap]
    );
  }
  return db.all(
    `SELECT * FROM telegram_poll_failures
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`,
    [cap]
  );
}

export async function retryTelegramPollFailure(db, id, options = {}) {
  const row = await db.get("SELECT * FROM telegram_poll_failures WHERE id = ?", [id]);
  if (!row) throw notFound("تحديث تيليغرام غير موجود");
  let update;
  try {
    update = JSON.parse(row.payload_json);
  } catch {
    throw new HttpError(400, "حمولة التحديث تالفة", "TELEGRAM_PAYLOAD_INVALID");
  }
  const handle = options.handle || handleTelegramUpdate;
  const result = await handle(db, update);
  if (isTelegramHandleFailure(result)) {
    await recordPollFailure(db, {
      botKind: row.bot_kind,
      updateId: row.update_id,
      payloadJson: row.payload_json,
      error: "Telegram handle returned error",
      status: row.status === "skipped" ? "skipped" : "pending",
    });
    throw new HttpError(500, "فشلت إعادة معالجة تحديث تيليغرام", "TELEGRAM_RETRY_FAILED");
  }
  await db.run(
    `UPDATE telegram_poll_failures
     SET status = 'retried', updated_at = datetime('now')
     WHERE id = ?`,
    [row.id]
  );
  return { result, id: row.id };
}
