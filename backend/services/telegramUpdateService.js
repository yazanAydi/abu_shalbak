import {
  parseApprovalCallbackData,
  isManagerChat,
  isAllowedTelegramApprover,
  answerCallbackQuery,
  editRefundMessageAlreadyHandled,
  editOnAccountMessageAlreadyHandled,
  editAdvanceMessageAlreadyHandled,
  editCashDebtMessageAlreadyHandled,
  isRefundTelegramConfigured,
  isZimmaTelegramConfigured,
  isSulafTelegramConfigured,
  isApprovalsTelegramConfigured,
  isApprovalsGroupChat,
  isActiveChatMember,
  fetchApprovalsChatMember,
  approvalsCallbackMatchesTarget,
  observeApprovalsSetupCommand,
} from "../utils/telegram.js";
import { userHasAccountantPermission } from "../utils/accountantPermissions.js";
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
import {
  approveCustomerCashDebtRequest,
  rejectCustomerCashDebtRequest,
  getCustomerCashDebtRequestById,
} from "./customerCashDebtRequestService.js";
import {
  approveExpenseApprovalRequest,
  rejectExpenseApprovalRequest,
  approveSupplierPaymentApprovalRequest,
  rejectSupplierPaymentApprovalRequest,
  getExpenseApprovalRequestById,
  getSupplierPaymentApprovalRequestById,
} from "./groupApprovalService.js";
import {
  approveShopConsumptionRequest,
  rejectShopConsumptionRequest,
  getShopConsumptionRequestById,
} from "./shopConsumptionService.js";

function telegramReviewNote(managerUser) {
  const id = managerUser?.telegram_user_id;
  const uname = managerUser?.telegram_username;
  if (!id) return null;
  return uname ? `telegram:${id} (@${uname})` : `telegram:${id}`;
}

function isBotConfigured(kind) {
  if (kind === "zimma" || kind === "cashdebt") return isZimmaTelegramConfigured();
  if (kind === "sulaf") return isSulafTelegramConfigured();
  return isRefundTelegramConfigured();
}

/**
 * Process a Telegram update (webhook or polling).
 * @returns {{ handled: boolean, action?: string, requestId?: number, kind?: string }}
 */
