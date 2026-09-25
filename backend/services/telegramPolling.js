import { handleTelegramUpdate } from "./telegramUpdateService.js";
import {
  getApprovalBotPollConfigs,
  getApprovalsBotToken,
  getApprovalsChatId,
  isApprovalsBotTokenConfigured,
  telegramFailureLog,
  telegramGet,
} from "../utils/telegram.js";
import { loadPollOffset, processPolledUpdate } from "./telegramPollRecovery.js";

const POLL_TIMEOUT_SEC = 30;
const ERROR_RETRY_MS = 2000;

export function isTelegramPollingEnabled() {
  return (
    process.env.TELEGRAM_USE_POLLING === "1" &&
    process.env.NODE_ENV !== "test" &&
    getApprovalBotPollConfigs().length > 0
  );
}

/**
 * Independent long-poll loops for approval bots. A failure in one bot does not
 * block the others. Offsets are tracked per bot.kind.
 *
 * @param {object} db
 * @param {{ kind: string, token: string }[]} bots
 * @param {{ get?: typeof telegramGet, pollTimeoutSec?: number, errorRetryMs?: number }} [options]
 * @returns {() => void} stop
 */
export function startTelegramBotPollLoops(db, bots, options = {}) {
  const get = options.get || telegramGet;
  const handle = options.handle || handleTelegramUpdate;
  const pollTimeoutSec = options.pollTimeoutSec ?? POLL_TIMEOUT_SEC;
  const errorRetryMs = options.errorRetryMs ?? ERROR_RETRY_MS;
  const maxAttempts = options.maxAttempts;

  /** @type {Record<string, number>} */
  const offsets = {};
  let stopped = false;

  for (const bot of bots) {
    void (async () => {
      offsets[bot.kind] = await loadPollOffset(db, bot.kind);
      while (!stopped) {
        try {
          const updates = await get(
            "getUpdates",
            {
              offset: offsets[bot.kind] || 0,
              timeout: pollTimeoutSec,
              allowed_updates: JSON.stringify(bot.allowedUpdates || ["callback_query"]),
            },
            bot.token
          );

          if (!Array.isArray(updates)) continue;

          for (const update of updates) {
            const outcome = await processPolledUpdate(db, bot.kind, update, {
              handle: (database, upd) => handle(database, upd, { sourceBot: bot.kind }),
              maxAttempts,
            });
            if (outcome.advanced && update.update_id != null) {
              offsets[bot.kind] = Number(update.update_id) + 1;
            }
            if (outcome.result?.action === "approve") {
              console.log(`[telegram-poll] Approved ${outcome.result.kind} #${outcome.result.requestId}`);
            } else if (outcome.result?.action === "reject") {
              console.log(`[telegram-poll] Rejected ${outcome.result.kind} #${outcome.result.requestId}`);
            }
            if (outcome.skipped) {
              console.error(
                `[telegram-poll] Skipped poison update ${update.update_id} (${bot.kind}) after ${outcome.attempts} failures`
              );
            }
            if (!outcome.advanced) break;
          }
        } catch (e) {
          if (!stopped) {
            console.error(`[telegram-poll] Error (${bot.kind}): ${telegramFailureLog(e)}`);
            await new Promise((r) => setTimeout(r, errorRetryMs));
          }
        }
      }
    })();
  }

  return () => {
    stopped = true;
  };
}

/**
 * Long-poll Telegram getUpdates for all approval bots (localhost / LAN store).
 */
async function logApprovalsBotAccess() {
  if (!isApprovalsBotTokenConfigured()) return;
  try {
    const me = await telegramGet("getMe", {}, getApprovalsBotToken());
    console.log(`[telegram-poll] approvals bot id=${me?.id ?? "?"} username=@${me?.username || "?"}`);
    const chatId = getApprovalsChatId();
    if (!chatId) {
      console.warn("[telegram-poll] TELEGRAM_APPROVALS_CHAT_ID is empty; approval messages will not be sent");
      return;
    }
    const member = await telegramGet(
      "getChatMember",
      { chat_id: chatId, user_id: String(me.id) },
      getApprovalsBotToken()
    );
    console.log(`[telegram-poll] approvals bot chat_status=${member?.status || "unknown"}`);
    if (member?.status !== "administrator" && member?.status !== "creator") {
      console.warn(
        "[telegram-poll] Approvals bot is not a group administrator. Membership checks are not reliable and button presses will be denied."
      );
    }
  } catch (e) {
    console.error(`[telegram-poll] approvals access check failed ${telegramFailureLog(e)}`);
  }
}

export function startTelegramPolling(db) {
  console.log(
    `[telegram] approvals: token=${isApprovalsBotTokenConfigured() ? "set" : "empty"} chat=${
      getApprovalsChatId() ? "set" : "empty"
    } chat_id=${getApprovalsChatId() || "empty"} polling=${process.env.TELEGRAM_USE_POLLING === "1" ? "on" : "off"}`
  );
  const bots = getApprovalBotPollConfigs();
  if (!isTelegramPollingEnabled() || !bots.length) return null;

  let stopped = false;
  /** @type {(() => void) | null} */
  let stopLoops = null;

  (async () => {
    for (const bot of bots) {
      try {
        await telegramGet("deleteWebhook", {}, bot.token);
        console.log(`[telegram-poll] Cleared ${bot.kind} bot webhook (required for polling)`);
      } catch (e) {
        console.warn(`[telegram-poll] deleteWebhook (${bot.kind}): ${telegramFailureLog(e)}`);
      }
    }
    if (stopped) return;
    await logApprovalsBotAccess();
    if (stopped) return;
    console.log("[telegram-poll] Listening for approve/reject button presses…");
    stopLoops = startTelegramBotPollLoops(db, bots);
  })();

  return () => {
    stopped = true;
    stopLoops?.();
  };
}
