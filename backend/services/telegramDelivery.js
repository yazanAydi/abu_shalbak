import { HttpError } from "../utils/httpError.js";

/**
 * Outbound Telegram delivery stays off the HTTP response.
 * The approval row is already committed. Retries read that row again and
 * never approve it. A timeout can mean Telegram accepted the message before
 * the response was lost, so a later try may post another message. Only the
 * stored message id can approve, and money moves only on a pending decision.
 */

const jobs = new Set();
const inflight = new Set();
const retryTimers = new Map();
const TIMER_SLICE_MS = 30_000;

let nowFn = () => Date.now();

const DELIVERY_TABLES = new Set([
  "refund_requests",
  "on_account_requests",
  "advance_requests",
  "customer_cash_debt_requests",
  "expense_approval_requests",
  "supplier_payment_approval_requests",
  "shop_consumption_requests",
]);

const MAX_ATTEMPTS = 5;
const PERMANENT_CODES = new Set([400, 401, 403, 404]);

export function telegramDeliveryIsInline() {
  return process.env.NODE_ENV === "test" && process.env.TELEGRAM_DELIVERY_ASYNC !== "1";
}

function retryTimersEnabled() {
  if (process.env.TELEGRAM_RETRY_TIMERS === "0") return false;
  if (process.env.TELEGRAM_RETRY_TIMERS === "1") return true;
  return process.env.NODE_ENV !== "test";
}

/** Tests move this clock instead of waiting out Telegram retry_after. */
export function setTelegramDeliveryClock(fn) {
  nowFn = typeof fn === "function" ? fn : () => Date.now();
}

function deliveryNow() {
  return nowFn();
}

function timerSliceMs(delayMs) {
  const configured = Number(process.env.TELEGRAM_RETRY_TIMER_CAP_MS);
  const cap =
    Number.isFinite(configured) && configured >= 0 && configured <= TIMER_SLICE_MS
      ? configured
      : TIMER_SLICE_MS;
  return Math.min(Math.max(0, delayMs), cap);
}

/** Drop in-memory claims and retry timers. Process shutdown and a simulated restart use this. */
export function stopTelegramDeliveryScheduler() {
  for (const entry of retryTimers.values()) clearTimeout(entry.timer);
  retryTimers.clear();
  inflight.clear();
}

function keyOf(table, requestId) {
  return `${table}:${requestId}`;
}

function claim(table, requestId) {
  const key = keyOf(table, requestId);
  if (inflight.has(key)) return false;
  inflight.add(key);
  return true;
}

function release(table, requestId) {
  inflight.delete(keyOf(table, requestId));
}

export function scheduleTelegramDelivery(work, label = "Telegram send failed") {
  const job = Promise.resolve()
    .then(work)
    .catch((err) => {
      console.error(`${label}:`, err?.message || err);
      return null;
    });
  jobs.add(job);
  const tracked = job.finally(() => {
    jobs.delete(job);
  });
  return telegramDeliveryIsInline() ? tracked : null;
}

export async function settleTelegramDeliveries() {
  while (jobs.size) {
    await Promise.all([...jobs]);
  }
}

async function ensureQueued(db, table, requestId) {
  await db.run(
    `INSERT INTO telegram_outbound (request_table, request_id, state, attempts, updated_at)
     VALUES (?, ?, 'queued', 0, datetime('now'))
     ON CONFLICT(request_table, request_id) DO UPDATE SET
       state = CASE WHEN telegram_outbound.state = 'failed' THEN telegram_outbound.state ELSE 'queued' END,
       updated_at = datetime('now')`,
    [table, requestId]
  );
}

async function clearOutbound(db, table, requestId) {
  await db.run(`DELETE FROM telegram_outbound WHERE request_table = ? AND request_id = ?`, [
    table,
    requestId,
  ]);
}

