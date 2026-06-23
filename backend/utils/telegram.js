const API_BASE = "https://api.telegram.org/bot";

function env(key) {
  return String(process.env[key] || "").trim();
}

function refundBotConfig() {
  return {
    token: env("TELEGRAM_REFUND_BOT_TOKEN") || env("TELEGRAM_BOT_TOKEN"),
    chatId: env("TELEGRAM_REFUND_CHAT_ID") || env("TELEGRAM_MANAGER_CHAT_ID"),
    webhookSecret: env("TELEGRAM_REFUND_WEBHOOK_SECRET") || env("TELEGRAM_WEBHOOK_SECRET"),
  };
}

function expiryBotConfig() {
  return {
    token: env("TELEGRAM_EXPIRY_BOT_TOKEN"),
    chatId: env("TELEGRAM_EXPIRY_CHAT_ID") || env("TELEGRAM_MANAGER_CHAT_ID"),
  };
}

export function getRefundWebhookSecret() {
  return refundBotConfig().webhookSecret;
}

export function getRefundBotToken() {
  return refundBotConfig().token;
}

/** Refund bot token + manager chat — enough for outbound refund notices. */
export function isRefundTelegramConfigured() {
  const { token, chatId } = refundBotConfig();
  return !!(token && chatId);
}

/** Refund webhook secret set — required for inline approve/reject buttons. */
export function isRefundWebhookConfigured() {
  const { webhookSecret } = refundBotConfig();
  return !!(isRefundTelegramConfigured() && webhookSecret);
}

/** Expiry bot token + manager chat — send-only expiry alerts. */
export function isExpiryTelegramConfigured() {
  const { token, chatId } = expiryBotConfig();
  return !!(token && chatId);
}

/** @deprecated alias — use isRefundTelegramConfigured */
export function isTelegramMessagingConfigured() {
  return isRefundTelegramConfigured();
}

/** @deprecated alias — use isRefundWebhookConfigured */
export function isTelegramWebhookConfigured() {
  return isRefundWebhookConfigured();
}

/** @deprecated alias — use isRefundWebhookConfigured */
export function isTelegramConfigured() {
  return isRefundWebhookConfigured();
}

function ils(n) {
  return `\u20AA${Number(n).toFixed(2)}`;
}

async function telegramRequest(method, body, token) {
  if (!token) throw new Error("Telegram bot token not configured");
  const res = await fetch(`${API_BASE}${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.description || `Telegram API error: ${method}`);
  }
  return data.result;
}

/** GET-style Telegram API call for refund bot (getUpdates, deleteWebhook). */
export async function refundTelegramGet(method, query = {}) {
  const token = getRefundBotToken();
  if (!token) throw new Error("Refund Telegram bot token not configured");
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  const url = `${API_BASE}${token}/${method}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.description || `Telegram API error: ${method}`);
  }
  return data.result;
}

export async function sendRefundApprovalMessage({
  requestId,
  cashierName,
  transactionId,
  total,
  reason,
}) {
  const { token, chatId } = refundBotConfig();
  const withButtons = isRefundWebhookConfigured();
  const text = [
    `طلب استرجاع #${requestId}`,
    `الكاشير: ${cashierName}`,
    `الفاتورة: #${transactionId}`,
    `المبلغ: ${ils(total)}`,
    reason ? `السبب: ${reason}` : null,
    "",
    withButtons ? "اختر موافقة أو رفض:" : "للموافقة أو الرفض: لوحة الإدارة → موافقات الاسترجاع",
  ]
    .filter(Boolean)
    .join("\n");

  const body = { chat_id: chatId, text };
  if (withButtons) {
    body.reply_markup = {
      inline_keyboard: [
        [
          { text: "✅ موافقة", callback_data: `refund:approve:${requestId}` },
          { text: "❌ رفض", callback_data: `refund:reject:${requestId}` },
        ],
      ],
    };
  }

  const result = await telegramRequest("sendMessage", body, token);
  return String(result.message_id);
}

const TELEGRAM_MAX_TEXT = 4096;

