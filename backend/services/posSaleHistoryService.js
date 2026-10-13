import { canViewReports } from "../utils/roles.js";
import { HttpError } from "../utils/httpError.js";
import { round2 } from "../utils/money.js";
import { loadSalePayments } from "../utils/salePayments.js";
import {
  TX_BUSINESS_DAY_JOIN,
  businessDayRangeClause,
  businessDayRangeParams,
  shopBusinessDayYmd,
} from "../utils/businessDay.js";
import { formatShopWall } from "../utils/shopTime.js";
import { buildSaleSummary } from "../utils/saleSummary.js";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function ymdOrThrow(value, label) {
  if (value == null || String(value).trim() === "") return null;
  const ymd = String(value).trim();
  if (!YMD_RE.test(ymd)) {
    throw new HttpError(400, `${label} غير صالح`, "VALIDATION_ERROR");
  }
  return ymd;
}

function likeContains(raw) {
  return `%${String(raw).trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function resolveHistoryCashierId(user, requested) {
  const selfId = Number(user?.id);
  if (!selfId) throw new HttpError(401, "غير مصرّح", "UNAUTHORIZED");
  if (!canViewReports(user.role)) {
    if (requested != null && requested !== "" && Number(requested) !== selfId) {
      throw new HttpError(403, "لا يمكن عرض فواتير كاشير آخر", "FORBIDDEN");
    }
    return selfId;
  }
  if (requested == null || requested === "") return selfId;
  const id = Number(requested);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, "معرّف الكاشير غير صالح", "VALIDATION_ERROR");
  }
  return id;
}

function parsePositiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function localStamp(createdAt) {
  const wall = formatShopWall(createdAt);
  if (!wall) return null;
  return { date: wall.date, time: wall.time, dateTime: wall.dateTime, time_zone: "Asia/Hebron" };
}

function saleState({ status, fullyRefunded, approvedRefunds, pendingReturns }) {
  const st = String(status || "completed").trim().toLowerCase();
  if (st === "voided" || st === "cancelled" || st === "canceled") {
    return { code: "cancelled", label: "ملغاة" };
  }
  if (st && st !== "completed") {
    return { code: "other", label: "غير مكتملة" };
  }
  if (fullyRefunded && approvedRefunds > 0) return { code: "returned", label: "مرتجعة" };
  if (fullyRefunded && pendingReturns > 0) return { code: "return_pending", label: "استرجاع قيد المراجعة" };
  if (approvedRefunds > 0) return { code: "partial_return", label: "مرتجعة جزئياً" };
  if (pendingReturns > 0) return { code: "return_pending", label: "استرجاع قيد المراجعة" };
  return { code: "completed", label: "مكتملة" };
}

function storedRefundLines(itemsJson) {
  let arr;
  try {
    arr = JSON.parse(itemsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((it) => ({
    name: it?.name || "",
    unit_name: it?.unit_name || null,
    quantity: Number(it?.quantity) || 0,
    unit_price: it?.price != null ? round2(Number(it.price) || 0) : null,
  }));
}

async function refundAggregates(db, ids) {
  const approved = new Map();
  const pending = new Map();
  if (!ids.length) return { approved, pending };
  const ph = ids.map(() => "?").join(",");
  const refundRows = await db.all(
    `SELECT original_transaction_id AS transaction_id, COUNT(*) AS n
     FROM refunds
     WHERE status = 'approved' AND original_transaction_id IN (${ph})
     GROUP BY original_transaction_id`,
    ids
  );
  for (const row of refundRows) approved.set(Number(row.transaction_id), Number(row.n) || 0);
  const pendingRows = await db.all(
    `SELECT transaction_id, COUNT(*) AS n
     FROM refund_requests
     WHERE status = 'pending' AND transaction_id IN (${ph})
     GROUP BY transaction_id`,
    ids
  );
  for (const row of pendingRows) pending.set(Number(row.transaction_id), Number(row.n) || 0);
  return { approved, pending };
}

function historyFilters({ cashierId, receiptQuery, fromDay, toDay }) {
  const where = ["COALESCE(t.store_id, 1) = 1", "t.cashier_id = ?"];
  const params = [cashierId];
  if (receiptQuery) {
    where.push("t.receipt_number LIKE ? ESCAPE '\\'");
    params.push(likeContains(receiptQuery));
  }
  if (fromDay || toDay) {
    const from = fromDay || "0001-01-01";
    const to = toDay || "9999-12-31";
    if (from > to) {
      throw new HttpError(400, "تاريخ البداية بعد تاريخ النهاية", "VALIDATION_ERROR");
    }
    where.push(businessDayRangeClause("t", "cs"));
    params.push(...businessDayRangeParams(from, to));
  }
  return { whereSql: where.join(" AND "), params };
}

export async function listPosSaleHistory(db, user, query = {}) {
  const cashierId = resolveHistoryCashierId(user, query.cashier_id);
  const page = parsePositiveInt(query.page, 1, { min: 1, max: 100000 });
  const limit = parsePositiveInt(query.limit, DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT });
  if (page == null || limit == null) {
    throw new HttpError(400, "ترقيم الصفحات غير صالح", "VALIDATION_ERROR");
  }
  const receiptQuery = query.q != null ? String(query.q).trim() : "";
  if (receiptQuery.length > 40) {
    throw new HttpError(400, "رقم الفاتورة أطول من المسموح", "VALIDATION_ERROR");
  }
  const fromDay = ymdOrThrow(query.from, "تاريخ البداية");
  const toDay = ymdOrThrow(query.to, "تاريخ النهاية");
  const { whereSql, params } = historyFilters({
    cashierId,
    receiptQuery,
    fromDay,
    toDay,
  });
  const countRow = await db.get(
    `SELECT COUNT(*) AS total
     FROM transactions t
     ${TX_BUSINESS_DAY_JOIN}
     WHERE ${whereSql}`,
    params
  );
  const total = Number(countRow?.total) || 0;
  const offset = (page - 1) * limit;
  const rows = await db.all(
    `SELECT t.id, t.receipt_number, t.total, t.payment_method, t.created_at, t.status,
            t.discount, t.cashier_id, t.shift_id, t.items_json,
            t.business_day AS business_day,
            cs.business_day AS shift_business_day,
            cs.start_time AS shift_start_time
     FROM transactions t
     ${TX_BUSINESS_DAY_JOIN}
     WHERE ${whereSql}
     ORDER BY datetime(t.created_at) DESC, t.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const ids = rows.map((row) => row.id);
  const { approved, pending } = await refundAggregates(db, ids);
  const sales = [];
  for (const row of rows) {
    const summary = await buildSaleSummary(db, row);
    const state = saleState({
      status: row.status,
      fullyRefunded: summary.fully_refunded,
      approvedRefunds: approved.get(Number(row.id)) || 0,
      pendingReturns: pending.get(Number(row.id)) || 0,
    });
    sales.push({
      transaction_id: row.id,
      receipt_number: row.receipt_number || null,
      created_at: row.created_at,
      local_created_at: localStamp(row.created_at),
      business_day: shopBusinessDayYmd(row),
      total: round2(Number(row.total)),
      discount: round2(Number(row.discount) || 0),
      payment_method: row.payment_method,
      status: row.status || "completed",
      sale_state: state.code,
      sale_state_label: state.label,
      shift_id: row.shift_id ?? null,
      fully_refunded: Boolean(summary.fully_refunded),
    });
  }
  return {
    sales,
    page,
    limit,
    total,
    page_count: total === 0 ? 0 : Math.ceil(total / limit),
  };
}