function delaySeconds(err, attempts) {
  const code = Number(err?.errorCode);
  const retryAfter = Number(err?.retryAfterSeconds);
  if (code === 429 && Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter;
  return Math.min(60, 2 ** attempts);
}

async function recordFailure(db, table, requestId, err) {
  const code = Number(err?.errorCode);
  const current = await db.get(
    `SELECT attempts FROM telegram_outbound WHERE request_table = ? AND request_id = ?`,
    [table, requestId]
  );
  const attempts = (Number(current?.attempts) || 0) + 1;
  const permanent = PERMANENT_CODES.has(code);
  const exhausted = permanent || attempts >= MAX_ATTEMPTS;
  const ambiguous = Boolean(err?.timedOut);
  const delaySec = exhausted ? 0 : delaySeconds(err, attempts);
  const next = exhausted ? null : new Date(deliveryNow() + delaySec * 1000).toISOString();
  const detail = `${ambiguous ? "ambiguous_timeout " : ""}${String(err?.message || err)}`.slice(0, 300);
  await db.run(
    `INSERT INTO telegram_outbound
       (request_table, request_id, state, attempts, last_error, next_attempt_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(request_table, request_id) DO UPDATE SET
       state = excluded.state,
       attempts = excluded.attempts,
       last_error = excluded.last_error,
       next_attempt_at = excluded.next_attempt_at,
       updated_at = datetime('now')`,
    [table, requestId, exhausted ? "failed" : "queued", attempts, detail, next]
  );
  if (!exhausted) armRetry(db, delaySec * 1000);
  return { exhausted, delaySec, attempts };
}

function armRetry(db, delayMs) {
  if (!retryTimersEnabled()) return;
  const waitMs = timerSliceMs(delayMs);
  const existing = retryTimers.get(db);
  if (existing && existing.waitMs <= waitMs) return;
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    retryTimers.delete(db);
    runDueTelegramRetries(db).catch((err) => {
      console.error("Telegram retry failed:", err?.message || err);
    });
  }, waitMs);
  if (typeof timer.unref === "function") timer.unref();
  retryTimers.set(db, { timer, waitMs });
}

async function armNextRetry(db) {
  if (!retryTimersEnabled()) return;
  const rows = await db.all(
    `SELECT next_attempt_at FROM telegram_outbound
     WHERE state = 'queued' AND attempts > 0 AND next_attempt_at IS NOT NULL`
  );
  let soonest = null;
  for (const row of rows) {
    const at = Date.parse(row.next_attempt_at);
    if (!Number.isFinite(at)) continue;
    if (soonest == null || at < soonest) soonest = at;
  }
  if (soonest == null) return;
  armRetry(db, soonest - deliveryNow());
}

/** Re-arm from persisted deadlines after process startup. */
export async function resumeTelegramRetryScheduler(db) {
  await armNextRetry(db);
}

async function deliveryBlocked(db, table, requestId) {
  const row = await db.get(
    `SELECT state, next_attempt_at FROM telegram_outbound WHERE request_table = ? AND request_id = ?`,
    [table, requestId]
  );
  if (!row) return null;
  if (row.next_attempt_at && Date.parse(row.next_attempt_at) > deliveryNow()) return "cooldown";
  if (row.state === "failed") return "failed";
  return null;
}

async function livePending(db, table, requestId) {
  const row = await db.get(
    `SELECT status, telegram_message_id AS message_id FROM ${table} WHERE id = ?`,
    [requestId]
  );
  if (!row || row.status !== "pending") return null;
  if (row.message_id != null && String(row.message_id).trim() !== "") return null;
  return row;
}

/**
 * One send for a still-pending request. Startup resend, the retry timer, and
 * a manual retry all come through here so only one attempt runs at a time.
 */
export async function sendPendingTelegram(db, table, requestId, send) {
  if (!DELIVERY_TABLES.has(table)) {
    throw new Error(`unsupported telegram delivery table: ${table}`);
  }
  if (!claim(table, requestId)) return false;
  try {
    if (!(await livePending(db, table, requestId))) {
      await clearOutbound(db, table, requestId);
      return false;
    }
    if (await deliveryBlocked(db, table, requestId)) return false;
    const messageId = await send();
    if (messageId == null || messageId === "") {
      const err = new Error("Telegram response had no message id");
      await recordFailure(db, table, requestId, err);
      return false;
    }
    const info = await db.run(
      `UPDATE ${table}
         SET telegram_message_id = ?
       WHERE id = ?
         AND status = 'pending'
         AND (telegram_message_id IS NULL OR telegram_message_id = '')`,
      [String(messageId), requestId]
    );
    if (!info.changes) {
      await clearOutbound(db, table, requestId);
      return false;
    }
    await clearOutbound(db, table, requestId);
    return true;
  } catch (err) {
    await recordFailure(db, table, requestId, err);
    throw err;
  } finally {
    release(table, requestId);
  }
}