function chunkLines(lines, maxLen = TELEGRAM_MAX_TEXT - 50) {
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLen && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function formatDaysLabel(days) {
  if (days < 0) return `منتهي (${Math.abs(days)} يوم)`;
  if (days === 0) return "ينتهي اليوم";
  return `${days} يوم`;
}

export function buildExpiryAlertMessages({ products, batches }, daysThreshold) {
  const header = `⚠️ تنبيه صلاحية — أصناف تنتهي خلال ${daysThreshold} يوم`;
  const lines = [header, ""];

  if (products.length) {
    lines.push(`📦 أصناف (${products.length}):`);
    for (const r of products) {
      lines.push(
        `• ${r.name}${r.barcode ? ` (${r.barcode})` : ""} — ${formatDaysLabel(r.days_until_expiry)} — ${r.expiry_date} — مخزون ${r.stock}`
      );
    }
    lines.push("");
  }

  if (batches.length) {
    lines.push(`🏷️ دفعات (${batches.length}):`);
    for (const r of batches) {
      const batch = r.batch_no ? ` دفعة ${r.batch_no}` : "";
      lines.push(
        `• ${r.product_name}${batch} — ${formatDaysLabel(r.days_until_expiry)} — ${r.expiry_date} — كمية ${r.quantity}`
      );
    }
  }

  if (!products.length && !batches.length) return [];

  return chunkLines(lines);
}

export async function sendExpiryAlertMessages(messages) {
  const { token, chatId } = expiryBotConfig();
  const ids = [];
  for (const text of messages) {
    const result = await telegramRequest("sendMessage", { chat_id: chatId, text: String(text) }, token);
    ids.push(String(result.message_id));
  }
  return ids;
}

export async function editRefundRequestMessage({
  messageId,
  requestId,
  status,
  transactionId,
  total,
  approverName = null,
  decisionSource = null,
}) {
  const { token, chatId } = refundBotConfig();
  const statusAr =
    status === "approved" ? "✅ تمت الموافقة" : status === "rejected" ? "❌ مرفوض" : status;
  const sourceAr =
    decisionSource === "telegram"
      ? "تيليجرام"
      : decisionSource === "admin"
        ? "لوحة الإدارة"
        : null;
  const lines = [
    `طلب استرجاع #${requestId}`,
    `الفاتورة: #${transactionId}`,
    `المبلغ: ${ils(total)}`,
    "",
    statusAr,
  ];
  if (approverName) lines.push(`بواسطة: ${approverName}`);
  if (sourceAr) lines.push(`المصدر: ${sourceAr}`);

  await telegramRequest(
    "editMessageText",
    {
      chat_id: chatId,
      message_id: Number(messageId),
      text: lines.join("\n"),
      reply_markup: { inline_keyboard: [] },
    },
    token
  );
}

/** Follow-up status line in the refund group after an admin-panel decision. */
export async function sendRefundDecisionStatusMessage({
  requestId,
  status,
  transactionId,
  total,
  approverName,
  decisionSource = "admin",
}) {
  if (!isRefundTelegramConfigured()) return null;
  const { token, chatId } = refundBotConfig();
  const statusAr = status === "approved" ? "✅ تمت الموافقة" : "❌ مرفوض";
  const sourceAr = decisionSource === "telegram" ? "تيليجرام" : "لوحة الإدارة";
  const text = [
    `تحديث طلب استرجاع #${requestId}`,
    `الفاتورة: #${transactionId}`,
    `المبلغ: ${ils(total)}`,
    statusAr,
    approverName ? `بواسطة: ${approverName}` : null,
    `المصدر: ${sourceAr}`,
  ]
    .filter(Boolean)
    .join("\n");
  const result = await telegramRequest("sendMessage", { chat_id: chatId, text }, token);
  return result?.message_id ?? null;
}

export async function editRefundMessageAlreadyHandled({ messageId, requestId, currentStatus }) {
  const { token, chatId } = refundBotConfig();
  const statusAr =
    currentStatus === "approved"
      ? "✅ موافَق عليه مسبقاً"
      : currentStatus === "rejected"
        ? "❌ مرفوض مسبقاً"
        : "تمت المعالجة مسبقاً";
  await telegramRequest(
    "editMessageText",
    {
      chat_id: chatId,
      message_id: Number(messageId),
      text: `طلب استرجاع #${requestId}\n\n${statusAr}`,
      reply_markup: { inline_keyboard: [] },
    },
    token
  );
}

export async function answerCallbackQuery(callbackQueryId, text) {
  const { token } = refundBotConfig();
  await telegramRequest(
    "answerCallbackQuery",
    {
      callback_query_id: callbackQueryId,
      text: text || "",
      show_alert: !!text,
    },
    token
  );
}

export function parseRefundCallbackData(data) {
  if (typeof data !== "string") return null;
  const m = data.match(/^refund:(approve|reject):(\d+)$/);
  if (!m) return null;
  return { action: m[1], requestId: Number(m[2]) };
}

export function isManagerChat(chatId) {
  return String(chatId) === refundBotConfig().chatId;
}