async function assertCanReadSale(user, tx) {
  if (!tx) throw new HttpError(404, "الفاتورة غير موجودة", "NOT_FOUND");
  if (Number(tx.cashier_id) === Number(user.id)) return;
  if (canViewReports(user.role)) return;
  throw new HttpError(403, "لا يمكن عرض فاتورة كاشير آخر", "FORBIDDEN");
}

export async function getPosSaleHistoryDetail(db, user, transactionId) {
  const id = Number(transactionId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, "معرّف الفاتورة غير صالح", "VALIDATION_ERROR");
  }
  const tx = await db.get(
    `SELECT t.*,
            t.business_day AS business_day,
            cs.business_day AS shift_business_day,
            cs.start_time AS shift_start_time,
            u.username AS cashier_name,
            c.name AS customer_name
     FROM transactions t
     ${TX_BUSINESS_DAY_JOIN}
     JOIN users u ON u.id = t.cashier_id
     LEFT JOIN customers c ON c.id = t.customer_id
     WHERE t.id = ?`,
    [id]
  );
  await assertCanReadSale(user, tx);

  const itemRows = await db.all(
    `SELECT id, name, unit_name, quantity, unit_price, discount_at_sale, line_net, line_gross, line_tax
     FROM transaction_items
     WHERE transaction_id = ?
     ORDER BY id`,
    [id]
  );
  let lines;
  if (itemRows.length) {
    lines = itemRows.map((row) => ({
      id: row.id,
      name: row.name,
      unit_name: row.unit_name || null,
      quantity: Number(row.quantity) || 0,
      unit_price: round2(Number(row.unit_price) || 0),
      discount: round2(Number(row.discount_at_sale) || 0),
      line_total: round2(Number(row.line_net) || 0),
      line_gross: round2(Number(row.line_gross) || 0),
      line_tax: round2(Number(row.line_tax) || 0),
    }));
  } else {
    let parsed = [];
    try {
      const arr = JSON.parse(tx.items_json);
      parsed = Array.isArray(arr) ? arr : [];
    } catch {
      parsed = [];
    }
    lines = parsed.map((it, index) => ({
      id: index + 1,
      name: it.name || "",
      unit_name: it.unit_name || null,
      quantity: Number(it.quantity) || 0,
      unit_price: round2(Number(it.price) || 0),
      discount: 0,
      line_total: round2((Number(it.quantity) || 0) * (Number(it.price) || 0)),
      line_gross: round2((Number(it.quantity) || 0) * (Number(it.price) || 0)),
      line_tax: 0,
    }));
  }

  const payments = await loadSalePayments(db, id);
  const refundRows = await db.all(
    `SELECT id, total, payment_method, items_json, created_at, status
     FROM refunds
     WHERE original_transaction_id = ? AND status = 'approved'
     ORDER BY id`,
    [id]
  );
  const pendingRows = await db.all(
    `SELECT id, total_amount, payment_method, items_json, created_at, status
     FROM refund_requests
     WHERE transaction_id = ? AND status = 'pending'
     ORDER BY id`,
    [id]
  );
  const summary = await buildSaleSummary(db, tx);
  const state = saleState({
    status: tx.status,
    fullyRefunded: summary.fully_refunded,
    approvedRefunds: refundRows.length,
    pendingReturns: pendingRows.length,
  });

  return {
    transaction_id: tx.id,
    receipt_number: tx.receipt_number || null,
    created_at: tx.created_at,
    local_created_at: localStamp(tx.created_at),
    business_day: shopBusinessDayYmd(tx),
    shift_id: tx.shift_id ?? null,
    cashier_name: tx.cashier_name || "",
    customer_name: tx.customer_name || null,
    notes: tx.notes || null,
    status: tx.status || "completed",
    sale_state: state.code,
    sale_state_label: state.label,
    subtotal: round2(Number(tx.subtotal) || 0),
    discount: round2(Number(tx.discount) || 0),
    tax: round2(Number(tx.tax) || 0),
    amount_before_rounding:
      tx.amount_before_rounding != null && tx.amount_before_rounding !== ""
        ? round2(Number(tx.amount_before_rounding) || 0)
        : null,
    rounding_adjustment:
      tx.rounding_adjustment != null && tx.rounding_adjustment !== ""
        ? round2(Number(tx.rounding_adjustment) || 0)
        : 0,
    total: round2(Number(tx.total) || 0),
    change_amount: round2(Number(tx.change_amount) || 0),
    payment_method: tx.payment_method,
    payments: payments.map((p) => ({
      method: p.method,
      amount: round2(Number(p.amount) || 0),
      currency_code: p.currency_code || null,
      original_amount: round2(Number(p.original_amount) || 0),
    })),
    lines,
    returns: [
      ...refundRows.map((row) => ({
        id: row.id,
        kind: "refund",
        status: "approved",
        total: round2(Number(row.total) || 0),
        payment_method: row.payment_method,
        created_at: row.created_at,
        local_created_at: localStamp(row.created_at),
        lines: storedRefundLines(row.items_json),
      })),
      ...pendingRows.map((row) => ({
        id: row.id,
        kind: "pending",
        status: "pending",
        total: round2(Number(row.total_amount) || 0),
        payment_method: row.payment_method,
        created_at: row.created_at,
        local_created_at: localStamp(row.created_at),
        lines: storedRefundLines(row.items_json),
      })),
    ],
  };
}
