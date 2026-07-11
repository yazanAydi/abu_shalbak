import {
  parseApprovalCallbackData,
  isManagerChat,
  answerCallbackQuery,
  editRefundMessageAlreadyHandled,
  editOnAccountMessageAlreadyHandled,
  editAdvanceMessageAlreadyHandled,
  isRefundTelegramConfigured,
  isZimmaTelegramConfigured,
  isSulafTelegramConfigured,
} from "../utils/telegram.js";
import {
  approveRefundRequest,
  rejectRefundRequest,
  getRefundRequestById,
  getTelegramManagerUser,
} from "./refundRequestService.js";
import {
  approveOnAccountRequest,
  rejectOnAccountRequest,
  getOnAccountRequestById,
} from "./onAccountRequestService.js";
import {
  approveAdvanceRequest,
  rejectAdvanceRequest,
  getAdvanceRequestById,
} from "./advanceRequestService.js";

function isBotConfigured(kind) {
  if (kind === "zimma") return isZimmaTelegramConfigured();
  if (kind === "sulaf") return isSulafTelegramConfigured();
  return isRefundTelegramConfigured();
}

/**
 * Process a Telegram update (webhook or polling).
 * @returns {{ handled: boolean, action?: string, requestId?: number, kind?: string }}
 */
export async function handleTelegramUpdate(db, update) {
  const cq = update?.callback_query;
  if (!cq?.data || !cq.id) {
    return { handled: false };
  }

  const parsed = parseApprovalCallbackData(cq.data);
  if (!parsed?.requestId) {
    return { handled: false };
  }

  if (!isBotConfigured(parsed.kind)) {
    return { handled: false };
  }

  const chatId = cq.message?.chat?.id;
  if (!isManagerChat(chatId, parsed.kind)) {
    await answerCallbackQuery(cq.id, "غير مسموح", parsed.kind);
    return { handled: true, action: "denied", kind: parsed.kind };
  }

  const managerUser = await getTelegramManagerUser(db);
  if (!managerUser) {
    await answerCallbackQuery(cq.id, "لا يوجد مدير مُعرّف في النظام", parsed.kind);
    return { handled: true, action: "no_manager", kind: parsed.kind };
  }

  try {
    if (parsed.kind === "refund") {
      return handleRefundCallback(db, cq, parsed, managerUser);
    }
    if (parsed.kind === "zimma") {
      return handleZimmaCallback(db, cq, parsed, managerUser);
    }
    if (parsed.kind === "sulaf") {
      return handleSulafCallback(db, cq, parsed, managerUser);
    }
    return { handled: false };
  } catch (e) {
    console.error("Telegram update error:", e);
    await answerCallbackQuery(cq.id, e.message || "فشل المعالجة", parsed.kind);
    return { handled: true, action: "error", requestId: parsed.requestId, kind: parsed.kind };
  }
}

async function handleRefundCallback(db, cq, parsed, managerUser) {
  const existing = await getRefundRequestById(db, parsed.requestId);
  if (!existing || existing.status !== "pending") {
    await answerCallbackQuery(cq.id, "تمت المعالجة مسبقاً", "refund");
    if (existing?.telegram_message_id) {
      try {
        await editRefundMessageAlreadyHandled({
          messageId: existing.telegram_message_id,
          requestId: parsed.requestId,
          currentStatus: existing.status,
        });
      } catch (_) {}
    }
    return { handled: true, action: "already_handled", requestId: parsed.requestId, kind: "refund" };
  }

  if (parsed.action === "approve") {
    await approveRefundRequest(db, parsed.requestId, managerUser, null, null, "telegram");
    await answerCallbackQuery(cq.id, "تمت الموافقة", "refund");
    return { handled: true, action: "approve", requestId: parsed.requestId, kind: "refund" };
  }

  await rejectRefundRequest(db, parsed.requestId, managerUser, null, null, "telegram");
  await answerCallbackQuery(cq.id, "تم الرفض", "refund");
  return { handled: true, action: "reject", requestId: parsed.requestId, kind: "refund" };
}

async function handleZimmaCallback(db, cq, parsed, managerUser) {
  const existing = await getOnAccountRequestById(db, parsed.requestId);
  if (!existing || existing.status !== "pending") {
    await answerCallbackQuery(cq.id, "تمت المعالجة مسبقاً", "zimma");
    if (existing?.telegram_message_id) {
      try {
        await editOnAccountMessageAlreadyHandled({
          messageId: existing.telegram_message_id,
          requestId: parsed.requestId,
          currentStatus: existing.status,
        });
      } catch (_) {}
    }
    return { handled: true, action: "already_handled", requestId: parsed.requestId, kind: "zimma" };
  }

  if (parsed.action === "approve") {
    await approveOnAccountRequest(db, parsed.requestId, managerUser, null, null, "telegram");
    await answerCallbackQuery(cq.id, "تمت الموافقة", "zimma");
    return { handled: true, action: "approve", requestId: parsed.requestId, kind: "zimma" };
  }

  await rejectOnAccountRequest(db, parsed.requestId, managerUser, null, null, "telegram");
  await answerCallbackQuery(cq.id, "تم الرفض", "zimma");
  return { handled: true, action: "reject", requestId: parsed.requestId, kind: "zimma" };
}

async function handleSulafCallback(db, cq, parsed, managerUser) {
  const existing = await getAdvanceRequestById(db, parsed.requestId);
  if (!existing || existing.status !== "pending") {
    await answerCallbackQuery(cq.id, "تمت المعالجة مسبقاً", "sulaf");
    if (existing?.telegram_message_id) {
      try {
        await editAdvanceMessageAlreadyHandled({
          messageId: existing.telegram_message_id,
          requestId: parsed.requestId,
          currentStatus: existing.status,
        });
      } catch (_) {}
    }
    return { handled: true, action: "already_handled", requestId: parsed.requestId, kind: "sulaf" };
  }

  if (parsed.action === "approve") {
    await approveAdvanceRequest(db, parsed.requestId, managerUser, null, null, "telegram");
    await answerCallbackQuery(cq.id, "تمت الموافقة", "sulaf");
    return { handled: true, action: "approve", requestId: parsed.requestId, kind: "sulaf" };
  }

  await rejectAdvanceRequest(db, parsed.requestId, managerUser, null, null, "telegram");
  await answerCallbackQuery(cq.id, "تم الرفض", "sulaf");
  return { handled: true, action: "reject", requestId: parsed.requestId, kind: "sulaf" };
}
