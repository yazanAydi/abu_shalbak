import { round2 } from "./money.js";
import { normalizeCheckoutNotes } from "./checkoutNotes.js";

const API_BASE = "https://api.telegram.org/bot";
const TELEGRAM_MAX_TEXT = 4096;

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

function zimmaBotConfig() {
  return {
    token: env("TELEGRAM_ZIMMA_BOT_TOKEN"),
    chatId: env("TELEGRAM_ZIMMA_CHAT_ID") || env("TELEGRAM_MANAGER_CHAT_ID"),
    webhookSecret: env("TELEGRAM_ZIMMA_WEBHOOK_SECRET"),
  };
}

function sulafBotConfig() {
  return {
    token: env("TELEGRAM_SULAF_BOT_TOKEN"),
    chatId: env("TELEGRAM_SULAF_CHAT_ID") || env("TELEGRAM_MANAGER_CHAT_ID"),
    webhookSecret: env("TELEGRAM_SULAF_WEBHOOK_SECRET"),
  };
}

function approvalsBotConfig() {
  return {
    token: env("TELEGRAM_APPROVALS_BOT_TOKEN"),
    chatId: env("TELEGRAM_APPROVALS_CHAT_ID"),
    webhookSecret: env("TELEGRAM_APPROVALS_WEBHOOK_SECRET"),
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

export function getZimmaWebhookSecret() {
  return zimmaBotConfig().webhookSecret;
}

export function getZimmaBotToken() {
  return zimmaBotConfig().token;
}

export function isZimmaTelegramConfigured() {
  const { token, chatId } = zimmaBotConfig();
  return !!(token && chatId);
}

export function isZimmaWebhookConfigured() {
  const { webhookSecret } = zimmaBotConfig();
  return !!(isZimmaTelegramConfigured() && webhookSecret);
}

export function getSulafWebhookSecret() {
  return sulafBotConfig().webhookSecret;
}

export function getSulafBotToken() {
  return sulafBotConfig().token;
}

export function isSulafTelegramConfigured() {
  const { token, chatId } = sulafBotConfig();
  return !!(token && chatId);
}

export function isSulafWebhookConfigured() {
  const { webhookSecret } = sulafBotConfig();
  return !!(isSulafTelegramConfigured() && webhookSecret);
}

export function getApprovalsWebhookSecret() {
  return approvalsBotConfig().webhookSecret;
}

export function getApprovalsBotToken() {
  return approvalsBotConfig().token;
}

export function getApprovalsChatId() {
  return approvalsBotConfig().chatId;
}

/** Token only — enough to poll /start while the group id is still empty. */
export function isApprovalsBotTokenConfigured() {
  return !!approvalsBotConfig().token;
}

/** Token + destination group. Required before any outbound approvals message. */
export function isApprovalsTelegramConfigured() {
  const { token, chatId } = approvalsBotConfig();
  return !!(token && chatId);
}

/** Bots with inline approve/reject buttons (for polling). */
export function getApprovalBotPollConfigs() {
  /** @type {{ kind: string, token: string, getUpdates: typeof refundTelegramGet }[]} */
  const bots = [];
  if (getRefundBotToken() && isRefundWebhookConfigured()) {
    bots.push({ kind: "refund", token: getRefundBotToken() });
  }
  if (getZimmaBotToken() && isZimmaWebhookConfigured()) {
    bots.push({ kind: "zimma", token: getZimmaBotToken() });
  }
  if (getSulafBotToken() && isSulafWebhookConfigured()) {
    bots.push({ kind: "sulaf", token: getSulafBotToken() });
  }
  if (isApprovalsBotTokenConfigured()) {
    bots.push({
      kind: "approvals",
      token: getApprovalsBotToken(),
      allowedUpdates: ["message", "callback_query"],
    });
  }
  return bots;
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

function formatRefundTelegramQty(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n)) return String(qty ?? "");
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

function formatRefundTelegramItemLine(item) {
  const name = String(item?.name || item?.product_name || "").trim() || "صنف";
  const qty = Number(item?.quantity);
  const qtyLabel = Number.isFinite(qty) ? formatRefundTelegramQty(qty) : String(item?.quantity ?? "");
  const unit = String(item?.unit_name || "").trim();
  const qtyPart = unit ? `${qtyLabel} ${unit}` : qtyLabel;
  const price = Number(item?.price) || 0;
  const lineTotal =
    item?.lineTotal != null && Number.isFinite(Number(item.lineTotal))
      ? Number(item.lineTotal)
      : round2((Number.isFinite(qty) ? qty : 0) * price);
  return `• ${name} × ${qtyPart} — ${ils(lineTotal)}`;
}

/** Plain-text refund item block for Telegram. Empty when there are no lines. */
export function formatRefundTelegramItemLines(items, options = {}) {
  const list = Array.isArray(items)
    ? items.filter((it) => it && (String(it.name || it.product_name || "").trim() || it.product_id))
    : [];
  if (!list.length) return [];

  const header = "الأصناف:";
  const formatted = list.map(formatRefundTelegramItemLine);
  const maxChars = options.maxChars;
  const all = [header, ...formatted];
  if (maxChars == null || all.join("\n").length <= maxChars) return all;

  const picked = [];
  for (let i = 0; i < formatted.length; i++) {
    const withLine = [header, ...picked, formatted[i]];
    const restCount = formatted.length - i - 1;
    const candidate = restCount > 0 ? [...withLine, `… و ${restCount} أصناف أخرى`] : withLine;
    if (candidate.join("\n").length <= maxChars) {
      picked.push(formatted[i]);
      continue;
    }
    const leftover = formatted.length - picked.length;
    const stop = [header, ...picked, `… و ${leftover} أصناف أخرى`];
    if (stop.join("\n").length <= maxChars) return stop;
    return picked.length ? [header, ...picked] : [`… و ${formatted.length} أصناف أخرى`];
  }
  return [header, ...picked];
}

function refundItemLinesForBudget(items, reservedChars) {
  return formatRefundTelegramItemLines(items, {
    maxChars: Math.max(0, TELEGRAM_MAX_TEXT - Math.max(0, reservedChars)),
  });
}

export function redactTelegramText(text) {
  return String(text || "")
    .replace(/https?:\/\/api\.telegram\.org\/bot[^\s"']+/gi, "https://api.telegram.org/bot<redacted>/…")
    .replace(/bot\d{6,}:[A-Za-z0-9_-]+/g, "bot<redacted>");
}

export class TelegramApiError extends Error {
  constructor(method, data) {
    const description = redactTelegramText(data?.description || `Telegram API error: ${method}`);
    super(description);
    this.name = "TelegramApiError";
    this.errorCode = data?.error_code ?? null;
    this.description = description;
    this.method = method;
  }
}

export function telegramFailureLog(err) {
  const code = err?.errorCode ?? err?.error_code ?? "";
  const description = redactTelegramText(err?.description || err?.message || err);
  return `error_code=${code || "none"} description=${description}`;
}

export function logApprovalStage(stage, fields = {}) {
  const parts = [`stage=${stage}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === "") continue;
    parts.push(`${key}=${redactTelegramText(value)}`);
  }
  console.log(`[telegram-approval] ${parts.join(" ")}`);
}

async function telegramRequest(method, body, token) {
  if (!token) throw new Error("Telegram bot token not configured");
  let data;
  try {
    const res = await fetch(`${API_BASE}${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    data = await res.json();
  } catch (err) {
    const wrapped = new Error(redactTelegramText(err?.message || err));
    wrapped.errorCode = null;
    throw wrapped;
  }
  if (!data.ok) throw new TelegramApiError(method, data);
  return data.result;
}

/** GET-style Telegram API call for a specific bot token. */
export async function telegramGet(method, query = {}, token) {
  if (!token) throw new Error("Telegram bot token not configured");
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  const url = `${API_BASE}${token}/${method}${qs ? `?${qs}` : ""}`;
  let data;
  try {
    const res = await fetch(url);
    data = await res.json();
  } catch (err) {
    const wrapped = new Error(redactTelegramText(err?.message || err));
    wrapped.errorCode = null;
    throw wrapped;
  }
  if (!data.ok) throw new TelegramApiError(method, data);
  return data.result;
}

/** GET-style Telegram API call for refund bot (getUpdates, deleteWebhook). */
export async function refundTelegramGet(method, query = {}) {
  return telegramGet(method, query, getRefundBotToken());
}

export async function sendRefundApprovalMessage({
  requestId,
  cashierName,
  transactionId,
  total,
  reason,
  items,
}) {
  const { token, chatId } = refundBotConfig();
  const withButtons = isRefundWebhookConfigured();
  const head = [
    `طلب استرجاع #${requestId}`,
    `الكاشير: ${cashierName}`,
    `الفاتورة: #${transactionId}`,
    `المبلغ: ${ils(total)}`,
    reason ? `السبب: ${reason}` : null,
  ].filter((line) => line != null && line !== "");
  const footer = withButtons ? "اختر موافقة أو رفض:" : "للموافقة أو الرفض: لوحة الإدارة → موافقات الاسترجاع";
  const reserved = [...head, footer].join("\n").length + 1;
  const text = [...head, ...refundItemLinesForBudget(items, reserved), footer].join("\n");

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

const EXPIRY_CONTINUATION_HEADER = "تتمة — تنبيه صلاحية";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatExpiryDateDisplay(ymd) {
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(ymd || "").trim();
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function arabicDayCountPhrase(n) {
  const abs = Math.abs(Math.trunc(Number(n) || 0));
  if (abs === 1) return "يوم";
  if (abs === 2) return "يومين";
  if (abs >= 3 && abs <= 10) return `${abs} أيام`;
  return `${abs} يوماً`;
}

function formatDaysLabel(days) {
  const d = Number(days);
  if (!Number.isFinite(d)) return "";
  if (d < 0) return `منتهي منذ ${arabicDayCountPhrase(Math.abs(d))}`;
  if (d === 0) return "ينتهي اليوم";
  return `ينتهي خلال ${arabicDayCountPhrase(d)}`;
}

function splitLinesIntoBlocks(lines) {
  const blocks = [];
  let buf = [];
  for (const line of lines) {
    if (line === "") {
      if (buf.length) {
        blocks.push(buf.join("\n"));
        buf = [];
      }
    } else {
      buf.push(line);
    }
  }
  if (buf.length) blocks.push(buf.join("\n"));
  return blocks;
}

/** Pack text blocks (blank-line separated) into Telegram-sized chunks. Continuation chunks get a short header. */
function chunkByBlankLines(lines, maxLen = TELEGRAM_MAX_TEXT - 50, continuationHeader = EXPIRY_CONTINUATION_HEADER) {
  const blocks = splitLinesIntoBlocks(lines);
  const chunks = [];
  let current = "";
  let isFirst = true;

  const maxForCurrent = () => (isFirst ? maxLen : maxLen - continuationHeader.length - 2);

  const commit = () => {
    if (!current) return;
    chunks.push(isFirst ? current : `${continuationHeader}\n\n${current}`);
    current = "";
    isFirst = false;
  };

  const appendBlock = (block) => {
    const next = current ? `${current}\n\n${block}` : block;
    if (next.length <= maxForCurrent()) {
      current = next;
      return;
    }
    commit();
    if (block.length <= maxForCurrent()) {
      current = block;
      return;
    }
    for (const line of String(block).split("\n")) {
      const lineNext = current ? `${current}\n${line}` : line;
      if (lineNext.length > maxForCurrent() && current) {
        commit();
        current = line;
      } else {
        current = lineNext;
      }
    }
  };

  for (const block of blocks) appendBlock(block);
  commit();
  return chunks;
}

function splitByUrgency(items) {
  const expired = [];
  const today = [];
  const upcoming = [];
  for (const item of items) {
    const d = Number(item.days_until_expiry);
    if (d < 0) expired.push(item);
    else if (d === 0) today.push(item);
    else upcoming.push(item);
  }
  return { expired, today, upcoming };
}

function formatProductCard(r) {
  const lines = [`<b>${escapeHtml(r.name || "")}</b>`];
  const date = formatExpiryDateDisplay(r.expiry_date);
  if (date) lines.push(`التاريخ: <code>${escapeHtml(date)}</code>`);
  const status = formatDaysLabel(r.days_until_expiry);
  if (status) lines.push(`الحالة: ${escapeHtml(status)}`);
  if (r.stock != null && r.stock !== "") lines.push(`المخزون: ${escapeHtml(r.stock)}`);
  const barcode = String(r.barcode || "").trim();
  if (barcode) lines.push(`الباركود: <code>${escapeHtml(barcode)}</code>`);
  return lines;
}

function formatBatchCard(r) {
  const lines = [`<b>${escapeHtml(r.product_name || "")}</b>`];
  const date = formatExpiryDateDisplay(r.expiry_date);
  if (date) lines.push(`التاريخ: <code>${escapeHtml(date)}</code>`);
  const status = formatDaysLabel(r.days_until_expiry);
  if (status) lines.push(`الحالة: ${escapeHtml(status)}`);
  if (r.quantity != null && r.quantity !== "") lines.push(`الكمية: ${escapeHtml(r.quantity)}`);
  const batchNo = String(r.batch_no || "").trim();
  if (batchNo) lines.push(`الدفعة: ${escapeHtml(batchNo)}`);
  const barcode = String(r.barcode || "").trim();
  if (barcode) lines.push(`الباركود: <code>${escapeHtml(barcode)}</code>`);
  return lines;
}

function pushUrgencyGroups(lines, items, formatItem) {
  const { expired, today, upcoming } = splitByUrgency(items);
  const groups = [
    { title: `منتهي (${expired.length})`, items: expired },
    { title: `ينتهي اليوم (${today.length})`, items: today },
    { title: `ينتهي قريباً (${upcoming.length})`, items: upcoming },
  ];
  for (const group of groups) {
    if (!group.items.length) continue;
    lines.push(group.title);
    lines.push("");
    for (const item of group.items) {
      lines.push(...formatItem(item));
      lines.push("");
    }
  }
}

export function buildExpiryAlertMessages({ products, batches }, daysThreshold, options = {}) {
  const productList = Array.isArray(products) ? products : [];
  const batchList = Array.isArray(batches) ? batches : [];
  if (!productList.length && !batchList.length) return [];

  const header =
    options.title ??
    `⚠️ تنبيه صلاحية — أصناف تنتهي خلال ${daysThreshold} يوم`;
  const lines = [header, ""];

  const countParts = [];
  if (productList.length) countParts.push(`${productList.length} صنف`);
  if (batchList.length) countParts.push(`${batchList.length} دفعة`);
  lines.push(countParts.join(" · "));
  lines.push("");

  if (productList.length) {
    lines.push(`📦 أصناف (${productList.length}):`);
    lines.push("");
    pushUrgencyGroups(lines, productList, formatProductCard);
  }

  if (batchList.length) {
    lines.push(`🏷️ دفعات (${batchList.length}):`);
    lines.push("");
    pushUrgencyGroups(lines, batchList, formatBatchCard);
  }

  return chunkByBlankLines(lines);
}

export async function sendExpiryAlertMessages(messages) {
  const { token, chatId } = expiryBotConfig();
  const ids = [];
  for (const text of messages) {
    const result = await telegramRequest(
      "sendMessage",
      { chat_id: chatId, text: String(text), parse_mode: "HTML" },
      token
    );
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
  items,
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
  const head = [
    `طلب استرجاع #${requestId}`,
    `الفاتورة: #${transactionId}`,
    `المبلغ: ${ils(total)}`,
  ];
  const tail = [statusAr];
  if (approverName) tail.push(`بواسطة: ${approverName}`);
  if (sourceAr) tail.push(`المصدر: ${sourceAr}`);
  const reserved = [...head, "", ...tail].join("\n").length + 1;
  const lines = [...head, ...refundItemLinesForBudget(items, reserved), "", ...tail];

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

export async function answerCallbackQuery(callbackQueryId, text, botKind = "refund") {
  const kind = approvalBotKind(botKind);
  const token =
    kind === "approvals"
      ? getApprovalsBotToken()
      : kind === "zimma"
        ? getZimmaBotToken()
        : kind === "sulaf"
          ? getSulafBotToken()
          : getRefundBotToken();
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
  return { kind: "refund", action: m[1], requestId: Number(m[2]) };
}

export function parseZimmaCallbackData(data) {
  if (typeof data !== "string") return null;
  const m = data.match(/^zimma:(approve|reject):(\d+)$/);
  if (!m) return null;
  return { kind: "zimma", action: m[1], requestId: Number(m[2]) };
}

export function parseSulafCallbackData(data) {
  if (typeof data !== "string") return null;
  const m = data.match(/^sulaf:(approve|reject):(\d+)$/);
  if (!m) return null;
  return { kind: "sulaf", action: m[1], requestId: Number(m[2]) };
}

export function parseCashDebtCallbackData(data) {
  if (typeof data !== "string") return null;
  const m = data.match(/^cashdebt:(approve|reject):(\d+)$/);
  if (!m) return null;
  return { kind: "cashdebt", action: m[1], requestId: Number(m[2]) };
}

export function parseApprovalCallbackData(data) {
  return (
    parseRefundCallbackData(data) ||
    parseZimmaCallbackData(data) ||
    parseCashDebtCallbackData(data) ||
    parseSulafCallbackData(data) ||
    parseApprovalsCallbackData(data)
  );
}

function approvalBotKind(botKind) {
  if (botKind === "expense" || botKind === "supplier" || botKind === "consumption" || botKind === "approvals") return "approvals";
  if (botKind === "zimma" || botKind === "cashdebt") return "zimma";
  if (botKind === "sulaf") return "sulaf";
  return "refund";
}

const APPROVALS_START_RE = /^\/start@AbuShalbakApprovalsBot(?:\s|$)/i;

/**
 * Notice a group /start for @AbuShalbakApprovalsBot.
 * Returns the chat id to copy into TELEGRAM_APPROVALS_CHAT_ID.
 * Does not write configuration and does not authorize the sender.
 */
export function observeApprovalsSetupCommand(message) {
  const text = String(message?.text || "").trim();
  if (!APPROVALS_START_RE.test(text)) return null;
  const chat = message?.chat || {};
  if (chat.type !== "group" && chat.type !== "supergroup") {
    return { ignored: true, reason: "not_group", authorized: false };
  }
  return {
    ignored: false,
    chatId: chat.id == null ? "" : String(chat.id),
    fromId: message?.from?.id == null ? "" : String(message.from.id),
    username: message?.from?.username || null,
    authorized: false,
  };
}

export function parseApprovalsCallbackData(data) {
  if (typeof data !== "string") return null;
  const m = data.match(/^(expense|supplier|consumption):(approve|reject):(\d+)$/);
  if (!m) return null;
  return { kind: m[1], action: m[2], requestId: Number(m[3]) };
}

/**
 * Telegram guarantees getChatMember only when the bot is a group administrator.
 * No extra admin rights are required. Privacy mode can stay enabled.
 * Current members: creator, administrator, member, or restricted with is_member.
 */
export function isActiveChatMember(member) {
  if (!member || typeof member !== "object") return false;
  if (member.status === "creator" || member.status === "administrator" || member.status === "member") {
    return true;
  }
  if (member.status === "restricted") return member.is_member === true;
  return false;
}

export function botConfigForKind(botKind) {
  const kind = approvalBotKind(botKind);
  if (kind === "approvals") return approvalsBotConfig();
  if (kind === "zimma") return zimmaBotConfig();
  if (kind === "sulaf") return sulafBotConfig();
  return refundBotConfig();
}

export function isConfiguredGroupChat(chatId, botKind = "refund") {
  const expected = botConfigForKind(botKind).chatId;
  return !!expected && String(chatId) === String(expected);
}

export async function fetchBotChatMember(botKind, userId, get = telegramGet) {
  const { token, chatId } = botConfigForKind(botKind);
  if (!token || !chatId || userId == null || String(userId).trim() === "") return null;
  return get("getChatMember", { chat_id: chatId, user_id: String(userId) }, token);
}

export async function fetchApprovalsChatMember(userId, get = telegramGet) {
  return fetchBotChatMember("approvals", userId, get);
}

export function isApprovalsGroupChat(chatId) {
  return isConfiguredGroupChat(chatId, "approvals");
}

/** Display name for the person who tapped the button: full name, then @username, then id. */
export function telegramActorFromUser(from) {
  const id = from?.id == null ? "" : String(from.id);
  const full = [from?.first_name, from?.last_name]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
  const username = from?.username ? `@${String(from.username).replace(/^@/, "")}` : "";
  return {
    id,
    username: from?.username ? String(from.username).replace(/^@/, "") : null,
    name: full || username || id,
  };
}

/** The button must be the original message in this bot's configured group. */
export function callbackMatchesStoredMessage(callbackQuery, storedMessageId, botKind) {
  const message = callbackQuery?.message;
  if (!message || storedMessageId == null || String(storedMessageId).trim() === "") return false;
  return (
    String(message.message_id) === String(storedMessageId) &&
    isConfiguredGroupChat(message.chat?.id, botKind)
  );
}

export function approvalsCallbackMatchesTarget(parsed, callbackQuery, target) {
  if (!parsed || !target) return false;
  const message = callbackQuery?.message;
  return (
    String(target.kind) === parsed.kind &&
    Number(target.request_id) === Number(parsed.requestId) &&
    String(target.telegram_message_id) === String(message?.message_id) &&
    String(target.chat_id) === String(message?.chat?.id) &&
    String(target.bot_kind || "approvals") === "approvals"
  );
}

export async function sendApprovalsConnectionTest(send = telegramRequest) {
  const { token, chatId } = approvalsBotConfig();
  if (!token || !chatId) {
    const err = new Error("Approvals bot token or group chat id is not configured");
    err.code = "APPROVALS_NOT_CONFIGURED";
    throw err;
  }
  const text = [
    "اختبار اتصال — AbuShalbakApprovalsBot",
    "هذه رسالة فحص للبوت فقط.",
    "لم يُنشأ أي مصروف أو دفعة مورد أو حركة مالية.",
  ].join("\n");
  return send("sendMessage", { chat_id: chatId, text }, token);
}

function approvalsButtons(prefix, requestId) {
  return buildApprovalKeyboard(prefix, requestId, isApprovalsTelegramConfigured());
}

export async function sendExpenseApprovalMessage({
  requestId,
  requesterName,
  categoryName,
  amount,
  paidOn,
  paymentMethod,
  note,
}) {
  const { token, chatId } = approvalsBotConfig();
  const text = [
    `طلب مصروف #${requestId}`,
    `مقدم الطلب: ${requesterName}`,
    `الفئة: ${categoryName}`,
    `المبلغ: ${ils(amount)}`,
    `التاريخ: ${paidOn}`,
    `الدفع: ${paymentMethod}`,
    note ? `ملاحظة: ${note}` : null,
    "",
    "اختر موافقة أو رفض:",
  ]
    .filter((line) => line != null)
    .join("\n");
  const body = { chat_id: chatId, text };
  const markup = approvalsButtons("expense", requestId);
  if (markup) body.reply_markup = markup;
  const result = await telegramRequest("sendMessage", body, token);
  return String(result.message_id);
}

export async function sendSupplierPaymentApprovalMessage({
  requestId,
  cashierName,
  supplierName,
  amount,
  shiftId,
  notes,
  forgotten = false,
}) {
  const { token, chatId } = approvalsBotConfig();
  const text = [
    `طلب دفع لمورد #${requestId}`,
    `الكاشير: ${cashierName}`,
    `المورد: ${supplierName}`,
    `المبلغ: ${ils(amount)}`,
    `الوردية: #${shiftId}`,
    forgotten ? "تسجيل دفعة سابقة أثناء عد الصندوق. ليست تعليمات بالدفع مرة أخرى." : null,
    notes ? `ملاحظة: ${notes}` : null,
    "",
    "اختر موافقة أو رفض. لا يُصرف النقد قبل الموافقة.",
  ]
    .filter((line) => line != null)
    .join("\n");
  const body = { chat_id: chatId, text };
  const markup = approvalsButtons("supplier", requestId);
  if (markup) body.reply_markup = markup;
  const result = await telegramRequest("sendMessage", body, token);
  return String(result.message_id);
}

export async function sendShopConsumptionApprovalMessage({
  requestId,
  cashierName,
  totalCost,
  lineCount,
  reason,
}) {
  const { token, chatId } = approvalsBotConfig();
  const text = [
    `طلب مصاريف محل #${requestId}`,
    `الكاشير: ${cashierName}`,
    `عدد الأصناف: ${lineCount}`,
    `التكلفة: ${ils(totalCost)}`,
    reason ? `السبب: ${reason}` : null,
    "",
    "الموافقة تخصم المخزون بالتكلفة وتسجّل مصروفاً بلا حركة صندوق.",
  ]
    .filter((line) => line != null)
    .join("\n");
  const body = { chat_id: chatId, text };
  const markup = approvalsButtons("consumption", requestId);
  if (markup) body.reply_markup = markup;
  const result = await telegramRequest("sendMessage", body, token);
  return String(result.message_id);
}

export async function editGroupApprovalMessage({ kind, messageId, requestId, status, approverName }) {
  const { token, chatId } = approvalsBotConfig();
  const title =
    kind === "expense" ? "طلب مصروف" : kind === "consumption" ? "طلب مصاريف محل" : "طلب دفع لمورد";
  const statusAr = status === "approved" ? "✅ تمت الموافقة" : "❌ مرفوض";
  await telegramRequest(
    "editMessageText",
    {
      chat_id: chatId,
      message_id: Number(messageId),
      text: `${title} #${requestId}\n\n${statusAr}${approverName ? `\nبواسطة: ${approverName}` : ""}`,
      reply_markup: { inline_keyboard: [] },
    },
    token
  );
}

export function isManagerChat(chatId, botKind = "refund") {
  return isConfiguredGroupChat(chatId, botKind);
}

function buildApprovalKeyboard(prefix, requestId, withButtons) {
  if (!withButtons) return undefined;
  return {
    inline_keyboard: [
      [
        { text: "✅ موافقة", callback_data: `${prefix}:approve:${requestId}` },
        { text: "❌ رفض", callback_data: `${prefix}:reject:${requestId}` },
      ],
    ],
  };
}

function zimmaPartyLines({ customerName, employeeName }) {
  const lines = [];
  if (employeeName) lines.push(`الموظف: ${employeeName}`);
  if (customerName) lines.push(`العميل: ${customerName}`);
  return lines;
}

function zimmaNotesLine(notes) {
  const text = normalizeCheckoutNotes(notes);
  return text ? `ملاحظات: ${text}` : null;
}

/** Cart lines stored on an on-account request, shaped for Telegram item formatting. */
export function onAccountTelegramItems(snapshot) {
  let parsed = snapshot;
  if (typeof snapshot === "string") {
    try {
      parsed = JSON.parse(snapshot);
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== "object") return [];
  const normalized = Array.isArray(parsed.normalized) ? parsed.normalized : [];
  const detailed = Array.isArray(parsed.detailed) ? parsed.detailed : [];
  if (normalized.length) {
    return normalized.map((line, i) => ({
      name: line?.name,
      quantity: line?.quantity,
      unit_name: line?.unit_name,
      price: line?.price,
      lineTotal: detailed[i]?.lineGross,
    }));
  }
  const items = Array.isArray(parsed.itemsForJson) ? parsed.itemsForJson : [];
  return items.map((line) => ({
    name: line?.name,
    quantity: line?.quantity,
    unit_name: line?.unit_name,
    price: line?.price,
  }));
}

function composeZimmaText(head, items, tail) {
  const headLines = head.filter((line) => line != null && line !== "");
  const tailLines = tail.filter((line) => line != null && line !== "");
  const reserved = [...headLines, "", ...tailLines].join("\n").length + 1;
  const itemLines = refundItemLinesForBudget(items, reserved);
  const lines = [...headLines];
  if (itemLines.length) lines.push(...itemLines);
  if (tailLines.length) {
    if (itemLines.length || headLines.length) lines.push("");
    lines.push(...tailLines);
  }
  return lines;
}

export async function sendOnAccountApprovalMessage({
  requestId,
  cashierName,
  customerName,
  employeeName = null,
  onAccountAmount,
  total,
  notes = null,
  items = null,
}) {
  const { token, chatId } = zimmaBotConfig();
  const withButtons = isZimmaWebhookConfigured();
  const text = composeZimmaText(
    [
      `طلب بيع على الذمة #${requestId}`,
      `الكاشير: ${cashierName}`,
      ...zimmaPartyLines({ customerName, employeeName }),
      `مبلغ الذمة: ${ils(onAccountAmount)}`,
      `إجمالي الفاتورة: ${ils(total)}`,
      zimmaNotesLine(notes),
    ],
    items,
    [withButtons ? "اختر موافقة أو رفض:" : "للموافقة أو الرفض: لوحة الإدارة → موافقات الذمة"]
  ).join("\n");
  const body = { chat_id: chatId, text };
  const markup = buildApprovalKeyboard("zimma", requestId, withButtons);
  if (markup) body.reply_markup = markup;
  const result = await telegramRequest("sendMessage", body, token);
  return String(result.message_id);
}

export async function sendCashDebtApprovalMessage({
  requestId,
  cashierName,
  shiftId,
  customerName,
  amount,
  debtBefore,
  projectedDebt,
  notes = null,
}) {
  const { token, chatId } = zimmaBotConfig();
  const withButtons = isZimmaWebhookConfigured();
  const text = [
    `طلب ذمة نقدية لعميل #${requestId}`,
    `العميل: ${customerName}`,
    `المبلغ: ${ils(amount)}`,
    `الكاشير: ${cashierName}`,
    `الوردية: #${shiftId}`,
    debtBefore != null ? `الذمة الحالية: ${ils(debtBefore)}` : null,
    projectedDebt != null ? `الذمة بعد الموافقة: ${ils(projectedDebt)}` : null,
    notes ? `ملاحظات: ${notes}` : null,
    "",
    withButtons ? "اختر موافقة أو رفض:" : "للموافقة أو الرفض: لوحة الإدارة → موافقات الذمة",
  ]
    .filter((line) => line != null)
    .join("\n");
  const body = { chat_id: chatId, text };
  const markup = buildApprovalKeyboard("cashdebt", requestId, withButtons);
  if (markup) body.reply_markup = markup;
  const result = await telegramRequest("sendMessage", body, token);
  return String(result.message_id);
}

export async function editCashDebtRequestMessage({
  messageId,
  requestId,
  status,
  customerName,
  amount,
  approverName = null,
  decisionSource = null,
  notes = null,
}) {
  const statusAr =
    status === "approved" ? "✅ تمت الموافقة" : status === "rejected" ? "❌ مرفوض" : status;
  const sourceAr =
    decisionSource === "telegram" ? "تيليجرام" : decisionSource === "admin" ? "لوحة الإدارة" : null;
  const lines = [
    `طلب ذمة نقدية لعميل #${requestId}`,
    `العميل: ${customerName}`,
    `المبلغ: ${ils(amount)}`,
    notes ? `ملاحظات: ${notes}` : null,
    "",
    statusAr,
  ].filter((line) => line != null);
  if (approverName) lines.push(`بواسطة: ${approverName}`);
  if (sourceAr) lines.push(`المصدر: ${sourceAr}`);
  await editApprovalMessage({ botKind: "cashdebt", messageId, lines });
}

export async function sendCashDebtDecisionStatusMessage({
  requestId,
  status,
  customerName,
  amount,
  approverName,
  decisionSource = "admin",
  notes = null,
}) {
  if (!isZimmaTelegramConfigured()) return null;
  const { token, chatId } = zimmaBotConfig();
  const statusAr = status === "approved" ? "✅ تمت الموافقة" : "❌ مرفوض";
  const sourceAr = decisionSource === "telegram" ? "تيليجرام" : "لوحة الإدارة";
  const text = [
    `تحديث طلب ذمة نقدية لعميل #${requestId}`,
    `العميل: ${customerName}`,
    `المبلغ: ${ils(amount)}`,
    notes ? `ملاحظات: ${notes}` : null,
    statusAr,
    approverName ? `بواسطة: ${approverName}` : null,
    `المصدر: ${sourceAr}`,
  ]
    .filter((line) => line != null)
    .join("\n");
  const result = await telegramRequest("sendMessage", { chat_id: chatId, text }, token);
  return result?.message_id ?? null;
}

export async function editCashDebtMessageAlreadyHandled({ messageId, requestId, currentStatus }) {
  const { token, chatId } = zimmaBotConfig();
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
      text: `طلب ذمة نقدية لعميل #${requestId}\n\n${statusAr}`,
      reply_markup: { inline_keyboard: [] },
    },
    token
  );
}

export async function sendAdvanceApprovalMessage({
  requestId,
  cashierName,
  employeeName,
  amount,
  notes,
}) {
  const { token, chatId } = sulafBotConfig();
  const withButtons = isSulafWebhookConfigured();
  const text = [
    `طلب سلف #${requestId}`,
    `الكاشير: ${cashierName}`,
    `الموظف: ${employeeName}`,
    `المبلغ: ${ils(amount)}`,
    notes ? `ملاحظات: ${notes}` : null,
    "",
    withButtons ? "اختر موافقة أو رفض:" : "للموافقة أو الرفض: لوحة الإدارة → موافقات السلف",
  ]
    .filter(Boolean)
    .join("\n");
  const body = { chat_id: chatId, text };
  const markup = buildApprovalKeyboard("sulaf", requestId, withButtons);
  if (markup) body.reply_markup = markup;
  const result = await telegramRequest("sendMessage", body, token);
  return String(result.message_id);
}

async function editApprovalMessage({ botKind, messageId, lines }) {
  const kind = approvalBotKind(botKind);
  const config =
    kind === "zimma" ? zimmaBotConfig() : kind === "sulaf" ? sulafBotConfig() : refundBotConfig();
  await telegramRequest(
    "editMessageText",
    {
      chat_id: config.chatId,
      message_id: Number(messageId),
      text: lines.join("\n"),
      reply_markup: { inline_keyboard: [] },
    },
    config.token
  );
}

export async function editOnAccountRequestMessage({
  messageId,
  requestId,
  status,
  customerName,
  employeeName = null,
  onAccountAmount,
  total,
  transactionId,
  approverName = null,
  decisionSource = null,
  notes = null,
  items = null,
}) {
  const statusAr =
    status === "approved" ? "✅ تمت الموافقة" : status === "rejected" ? "❌ مرفوض" : status;
  const sourceAr =
    decisionSource === "telegram" ? "تيليجرام" : decisionSource === "admin" ? "لوحة الإدارة" : null;
  const tail = [statusAr];
  if (approverName) tail.push(`بواسطة: ${approverName}`);
  if (sourceAr) tail.push(`المصدر: ${sourceAr}`);
  const lines = composeZimmaText(
    [
      `طلب بيع على الذمة #${requestId}`,
      ...zimmaPartyLines({ customerName, employeeName }),
      `مبلغ الذمة: ${ils(onAccountAmount)}`,
      `إجمالي الفاتورة: ${ils(total)}`,
      zimmaNotesLine(notes),
      transactionId ? `الفاتورة: #${transactionId}` : null,
    ],
    items,
    tail
  );
  await editApprovalMessage({ botKind: "zimma", messageId, lines });
}

export async function editAdvanceRequestMessage({
  messageId,
  requestId,
  status,
  employeeName,
  amount,
  approverName = null,
  decisionSource = null,
}) {
  const statusAr =
    status === "approved" ? "✅ تمت الموافقة" : status === "rejected" ? "❌ مرفوض" : status;
  const sourceAr =
    decisionSource === "telegram" ? "تيليجرام" : decisionSource === "admin" ? "لوحة الإدارة" : null;
  const lines = [
    `طلب سلف #${requestId}`,
    `الموظف: ${employeeName}`,
    `المبلغ: ${ils(amount)}`,
    "",
    statusAr,
  ];
  if (approverName) lines.push(`بواسطة: ${approverName}`);
  if (sourceAr) lines.push(`المصدر: ${sourceAr}`);
  await editApprovalMessage({ botKind: "sulaf", messageId, lines });
}

export async function sendOnAccountDecisionStatusMessage({
  requestId,
  status,
  customerName,
  employeeName = null,
  onAccountAmount,
  total,
  transactionId,
  approverName,
  decisionSource = "admin",
  notes = null,
  items = null,
}) {
  if (!isZimmaTelegramConfigured()) return null;
  const { token, chatId } = zimmaBotConfig();
  const statusAr = status === "approved" ? "✅ تمت الموافقة" : "❌ مرفوض";
  const sourceAr = decisionSource === "telegram" ? "تيليجرام" : "لوحة الإدارة";
  const text = composeZimmaText(
    [
      `تحديث طلب ذمة #${requestId}`,
      ...zimmaPartyLines({ customerName, employeeName }),
      `مبلغ الذمة: ${ils(onAccountAmount)}`,
      zimmaNotesLine(notes),
      transactionId ? `الفاتورة: #${transactionId}` : null,
    ],
    items,
    [statusAr, approverName ? `بواسطة: ${approverName}` : null, `المصدر: ${sourceAr}`]
  ).join("\n");
  const result = await telegramRequest("sendMessage", { chat_id: chatId, text }, token);
  return result?.message_id ?? null;
}

export async function sendAdvanceDecisionStatusMessage({
  requestId,
  status,
  employeeName,
  amount,
  approverName,
  decisionSource = "admin",
}) {
  if (!isSulafTelegramConfigured()) return null;
  const { token, chatId } = sulafBotConfig();
  const statusAr = status === "approved" ? "✅ تمت الموافقة" : "❌ مرفوض";
  const sourceAr = decisionSource === "telegram" ? "تيليجرام" : "لوحة الإدارة";
  const text = [
    `تحديث طلب سلف #${requestId}`,
    `الموظف: ${employeeName}`,
    `المبلغ: ${ils(amount)}`,
    statusAr,
    approverName ? `بواسطة: ${approverName}` : null,
    `المصدر: ${sourceAr}`,
  ]
    .filter(Boolean)
    .join("\n");
  const result = await telegramRequest("sendMessage", { chat_id: chatId, text }, token);
  return result?.message_id ?? null;
}

export async function editOnAccountMessageAlreadyHandled({ messageId, requestId, currentStatus }) {
  const { token, chatId } = zimmaBotConfig();
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
      text: `طلب بيع على الذمة #${requestId}\n\n${statusAr}`,
      reply_markup: { inline_keyboard: [] },
    },
    token
  );
}

export async function editAdvanceMessageAlreadyHandled({ messageId, requestId, currentStatus }) {
  const { token, chatId } = sulafBotConfig();
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
      text: `طلب سلف #${requestId}\n\n${statusAr}`,
      reply_markup: { inline_keyboard: [] },
    },
    token
  );
}
