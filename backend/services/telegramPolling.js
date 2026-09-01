import { handleTelegramUpdate } from "./telegramUpdateService.js";
import {
  getApprovalBotPollConfigs,
  telegramGet,
} from "../utils/telegram.js";

const POLL_TIMEOUT_SEC = 30;
const ERROR_RETRY_MS = 100;

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
  const pollTimeoutSec = options.pollTimeoutSec ?? POLL_TIMEOUT_SEC;
  const errorRetryMs = options.errorRetryMs ?? ERROR_RETRY_MS;

  /** @type {Record<string, number>} */
  const offsets = {};
  let stopped = false;

  for (const bot of bots) {
    void (async () => {
      while (!stopped) {
        try {
          const updates = await get(
            "getUpdates",
            {
              offset: offsets[bot.kind] || 0,
              timeout: pollTimeoutSec,
              allowed_updates: JSON.stringify(["callback_query"]),
            },
            bot.token
          );

          if (!Array.isArray(updates)) continue;

          for (const update of updates) {
            if (update.update_id != null) {
              offsets[bot.kind] = update.update_id + 1;
            }
            const result = await handleTelegramUpdate(db, update);
            if (result.action === "approve") {
              console.log(`[telegram-poll] Approved ${result.kind} #${result.requestId}`);
            } else if (result.action === "reject") {
              console.log(`[telegram-poll] Rejected ${result.kind} #${result.requestId}`);
            }
          }
        } catch (e) {
          if (!stopped) {
            console.error(`[telegram-poll] Error (${bot.kind}):`, e.message);
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
export function startTelegramPolling(db) {
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
        console.warn(`[telegram-poll] deleteWebhook (${bot.kind}):`, e.message);
      }
    }
    if (stopped) return;
    console.log("[telegram-poll] Listening for approve/reject button presses…");
    stopLoops = startTelegramBotPollLoops(db, bots);
  })();

  return () => {
    stopped = true;
    stopLoops?.();
  };
}