export async function handleTelegramUpdate(db, update, context = {}) {
  const sourceBot = context?.sourceBot || null;
  if (sourceBot === "approvals" && update?.message) {
    const noticed = observeApprovalsSetupCommand(update.message);
    if (noticed && !noticed.ignored) {
      console.log(
        `[telegram-poll] Approvals group chat id ${noticed.chatId} (sender ${noticed.fromId || "unknown"}). Not saved. Set TELEGRAM_APPROVALS_CHAT_ID yourself. Sender was not authorized.`
      );
      return {
        handled: true,
        action: "setup_observed",
        kind: "approvals",
        chatId: noticed.chatId,
        fromId: noticed.fromId,
        authorized: false,
      };
    }
    return { handled: false };
  }

  const cq = update?.callback_query;
  if (!cq?.data || !cq.id) {
    return { handled: false };
  }

  const parsed = parseApprovalCallbackData(cq.data);
  if (!parsed?.requestId) {
    return { handled: false };
  }

  if (parsed.kind === "expense" || parsed.kind === "supplier" || parsed.kind === "consumption") {
    if (sourceBot !== "approvals") return { handled: false };
    return handleApprovalsCallback(db, cq, parsed);
  }
  if (sourceBot === "approvals") return { handled: false };

  if (!isBotConfigured(parsed.kind)) {
    return { handled: false };
  }

  const chatId = cq.message?.chat?.id;
  if (!isManagerChat(chatId, parsed.kind)) {
    await answerCallbackQuery(cq.id, "غير مسموح", parsed.kind);
    return { handled: true, action: "denied", kind: parsed.kind };
  }

  const fromId = cq.from?.id;
  if (!isAllowedTelegramApprover(fromId, chatId, parsed.kind)) {
    await answerCallbackQuery(cq.id, "غير مسموح", parsed.kind);
    return { handled: true, action: "denied", kind: parsed.kind };
  }

  const managerUser = await getTelegramManagerUser(db);
  if (!managerUser) {
    await answerCallbackQuery(cq.id, "لم يُضبط حساب موافق صالح في الإعدادات", parsed.kind);
    return { handled: true, action: "no_manager", kind: parsed.kind };
  }
  const permissionKey =
    parsed.kind === "zimma" || parsed.kind === "cashdebt"
      ? "on_account_approvals"
      : parsed.kind === "sulaf"
        ? "advance_approvals"
        : "refund_approvals";
  let permitted = false;
  try {
    permitted = await userHasAccountantPermission(db, managerUser, permissionKey);
  } catch (err) {
    if (err?.code === "PERMISSIONS_CORRUPT") {
      await answerCallbackQuery(cq.id, "صلاحيات حساب الموافق تالفة", parsed.kind);
      return { handled: true, action: "forbidden", kind: parsed.kind, requestId: parsed.requestId };
    }
    throw err;
  }
  if (!permitted) {
    await answerCallbackQuery(cq.id, "حساب الموافق لا يملك صلاحية الموافقة", parsed.kind);
    return { handled: true, action: "forbidden", kind: parsed.kind, requestId: parsed.requestId };
  }

  const approver = {
    ...managerUser,
    telegram_user_id: fromId,
    telegram_username: cq.from?.username || null,
  };

  try {
    if (parsed.kind === "refund") {
      return handleRefundCallback(db, cq, parsed, approver);
    }
    if (parsed.kind === "zimma") {
      return handleZimmaCallback(db, cq, parsed, approver);
    }
    if (parsed.kind === "cashdebt") {
      return handleCashDebtCallback(db, cq, parsed, approver);
    }
    if (parsed.kind === "sulaf") {
      return handleSulafCallback(db, cq, parsed, approver);
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
    await approveRefundRequest(
      db,
      parsed.requestId,
      managerUser,
      telegramReviewNote(managerUser),
      null,
      "telegram"
    );
    await answerCallbackQuery(cq.id, "تمت الموافقة", "refund");
    return { handled: true, action: "approve", requestId: parsed.requestId, kind: "refund" };
  }

  await rejectRefundRequest(
    db,
    parsed.requestId,
    managerUser,
    telegramReviewNote(managerUser),
    null,
    "telegram"
  );
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
    try {
      await approveOnAccountRequest(
        db,
        parsed.requestId,
        managerUser,
        telegramReviewNote(managerUser),
        null,
        "telegram"
      );
    } catch (e) {
      if (e.code === "CREDIT_LIMIT_EXCEEDED" || e.code === "CREDIT_BLOCKED") {
        await answerCallbackQuery(cq.id, "يتجاوز الحد — أكمل الاستثناء من المكتب", "zimma");
        return {
          handled: true,
          action: "needs_office_override",
          requestId: parsed.requestId,
          kind: "zimma",
        };
      }
      throw e;
    }
    await answerCallbackQuery(cq.id, "تمت الموافقة", "zimma");
    return { handled: true, action: "approve", requestId: parsed.requestId, kind: "zimma" };
  }

  await rejectOnAccountRequest(
    db,
    parsed.requestId,
    managerUser,
    telegramReviewNote(managerUser),
    null,
    "telegram"
  );
  await answerCallbackQuery(cq.id, "تم الرفض", "zimma");
  return { handled: true, action: "reject", requestId: parsed.requestId, kind: "zimma" };
}

async function handleCashDebtCallback(db, cq, parsed, managerUser) {
  const existing = await getCustomerCashDebtRequestById(db, parsed.requestId);
  if (!existing || existing.status !== "pending") {
    await answerCallbackQuery(cq.id, "تمت المعالجة مسبقاً", "cashdebt");
    if (existing?.telegram_message_id) {
      try {
        await editCashDebtMessageAlreadyHandled({
          messageId: existing.telegram_message_id,
          requestId: parsed.requestId,
          currentStatus: existing.status,
        });
      } catch (_) {}
    }
    return { handled: true, action: "already_handled", requestId: parsed.requestId, kind: "cashdebt" };
  }

  if (parsed.action === "approve") {
    try {
      await approveCustomerCashDebtRequest(
        db,
        parsed.requestId,
        managerUser,
        telegramReviewNote(managerUser),
        null,
        "telegram"
      );
    } catch (e) {
      if (e.code === "CREDIT_LIMIT_EXCEEDED" || e.code === "CREDIT_BLOCKED") {
        await answerCallbackQuery(cq.id, "يتجاوز الحد — أكمل الاستثناء من المكتب", "cashdebt");
        return {
          handled: true,
          action: "needs_office_override",
          requestId: parsed.requestId,
          kind: "cashdebt",
        };
      }
      throw e;
    }
    await answerCallbackQuery(cq.id, "تمت الموافقة", "cashdebt");
    return { handled: true, action: "approve", requestId: parsed.requestId, kind: "cashdebt" };
  }

  await rejectCustomerCashDebtRequest(
    db,
    parsed.requestId,
    managerUser,
    telegramReviewNote(managerUser),
    null,
    "telegram"
  );
  await answerCallbackQuery(cq.id, "تم الرفض", "cashdebt");
  return { handled: true, action: "reject", requestId: parsed.requestId, kind: "cashdebt" };
}