export async function deliverPendingTelegram(db, table, requestId, send, label) {
  if (!DELIVERY_TABLES.has(table)) {
    throw new Error(`unsupported telegram delivery table: ${table}`);
  }
  await ensureQueued(db, table, requestId);
  return scheduleTelegramDelivery(async () => {
    try {
      const sent = await sendPendingTelegram(db, table, requestId, send);
      if (!sent) return null;
      const row = await db.get(`SELECT telegram_message_id AS message_id FROM ${table} WHERE id = ?`, [
        requestId,
      ]);
      return row?.message_id ? String(row.message_id) : null;
    } catch (err) {
      console.error(`${label || "Telegram send failed"}:`, err?.message || err);
      return null;
    }
  }, label);
}

export async function readTelegramDelivery(db, table, requestId, messageId) {
  if (messageId != null && String(messageId).trim() !== "") return "sent";
  const state = await db.get(
    `SELECT state FROM telegram_outbound WHERE request_table = ? AND request_id = ?`,
    [table, requestId]
  );
  if (!state) return null;
  return state.state === "failed" ? "failed" : "queued";
}

export async function createDeliveryContract(db, table, requestId, configured, messageId) {
  if (!configured) return { telegram: false, telegram_delivery: null };
  const telegram_delivery = await readTelegramDelivery(db, table, requestId, messageId);
  if (telegram_delivery === "sent" || messageId) {
    return { telegram: true, telegram_delivery: "sent" };
  }
  return { telegram: false, telegram_delivery: telegram_delivery || "queued" };
}

export async function runDueTelegramRetries(db, nowMs = deliveryNow()) {
  const previous = nowFn;
  nowFn = () => nowMs;
  try {
    const { deliverOnePending } = await import("./telegramPendingResend.js");
    const rows = await db.all(
      `SELECT request_table, request_id, next_attempt_at
     FROM telegram_outbound
     WHERE state = 'queued' AND attempts > 0`
    );
    let sent = 0;
    for (const row of rows) {
      if (row.next_attempt_at && Date.parse(row.next_attempt_at) > nowMs) continue;
      try {
        if (await deliverOnePending(db, row.request_table, row.request_id)) sent += 1;
      } catch {
        /* the failure is already stored */
      }
    }
    await armNextRetry(db);
    return sent;
  } finally {
    nowFn = previous;
  }
}

export async function retrySavedTelegramDelivery(db, table, requestId) {
  if (!DELIVERY_TABLES.has(table)) {
    throw new HttpError(400, "نوع الطلب غير مدعوم", "INVALID_RETRY");
  }
  const live = await db.get(
    `SELECT status, telegram_message_id AS message_id FROM ${table} WHERE id = ?`,
    [requestId]
  );
  if (!live) {
    throw new HttpError(404, "الطلب غير موجود", "NOT_FOUND");
  }
  if (live.status !== "pending") {
    throw new HttpError(409, "الطلب لم يعد قيد المراجعة", "NOT_PENDING");
  }
  if (live.message_id != null && String(live.message_id).trim() !== "") {
    return { telegram: true, telegram_delivery: "sent", telegram_message_id: String(live.message_id) };
  }
  const outbound = await db.get(
    `SELECT state, attempts, next_attempt_at FROM telegram_outbound WHERE request_table = ? AND request_id = ?`,
    [table, requestId]
  );
  if (outbound?.next_attempt_at && Date.parse(outbound.next_attempt_at) > deliveryNow()) {
    const contract = await createDeliveryContract(db, table, requestId, true, null);
    return { ...contract, telegram_message_id: null, next_attempt_at: outbound.next_attempt_at };
  }
  await db.run(
    `INSERT INTO telegram_outbound (request_table, request_id, state, attempts, last_error, next_attempt_at, updated_at)
     VALUES (?, ?, 'queued', 0, NULL, NULL, datetime('now'))
     ON CONFLICT(request_table, request_id) DO UPDATE SET
       state = 'queued',
       attempts = 0,
       last_error = NULL,
       next_attempt_at = NULL,
       updated_at = datetime('now')`,
    [table, requestId]
  );
  const { deliverOnePending } = await import("./telegramPendingResend.js");
  try {
    await deliverOnePending(db, table, requestId);
  } catch {
    /* the failure is already stored */
  }
  const after = await db.get(`SELECT telegram_message_id AS message_id FROM ${table} WHERE id = ?`, [requestId]);
  const contract = await createDeliveryContract(db, table, requestId, true, after?.message_id);
  return { ...contract, telegram_message_id: after?.message_id ? String(after.message_id) : null };
}

export const TELEGRAM_DELIVERY_TABLES = DELIVERY_TABLES;
