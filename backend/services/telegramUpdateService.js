import {
  parseApprovalCallbackData,
  answerCallbackQuery,
  editRefundMessageAlreadyHandled,
  editOnAccountMessageAlreadyHandled,
  editAdvanceMessageAlreadyHandled,
  editCashDebtMessageAlreadyHandled,
  isRefundTelegramConfigured,
  isZimmaTelegramConfigured,
  isSulafTelegramConfigured,
  isApprovalsTelegramConfigured,
  isConfiguredGroupChat,
  isActiveChatMember,
  fetchBotChatMember,
  callbackMatchesStoredMessage,
  telegramActorFromUser,
  observeApprovalsSetupCommand,
  logApprovalStage,
  telegramFailureLog,
} from "../utils/telegram.js";
import { telegramShiftHold } from "./originatingShiftDecision.js";
import {
  approveRefundRequest,
  rejectRefundRequest,
  getRefundRequestById,
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

function telegramReviewNote(actor) {
  const id = actor?.id;
  const name = actor?.name;
  if (!id) return null;
  return name ? `telegram:${id} (${name})` : `telegram:${id}`;
}

function telegramDecisionUser(actor) {
  return {
    id: null,
    username: actor?.name || null,
    role: null,
    telegram_user_id: actor?.id || null,
    telegram_actor_name: actor?.name || null,
  };
}

function fromIdForLog(cq) {
  return cq?.from?.id == null ? "" : String(cq.from.id);
}

async function answerQuiet(cq, text, kind, requestId) {
  try {
    await answerCallbackQuery(cq.id, text, kind);
  } catch (err) {
    console.error(
      `[telegram-approval] stage=answer_failed request=${requestId} kind=${kind} ${telegramFailureLog(err)}`
    );
  }
}

async function authorizeGroupCallback(cq, parsed) {
  const chatId = cq.message?.chat?.id;
  const fromId = cq.from?.id;
  logApprovalStage("callback", {
    request: parsed.requestId,
    kind: parsed.kind,
    action: parsed.action,
    from: fromIdForLog(cq),
  });
  if (!isConfiguredGroupChat(chatId, parsed.kind) || fromId == null || String(fromId).trim() === "") {
    logApprovalStage("denied", { request: parsed.requestId, kind: parsed.kind, reason: "chat_mismatch" });
    await answerQuiet(cq, "غير مسموح", parsed.kind, parsed.requestId);
    return {
      denied: true,
      result: { handled: true, action: "denied", kind: parsed.kind, requestId: parsed.requestId },
    };
  }
  let member = null;
  try {
    member = await fetchBotChatMember(parsed.kind, fromId);
  } catch (err) {
    logApprovalStage("membership_failed", {
      request: parsed.requestId,
      kind: parsed.kind,
      detail: telegramFailureLog(err),
    });
    await answerQuiet(cq, "تعذّر التحقق من عضوية المجموعة", parsed.kind, parsed.requestId);
    return {
      denied: true,
      result: { handled: true, action: "membership_failed", kind: parsed.kind, requestId: parsed.requestId },
    };
  }
  logApprovalStage("membership", {
    request: parsed.requestId,
    kind: parsed.kind,
    status: member?.status || "none",
  });
  if (!isActiveChatMember(member)) {
    logApprovalStage("denied", { request: parsed.requestId, kind: parsed.kind, reason: "not_member" });
    await answerQuiet(cq, "غير مسموح", parsed.kind, parsed.requestId);
    return {
      denied: true,
      result: { handled: true, action: "denied", kind: parsed.kind, requestId: parsed.requestId },
    };
  }
  return { denied: false, actor: telegramActorFromUser(cq.from) };
}

async function mismatchResult(cq, parsed) {
  logApprovalStage("mismatch", { request: parsed.requestId, kind: parsed.kind });
  await answerQuiet(cq, "الرسالة لا تطابق الطلب", parsed.kind, parsed.requestId);
  return { handled: true, action: "mismatch", kind: parsed.kind, requestId: parsed.requestId };
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

  const gate = await authorizeGroupCallback(cq, parsed);
  if (gate.denied) return gate.result;

  const approver = gate.actor;

  try {
    if (parsed.kind === "refund") {
      return await handleRefundCallback(db, cq, parsed, approver);
    }
    if (parsed.kind === "zimma") {
      return await handleZimmaCallback(db, cq, parsed, approver);
    }
    if (parsed.kind === "cashdebt") {
      return await handleCashDebtCallback(db, cq, parsed, approver);
    }
    if (parsed.kind === "sulaf") {
      return await handleSulafCallback(db, cq, parsed, approver);
    }
    return { handled: false };
  } catch (e) {
    const already = e?.code === "NOT_PENDING" || e?.code === "ALREADY_HANDLED" || /ليس قيد المراجعة|تمت المعالجة مسبقاً/.test(String(e?.message || ""));
    if (already) {
      await answerQuiet(cq, "تمت المعالجة مسبقاً", parsed.kind, parsed.requestId);
      return { handled: true, action: "already_handled", requestId: parsed.requestId, kind: parsed.kind };
    }
    console.error("Telegram update error:", e);
    await answerCallbackQuery(cq.id, e.message || "فشل المعالجة", parsed.kind);
    return { handled: true, action: "error", requestId: parsed.requestId, kind: parsed.kind };
  }
}

async function releaseIfShiftHeld(db, cq, shiftId, kind, requestId) {
  const hold = await telegramShiftHold(db, shiftId);
  if (!hold) return null;
  await answerCallbackQuery(cq.id, hold.alert, kind);
  return { handled: true, action: hold.action, requestId, kind };
}

async function handleRefundCallback(db, cq, parsed, actor) {
  const managerUser = telegramDecisionUser(actor);
  const existing = await getRefundRequestById(db, parsed.requestId);
  if (existing?.status === "pending" && !callbackMatchesStoredMessage(cq, existing.telegram_message_id, "refund")) {
    return mismatchResult(cq, parsed);
  }
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

  const refundHold = await releaseIfShiftHeld(db, cq, existing.shift_id, "refund", parsed.requestId);
  if (refundHold) return refundHold;

  if (parsed.action === "approve") {
    try {
      await approveRefundRequest(
        db,
        parsed.requestId,
        managerUser,
        telegramReviewNote(actor),
        null,
        "telegram"
      );
    } catch (e) {
      if (e?.code === "NOT_PENDING" || /ليس قيد المراجعة/.test(String(e?.message || ""))) {
        await answerQuiet(cq, "تمت المعالجة مسبقاً", "refund", parsed.requestId);
        return { handled: true, action: "already_handled", requestId: parsed.requestId, kind: "refund" };
      }
      throw e;
    }
    await answerCallbackQuery(cq.id, "تمت الموافقة", "refund");
    return { handled: true, action: "approve", requestId: parsed.requestId, kind: "refund" };
  }

  await rejectRefundRequest(
    db,
    parsed.requestId,
    managerUser,
    telegramReviewNote(actor),
    null,
    "telegram"
  );
  await answerCallbackQuery(cq.id, "تم الرفض", "refund");
  return { handled: true, action: "reject", requestId: parsed.requestId, kind: "refund" };
}

async function handleZimmaCallback(db, cq, parsed, actor) {
  const managerUser = telegramDecisionUser(actor);
  const existing = await getOnAccountRequestById(db, parsed.requestId);
  if (existing?.status === "pending" && !callbackMatchesStoredMessage(cq, existing.telegram_message_id, "zimma")) {
    return mismatchResult(cq, parsed);
  }
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

  const zimmaHold = await releaseIfShiftHeld(db, cq, existing.shift_id, "zimma", parsed.requestId);
  if (zimmaHold) return zimmaHold;

  if (parsed.action === "approve") {
    try {
      await approveOnAccountRequest(
        db,
        parsed.requestId,
        managerUser,
        telegramReviewNote(actor),
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
    telegramReviewNote(actor),
    null,
    "telegram"
  );
  await answerCallbackQuery(cq.id, "تم الرفض", "zimma");
  return { handled: true, action: "reject", requestId: parsed.requestId, kind: "zimma" };
}

async function handleCashDebtCallback(db, cq, parsed, actor) {
  const managerUser = telegramDecisionUser(actor);
  const existing = await getCustomerCashDebtRequestById(db, parsed.requestId);
  if (existing?.status === "pending" && !callbackMatchesStoredMessage(cq, existing.telegram_message_id, "cashdebt")) {
    return mismatchResult(cq, parsed);
  }
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

  const debtHold = await releaseIfShiftHeld(db, cq, existing.shift_id, "cashdebt", parsed.requestId);
  if (debtHold) return debtHold;

  if (parsed.action === "approve") {
    try {
      await approveCustomerCashDebtRequest(
        db,
        parsed.requestId,
        managerUser,
        telegramReviewNote(actor),
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
    telegramReviewNote(actor),
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
  const gate = await authorizeGroupCallback(cq, parsed);
  if (gate.denied) return gate.result;
  const telegramActor = gate.actor;
  const request =
    parsed.kind === "expense"
      ? await getExpenseApprovalRequestById(db, parsed.requestId)
      : parsed.kind === "consumption"
        ? await getShopConsumptionRequestById(db, parsed.requestId)
        : await getSupplierPaymentApprovalRequestById(db, parsed.requestId);
  if (!request || !callbackMatchesStoredMessage(cq, request.telegram_message_id, parsed.kind)) {
    return mismatchResult(cq, parsed);
  }
  if (request.status !== "pending") {
    logApprovalStage("already_handled", { request: parsed.requestId, kind: parsed.kind, status: request.status });
    await answerQuiet(cq, "تمت المعالجة مسبقاً", parsed.kind, parsed.requestId);
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
      logApprovalStage("already_handled", { request: parsed.requestId, kind: parsed.kind });
      await answerQuiet(cq, "تمت المعالجة مسبقاً", parsed.kind, parsed.requestId);
      return { handled: true, action: "already_handled", kind: parsed.kind, requestId: parsed.requestId };
    }
    logApprovalStage("post_failed", { request: parsed.requestId, kind: parsed.kind, detail: telegramFailureLog(err) });
    throw err;
  }
  logApprovalStage("posted", { request: parsed.requestId, kind: parsed.kind, action: parsed.action });
  await answerQuiet(cq, parsed.action === "approve" ? "تمت الموافقة" : "تم الرفض", parsed.kind, parsed.requestId);
  return {
    handled: true,
    action: parsed.action,
    kind: parsed.kind,
    requestId: parsed.requestId,
    telegramActorId: telegramActor.id,
  };
}

async function handleSulafCallback(db, cq, parsed, actor) {
  const managerUser = telegramDecisionUser(actor);
  const existing = await getAdvanceRequestById(db, parsed.requestId);
  if (existing?.status === "pending" && !callbackMatchesStoredMessage(cq, existing.telegram_message_id, "sulaf")) {
    return mismatchResult(cq, parsed);
  }
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

  const sulafHold = await releaseIfShiftHeld(db, cq, existing.shift_id, "sulaf", parsed.requestId);
  if (sulafHold) return sulafHold;

  if (parsed.action === "approve") {
    await approveAdvanceRequest(
      db,
      parsed.requestId,
      managerUser,
      telegramReviewNote(actor),
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
    telegramReviewNote(actor),
    null,
    "telegram"
  );
  await answerCallbackQuery(cq.id, "تم الرفض", "sulaf");
  return { handled: true, action: "reject", requestId: parsed.requestId, kind: "sulaf" };
}
