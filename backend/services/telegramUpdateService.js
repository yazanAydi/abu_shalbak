import {
  parseRefundCallbackData,
  isManagerChat,
  answerCallbackQuery,
  editRefundMessageAlreadyHandled,
  isRefundTelegramConfigured,
} from "../utils/telegram.js";
import {
  approveRefundRequest,
  rejectRefundRequest,
  getRefundRequestById,
  getTelegramManagerUser,
} from "./refundRequestService.js";

/**
 * Process a Telegram update (webhook or polling).
 * @returns {{ handled: boolean, action?: string, requestId?: number }}
 */
export async function handleTelegramUpdate(db, update) {
  const cq = update?.callback_query;
  if (!cq?.data || !cq.id) {
    return { handled: false };
  }

  if (!isRefundTelegramConfigured()) {
    return { handled: false };
  }

  const chatId = cq.message?.chat?.id;
  if (!isManagerChat(chatId)) {
    await answerCallbackQuery(cq.id, "غير مسموح");
    return { handled: true, action: "denied" };
  }

  const parsed = parseRefundCallbackData(cq.data);
  if (!parsed?.requestId) {
    await answerCallbackQuery(cq.id);
    return { handled: false };
  }

  const managerUser = await getTelegramManagerUser(db);
  if (!managerUser) {
    await answerCallbackQuery(cq.id, "لا يوجد مدير مُعرّف في النظام");
    return { handled: true, action: "no_manager" };
  }

  try {
    const existing = await getRefundRequestById(db, parsed.requestId);
    if (!existing || existing.status !== "pending") {
      await answerCallbackQuery(cq.id, "تمت المعالجة مسبقاً");
      if (existing?.telegram_message_id) {
        try {
          await editRefundMessageAlreadyHandled({
            messageId: existing.telegram_message_id,
            requestId: parsed.requestId,
            currentStatus: existing.status,
          });
        } catch (_) {}
      }
      return { handled: true, action: "already_handled", requestId: parsed.requestId };
    }

    if (parsed.action === "approve") {
      await approveRefundRequest(db, parsed.requestId, managerUser, null, null, "telegram");
      await answerCallbackQuery(cq.id, "تمت الموافقة");
      return { handled: true, action: "approve", requestId: parsed.requestId };
    }

    await rejectRefundRequest(db, parsed.requestId, managerUser, null, null, "telegram");
    await answerCallbackQuery(cq.id, "تم الرفض");
    return { handled: true, action: "reject", requestId: parsed.requestId };
  } catch (e) {
    console.error("Telegram update error:", e);
    await answerCallbackQuery(cq.id, e.message || "فشل المعالجة");
    return { handled: true, action: "error", requestId: parsed.requestId };
  }
}
