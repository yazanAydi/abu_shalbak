import { handleTelegramUpdate } from "./telegramUpdateService.js";
import {
  getApprovalBotPollConfigs,
  telegramGet,
} from "../utils/telegram.js";

const POLL_TIMEOUT_SEC = 30;

export function isTelegramPollingEnabled() {
  return (
    process.env.TELEGRAM_USE_POLLING === "1" &&
    process.env.NODE_ENV !== "test" &&
    getApprovalBotPollConfigs().length > 0
  );
}

/**
 * Long-poll Telegram getUpdates for all approval bots (localhost dev).
 */
export function startTelegramPolling(db) {
  const bots = getApprovalBotPollConfigs();
  if (!isTelegramPollingEnabled() || !bots.length) return null;

  /** @type {Record<string, number>} */
  const offsets = {};
  let stopped = false;

  (async () => {
    for (const bot of bots) {
      try {
        await telegramGet("deleteWebhook", {}, bot.token);
        console.log(`[telegram-poll] Cleared ${bot.kind} bot webhook (required for polling)`);
      } catch (e) {
        console.warn(`[telegram-poll] deleteWebhook (${bot.kind}):`, e.message);
      }
    }
    console.log("[telegram-poll] Listening for approve/reject button presses…");

    while (!stopped) {
      for (const bot of bots) {
        try {
          const updates = await telegramGet(
            "getUpdates",
            {
              offset: offsets[bot.kind] || 0,
              timeout: POLL_TIMEOUT_SEC,
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
          }
        }
      }
      if (!stopped) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  })();

  return () => {
    stopped = true;
  };
}