async function handleApprovalsCallback(db, cq, parsed) {
  if (!isApprovalsTelegramConfigured()) {
    await answerCallbackQuery(cq.id, "المجموعة غير مضبوطة", parsed.kind);
    return { handled: true, action: "denied", kind: parsed.kind, requestId: parsed.requestId };
  }
  const chatId = cq.message?.chat?.id;
  if (!isApprovalsGroupChat(chatId)) {
    await answerCallbackQuery(cq.id, "غير مسموح", parsed.kind);
    return { handled: true, action: "denied", kind: parsed.kind, requestId: parsed.requestId };
  }
  const fromId = cq.from?.id;
  let member = null;
  try {
    member = await fetchApprovalsChatMember(fromId);
  } catch (err) {
    await answerCallbackQuery(cq.id, "تعذّر التحقق من عضوية المجموعة", parsed.kind);
    return { handled: true, action: "denied", kind: parsed.kind, requestId: parsed.requestId };
  }
  if (!isActiveChatMember(member)) {
    await answerCallbackQuery(cq.id, "غير مسموح", parsed.kind);
    return { handled: true, action: "denied", kind: parsed.kind, requestId: parsed.requestId };
  }
  const telegramActor = {
    id: fromId == null ? "" : String(fromId),
    username: cq.from?.username || null,
  };
  const request =
    parsed.kind === "expense"
      ? await getExpenseApprovalRequestById(db, parsed.requestId)
      : parsed.kind === "consumption"
        ? await getShopConsumptionRequestById(db, parsed.requestId)
        : await getSupplierPaymentApprovalRequestById(db, parsed.requestId);
  const target = request
    ? {
        kind: parsed.kind,
        request_id: request.id,
        telegram_message_id: request.telegram_message_id,
        chat_id: String(cq.message?.chat?.id),
        bot_kind: "approvals",
      }
    : null;
  if (!request || !approvalsCallbackMatchesTarget(parsed, cq, target)) {
    await answerCallbackQuery(cq.id, "الرسالة لا تطابق الطلب", parsed.kind);
    return { handled: true, action: "mismatch", kind: parsed.kind, requestId: parsed.requestId };
  }
  if (request.status !== "pending") {
    await answerCallbackQuery(cq.id, "تمت المعالجة مسبقاً", parsed.kind);
    return { handled: true, action: "already_handled", kind: parsed.kind, requestId: parsed.requestId };
  }
  try {
    const actor = { telegramActor, decisionSource: "telegram" };
    if (parsed.kind === "expense") {
      if (parsed.action === "approve") await approveExpenseApprovalRequest(db, parsed.requestId, null, "telegram", actor);
      else await rejectExpenseApprovalRequest(db, parsed.requestId, null, "telegram", actor);
    } else if (parsed.kind === "consumption") {
      if (parsed.action === "approve") await approveShopConsumptionRequest(db, parsed.requestId, actor);
      else await rejectShopConsumptionRequest(db, parsed.requestId, actor);
    } else if (parsed.action === "approve") {
      await approveSupplierPaymentApprovalRequest(db, parsed.requestId, null, "telegram", null, actor);
    } else {
      await rejectSupplierPaymentApprovalRequest(db, parsed.requestId, null, "telegram", actor);
    }
  } catch (err) {
    if (err?.code === "ALREADY_HANDLED" || err?.action === "already_handled") {
      await answerCallbackQuery(cq.id, "تمت المعالجة مسبقاً", parsed.kind);
      return { handled: true, action: "already_handled", kind: parsed.kind, requestId: parsed.requestId };
    }
    throw err;
  }
  await answerCallbackQuery(cq.id, parsed.action === "approve" ? "تمت الموافقة" : "تم الرفض", parsed.kind);
  return {
    handled: true,
    action: parsed.action,
    kind: parsed.kind,
    requestId: parsed.requestId,
    telegramActorId: telegramActor.id,
  };
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
    await approveAdvanceRequest(
      db,
      parsed.requestId,
      managerUser,
      telegramReviewNote(managerUser),
      null,
      "telegram"
    );
    await answerCallbackQuery(cq.id, "تمت الموافقة", "sulaf");
    return { handled: true, action: "approve", requestId: parsed.requestId, kind: "sulaf" };
  }

  await rejectAdvanceRequest(
    db,
    parsed.requestId,
    managerUser,
    telegramReviewNote(managerUser),
    null,
    "telegram"
  );
  await answerCallbackQuery(cq.id, "تم الرفض", "sulaf");
  return { handled: true, action: "reject", requestId: parsed.requestId, kind: "sulaf" };
}
