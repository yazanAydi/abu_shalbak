import { handleTelegramUpdate } from "./telegramUpdateService.js";
import { getRefundBotToken, refundTelegramGet } from "../utils/telegram.js";

const POLL_TIMEOUT_SEC = 30;

export function isTelegramPollingEnabled() {
  return (
    process.env.TELEGRAM_USE_POLLING === "1" &&
    process.env.NODE_ENV !== "test" &&
    !!getRefundBotToken()
  );
}

async function deleteRefundWebhook() {
  try {
    await refundTelegramGet("deleteWebhook");
    console.log("[telegram-poll] Cleared refund bot webhook (required for polling)");
  } catch (e) {
    console.warn("[telegram-poll] deleteWebhook:", e.message);
  }
}

/**
 * Long-poll Telegram getUpdates for refund bot callback buttons (localhost dev).
 */
export function startTelegramPolling(db) {
  if (!isTelegramPollingEnabled()) return null;

  let offset = 0;
  let stopped = false;

  (async () => {
    await deleteRefundWebhook();
    console.log("[telegram-poll] Listening for refund approve/reject button presses…");

    while (!stopped) {
      try {
        const updates = await refundTelegramGet("getUpdates", {
          offset,
          timeout: POLL_TIMEOUT_SEC,
          allowed_updates: JSON.stringify(["callback_query"]),
        });

        if (!Array.isArray(updates)) continue;

        for (const update of updates) {
          if (update.update_id != null) {
            offset = update.update_id + 1;
          }
          const result = await handleTelegramUpdate(db, update);
          if (result.action === "approve") {
            console.log(`[telegram-poll] Approved refund #${result.requestId}`);
          } else if (result.action === "reject") {
            console.log(`[telegram-poll] Rejected refund #${result.requestId}`);
          }
        }
      } catch (e) {
        if (!stopped) {
          console.error("[telegram-poll] Error:", e.message);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
  })();

  return () => {
    stopped = true;
  };
}
