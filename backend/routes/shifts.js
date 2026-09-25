import { createSafeRouter } from "../utils/asyncHandler.js";
import { requireAuth, requirePosAccess, requireReportsPermission } from "../middleware/auth.js";
import { isAdmin } from "../utils/roles.js";
import { userHasAccountantPermission } from "../utils/accountantPermissions.js";
import { getOpenShiftForCashier } from "../middleware/getCurrentShift.js";
import { getAppSettings } from "../utils/settings.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { buildSaleSummaries } from "../utils/saleSummary.js";
import {
  loadSalePayments,
  computeExpectedCash,
  computeExpectedDrawer,
  computeExpectedDrawers,
  computeShiftVisa,
  computeShiftVisaMap,
  emptyShiftVisa,
  SHIFT_VISA_LABELS,
  SHIFT_CASH_SALES_LABEL,
  SHIFT_MIXED_CASH_LABEL,
  SHIFT_MIXED_CASH_INCLUDED_NOTE,
  SHIFT_VISA_AMOUNT_LABEL,
  SHIFT_TENDER_TOTAL_LABEL,
  SHIFT_CASH_REFUNDS_LABEL,
  SHIFT_CASH_NET_LABEL,
  SHIFT_EXPECTED_CASH_LABEL,
  CASH_SALES_INCOMPLETE_NOTE,
  VISA_RECORDED_NOTE,
  VISA_INCOMPLETE_NOTE,
  resolveCountedCash,
} from "../utils/salePayments.js";
import { listLimitSql } from "../utils/listQuery.js";
import { round2 } from "../utils/money.js";
import { buildReceiptPayload, mapSaleItemsToReceiptLines, RECEIPT_STORED_ITEMS_SQL } from "../utils/receipt.js";
import { partyBalanceForSale } from "../utils/partyBalanceAroundMove.js";
import { getSuspendedSalesSummary } from "../services/suspendedSaleService.js";
import { withTransaction } from "../utils/dbTx.js";
import { businessDayFromTimestamp } from "../utils/businessDay.js";
import { formatShopWall, shopDaySqlBounds, sqlUtcTimestampExpr } from "../utils/shopTime.js";
import { listShiftCustomerCollections } from "../services/posCustomerCollectionService.js";
import { listShiftCustomerCashDebts } from "../services/customerCashDebtRequestService.js";
import {
  listShiftSupplierPayments,
  listSupplierPaymentOptions,
} from "../services/posSupplierPaymentService.js";
import {
  createSupplierPaymentApprovalRequest,
  listShiftSupplierPaymentRequests,
} from "../services/groupApprovalService.js";
import { validate } from "../middleware/validate.js";
import { posSupplierPaymentSchema, shiftCountAdvanceSchema } from "../middleware/schemas.js";
import {
  listEmployeeAdvanceOptions,
  listShiftAdvances,
  postShiftSalaryAdvance,
} from "../services/advanceRequestService.js";
import {
  assertShiftReadyToClose,
  listClosedShiftPendingRequests,
  listShiftDecisionState,
} from "../services/originatingShiftDecision.js";

function parseDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return null;
  return s.trim();
}

function alreadyHasOpenShiftResponse(res) {
  return res.status(409).json({ error: "لديك وردية مفتوحة بالفعل" });
}

function isOpenShiftUniqueViolation(err) {
  const code = String(err?.code || "");
  if (!code.startsWith("SQLITE_CONSTRAINT")) return false;
  const msg = String(err?.message || "");
  return /idx_cashier_shifts_one_open/i.test(msg) || /UNIQUE constraint failed: cashier_shifts/i.test(msg);
}

async function computeShiftTotals(db, shiftId) {
  const visa = await computeShiftVisa(db, shiftId);
  const refundRow = await db.get(
    `SELECT COALESCE(SUM(total), 0) AS s FROM refunds WHERE shift_id = ? AND status = 'approved'`,
    [shiftId]
  );
  return {
    card_total: visa.visa_sales,
    refund_total: round2(Number(refundRow?.s) || 0),
    visa,
  };
}

function applyVisa(row, visa) {
  const source = visa || emptyShiftVisa();
  row.visa_sales = source.visa_sales;
  row.visa_refunds = source.visa_refunds;
  row.visa_net = source.visa_net;
  row.visa_incomplete = source.visa_incomplete;
  row.visa_note = source.visa_note;
  row.visa_incomplete_note = source.visa_incomplete_note;
  row.visa_labels = source.visa_labels;
  row.cash_sales_incomplete = !!source.cash_sales_incomplete;
  row.cash_sales_incomplete_note = source.cash_sales_incomplete_note || CASH_SALES_INCOMPLETE_NOTE;
  applyTenderTotal(row);
  return row;
}

async function attachVisas(db, rows) {
  const map = await computeShiftVisaMap(
    db,
    rows.map((row) => row.id)
  );
  for (const row of rows) {
    applyVisa(row, map.get(Number(row.id)));
  }
  return rows;
}

async function canViewShiftDetail(db, user, shift) {
  if (!user || !shift) return false;
  if (user.role === "admin" || user.role === "accountant") {
    return userHasAccountantPermission(db, user, "shift_audit");
  }
  return Number(shift.cashier_id) === Number(user.id);
}

function parseCountedCashJson(raw) {
  if (raw == null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function applyDrawer(row, drawer) {
  if (row.status === "open" || row.status === "pending_count") {
    row.expected_cash = drawer.expected_cash;
  }
  row.expected_by_currency = drawer.by_currency;
  row.counted_cash = parseCountedCashJson(row.counted_cash_json);
  row.cash_sales = round2(Number(drawer?.sales_cash_nis) || 0);
  row.cash_only_sales = round2(Number(drawer?.cash_only_nis) || 0);
  row.mixed_cash_sales = round2(Number(drawer?.mixed_cash_nis) || 0);
  row.cash_refunds = round2(Number(drawer?.cash_refunds_nis) || 0);
  row.cash_net = round2(row.cash_sales - row.cash_refunds);
  row.cash_sales_label = SHIFT_CASH_SALES_LABEL;
  row.mixed_cash_label = SHIFT_MIXED_CASH_LABEL;
  row.mixed_cash_included_note = SHIFT_MIXED_CASH_INCLUDED_NOTE;
  row.visa_amount_label = SHIFT_VISA_AMOUNT_LABEL;
  row.tender_total_label = SHIFT_TENDER_TOTAL_LABEL;
  row.cash_refunds_label = SHIFT_CASH_REFUNDS_LABEL;
  row.cash_net_label = SHIFT_CASH_NET_LABEL;
  row.expected_cash_label = SHIFT_EXPECTED_CASH_LABEL;
  applyTenderTotal(row);
  return row;
}

function applyTenderTotal(row) {
  row.tender_total = round2((Number(row.cash_sales) || 0) + (Number(row.visa_sales) || 0));
  return row;
}

async function attachDrawer(db, row) {
  return applyDrawer(row, await computeExpectedDrawer(db, row.id, row.opening_cash));
}

// Batched so a list of N shifts costs four queries rather than four per shift.
async function attachDrawers(db, rows) {
  const drawers = await computeExpectedDrawers(db, rows);
  for (const row of rows) {
    const drawer = drawers.get(Number(row.id));
    if (drawer) applyDrawer(row, drawer);
  }
  return rows;
}

async function closeShiftWithCash(db, req, shift, closing_cash, notes, closing_notes, counted_cash) {
  const shiftId = shift.id;
  const settings = await getAppSettings(db);
  const varianceThreshold = round2(Number(settings.shift_variance_threshold) || 50);
  const countedJson = counted_cash ? JSON.stringify(counted_cash) : null;

  const closed = await withTransaction(db, async () => {
    const live = await db.get("SELECT * FROM cashier_shifts WHERE id = ?", [shiftId]);
    if (!live || !["open", "pending_count"].includes(live.status)) {
      const err = new Error("الوردية مغلقة بالفعل");
      err.status = 400;
      err.code = "SHIFT_ALREADY_CLOSED";
      throw err;
    }
    await assertShiftReadyToClose(db, shiftId);
    const expected_cash = await computeExpectedCash(db, shiftId, live.opening_cash);
    const variance = round2(closing_cash - expected_cash);
    const { card_total, refund_total, visa } = await computeShiftTotals(db, shiftId);
    const needsApproval = Math.abs(variance) > varianceThreshold;
    const endTime = live.end_time || new Date().toISOString();
    const upd = await db.run(
      `UPDATE cashier_shifts SET
        end_time = ?, closing_cash = ?, actual_cash = ?, expected_cash = ?, variance = ?,
        notes = COALESCE(?, notes), closing_notes = ?, card_total = ?, refund_total = ?,
        variance_threshold = ?, requires_approval = ?, counted_cash_json = ?, status = 'closed'
       WHERE id = ? AND status IN ('open', 'pending_count')`,
      [
        endTime,
        closing_cash,
        closing_cash,
        expected_cash,
        variance,
        notes,
        closing_notes,
        card_total,
        refund_total,
        varianceThreshold,
        needsApproval ? 1 : 0,
        countedJson,
        shiftId,
      ]
    );
    if (!upd.changes) {
      const err = new Error("الوردية مغلقة بالفعل");
      err.status = 400;
      err.code = "SHIFT_ALREADY_CLOSED";
      throw err;
    }
    await db.run(
      `INSERT INTO shift_cash_movements (shift_id, movement_type, amount, description)
       VALUES (?, 'closing', ?, ?)`,
      [shiftId, closing_cash, closing_notes ? `إغلاق الوردية — ${closing_notes}` : "إغلاق الوردية"]
    );
    return {
      expected_cash,
      variance,
      card_total,
      refund_total,
      visa,
      needsApproval,
      opening_cash: live.opening_cash,
      priorStatus: live.status,
    };
  });

  const { expected_cash, variance, card_total, refund_total, visa, needsApproval, opening_cash, priorStatus } = closed;
  shift.status = priorStatus;

  const auditAction =
    shift.status === "pending_count" ? AUDIT_ACTIONS.SHIFT_RECONCILE : AUDIT_ACTIONS.SHIFT_CLOSE;
  await logAudit(db, req, auditAction, "cashier_shifts", shiftId, { status: shift.status }, {
    expected_cash,
    actual_cash: closing_cash,
    variance,
    card_total,
    refund_total,
    visa_sales: visa.visa_sales,
    visa_refunds: visa.visa_refunds,
    visa_net: visa.visa_net,
    requires_approval: needsApproval,
  });

  return {
    shift_id: shiftId,
    opening_cash: round2(Number(opening_cash)),
    closing_cash,
    actual_cash: closing_cash,
    expected_cash,
    variance,
    card_total,
    refund_total,
    ...visa,
    variance_threshold: varianceThreshold,
    requires_approval: needsApproval,
    counted_cash: counted_cash || null,
    status: "closed",
  };
}

export function createShiftsRouter(db) {
  const router = createSafeRouter();
  const requireShiftAudit = requireReportsPermission(db, "shift_audit");

  router.post("/start", requireAuth, requirePosAccess, async (req, res, next) => {
    const settings = await getAppSettings(db);
    const opening_cash = round2(Number(settings.default_opening_cash));
    if (Number.isNaN(opening_cash) || opening_cash < 0) {
      return res.status(400).json({ error: "مبلغ افتتاح الوردية غير صالح في الإعدادات" });
    }
    try {
      const { shiftId, row } = await withTransaction(db, async () => {
        const existing = await getOpenShiftForCashier(db, req.user.id);
        if (existing) {
          const err = new Error("لديك وردية مفتوحة بالفعل");
          err.status = 409;
          throw err;
        }
        const openedAt = new Date().toISOString();
        const businessDay = businessDayFromTimestamp(openedAt, settings.business_day_cutoff_hour);
        const ins = await db.run(
          `INSERT INTO cashier_shifts (cashier_id, opening_cash, status, hourly_rate_snapshot, start_time, business_day)
           VALUES (?, ?, 'open', (SELECT hourly_rate FROM users WHERE id = ?), ?, ?)`,
          [req.user.id, opening_cash, req.user.id, openedAt, businessDay]
        );
        const shiftId = ins.lastID;
        await db.run(
          `INSERT INTO shift_cash_movements (shift_id, movement_type, amount, description)
           VALUES (?, 'opening', ?, ?)`,
          [shiftId, opening_cash, "افتتاح الوردية"]
        );
        const row = await db.get("SELECT * FROM cashier_shifts WHERE id = ?", [shiftId]);
        return { shiftId, row };
      });
      await logAudit(db, req, AUDIT_ACTIONS.SHIFT_OPEN, "cashier_shifts", shiftId, null, { opening_cash });
      res.status(201).json({
        shift_id: shiftId,
        status: row.status,
        opened_at: row.start_time,
        business_day: row.business_day,
        opening_cash,
      });
    } catch (e) {
      if (e?.status === 409) {
        return alreadyHasOpenShiftResponse(res);
      }
      if (isOpenShiftUniqueViolation(e)) {
        return alreadyHasOpenShiftResponse(res);
      }
      next(e);
    }
  });

  router.get("/current", requireAuth, requirePosAccess, async (req, res) => {
    const shift = await getOpenShiftForCashier(db, req.user.id);
    if (!shift) {
      return res.json({ shift: null, transactions_count: 0 });
    }
    const cnt = await db.get(
      `SELECT COUNT(*) AS c FROM transactions WHERE shift_id = ?`,
      [shift.id]
    );
    const suspendedSummary = await getSuspendedSalesSummary(db, shift.id);
    const visa = await computeShiftVisa(db, shift.id);
    const drawer = await computeExpectedDrawer(db, shift.id, shift.opening_cash);
    const collections = await listShiftCustomerCollections(db, shift.id);
    const cashDebts = await listShiftCustomerCashDebts(db, shift.id);
    res.json({
      shift: {
        id: shift.id,
        cashier_id: shift.cashier_id,
        start_time: shift.start_time,
        business_day: shift.business_day,
        opening_cash: shift.opening_cash,
        status: shift.status,
        expected_cash: drawer.expected_cash,
        cash_sales: drawer.sales_cash_nis,
        cash_only_sales: drawer.cash_only_nis,
        mixed_cash_sales: drawer.mixed_cash_nis,
        cash_refunds: drawer.cash_refunds_nis,
        cash_net: round2((drawer.sales_cash_nis || 0) - (drawer.cash_refunds_nis || 0)),
        tender_total: round2((drawer.sales_cash_nis || 0) + (visa.visa_sales || 0)),
        cash_sales_label: SHIFT_CASH_SALES_LABEL,
        mixed_cash_label: SHIFT_MIXED_CASH_LABEL,
        mixed_cash_included_note: SHIFT_MIXED_CASH_INCLUDED_NOTE,
        visa_amount_label: SHIFT_VISA_AMOUNT_LABEL,
        tender_total_label: SHIFT_TENDER_TOTAL_LABEL,
        cash_refunds_label: SHIFT_CASH_REFUNDS_LABEL,
        cash_net_label: SHIFT_CASH_NET_LABEL,
        expected_cash_label: SHIFT_EXPECTED_CASH_LABEL,
        cash_sales_incomplete: visa.cash_sales_incomplete,
        cash_sales_incomplete_note: visa.cash_sales_incomplete_note,
        ...visa,
      },
      transactions_count: Number(cnt?.c) || 0,
      summary: {
        visa,
        cash_sales: drawer.sales_cash_nis,
        cash_only_sales: drawer.cash_only_nis,
        mixed_cash_sales: drawer.mixed_cash_nis,
        cash_refunds: drawer.cash_refunds_nis,
        cash_net: round2((drawer.sales_cash_nis || 0) - (drawer.cash_refunds_nis || 0)),
        tender_total: round2((drawer.sales_cash_nis || 0) + (visa.visa_sales || 0)),
        cash_sales_incomplete: visa.cash_sales_incomplete,
        expected: drawer.expected_cash,
        customer_collections_total: collections.total,
        customer_cash_debts_total: cashDebts.total,
      },
      ...suspendedSummary,
    });
  });

  router.get("/current/sales", requireAuth, requirePosAccess, async (req, res) => {
    const shift = await getOpenShiftForCashier(db, req.user.id);
    if (!shift) {
      return res.json({ shift_id: null, sales: [] });
    }
    // buildSaleSummary queries per row, so an unbounded list turned a busy
    // shift into hundreds of round-trips to SQLite for a panel that only shows
    // recent sales; anything older is reachable by receipt number.
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const countRow = await db.get(
      "SELECT COUNT(*) AS total FROM transactions WHERE shift_id = ?",
      [shift.id]
    );
    const rows = await db.all(
      `SELECT id, receipt_number, total, payment_method, created_at, items_json
       FROM transactions WHERE shift_id = ? ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [shift.id, limit, offset]
    );
    const sales = await buildSaleSummaries(db, rows);
    res.json({
      shift_id: shift.id,
      sales,
      total: Number(countRow?.total) || 0,
      limit,
      offset,
    });
  });

  router.get("/closed-pending-requests", requireAuth, requireShiftAudit, async (_req, res, next) => {
    try {
      const rows = await listClosedShiftPendingRequests(db);
      res.json({ requests: rows });
    } catch (e) {
      next(e);
    }
  });

  router.get("/pending", requireAuth, requireShiftAudit, async (req, res) => {
    const rows = await db.all(
      `SELECT s.id, s.cashier_id, u.username AS cashier_name, s.start_time, s.end_time,
              s.opening_cash, s.expected_cash, s.status
       FROM cashier_shifts s
       JOIN users u ON u.id = s.cashier_id
       WHERE s.status = 'pending_count'
       ORDER BY datetime(s.end_time) ASC, s.id ASC`
    );
    await attachDrawers(db, rows);
    await attachVisas(db, rows);
    res.json(rows);
  });

  router.get("/supplier-options", requireAuth, requireShiftAudit, async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await listSupplierPaymentOptions(db, req.query.q));
  });

  router.get("/employee-options", requireAuth, requireShiftAudit, async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await listEmployeeAdvanceOptions(db, req.query.q));
  });

  router.post(
    "/:shiftId/supplier-payments",
    requireAuth,
    requireShiftAudit,
    validate(posSupplierPaymentSchema),
    async (req, res, next) => {
      const shiftId = Number(req.params.shiftId);
      if (!Number.isInteger(shiftId) || shiftId <= 0) {
        return res.status(400).json({ error: "معرّف الوردية غير صالح", code: "INVALID_SHIFT" });
      }
      try {
        const result = await createSupplierPaymentApprovalRequest(db, {
          cashierId: req.user.id,
          recordedById: req.user.id,
          shiftId,
          forgotten: true,
          supplierId: req.body.supplier_id,
          amount: req.body.amount,
          notes: req.body.notes,
          idempotencyKey: req.body.idempotency_key,
        });
        const live = await db.get("SELECT id, opening_cash, status FROM cashier_shifts WHERE id = ?", [
          shiftId,
        ]);
        const drawer = live
          ? await computeExpectedDrawer(db, live.id, live.opening_cash)
          : { expected_cash: null, by_currency: [], sales_cash_nis: 0 };
        const payments = await listShiftSupplierPayments(db, shiftId);
        const pending = await listShiftSupplierPaymentRequests(db, shiftId);
        res.status(result.replayed ? 200 : 201).json({
          ...result,
          expected_cash: drawer.expected_cash,
          expected_by_currency: drawer.by_currency,
          cash_sales: drawer.sales_cash_nis,
          supplier_payments: payments.rows,
          supplier_payments_total: payments.total,
          supplier_payment_requests: pending,
        });
      } catch (e) {
        if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
        next(e);
      }
    }
  );

  router.post(
    "/:shiftId/advances",
    requireAuth,
    requireShiftAudit,
    validate(shiftCountAdvanceSchema),
    async (req, res, next) => {
      const shiftId = Number(req.params.shiftId);
      if (!Number.isInteger(shiftId) || shiftId <= 0) {
        return res.status(400).json({ error: "معرّف الوردية غير صالح", code: "INVALID_SHIFT" });
      }
      try {
        const result = await postShiftSalaryAdvance(db, {
          shiftId,
          userId: req.user.id,
          user: req.user,
          employeeId: req.body.employee_id,
          amount: req.body.amount,
          notes: req.body.notes,
          idempotencyKey: req.body.idempotency_key,
          req,
        });
        const live = await db.get("SELECT id, opening_cash, status FROM cashier_shifts WHERE id = ?", [
          shiftId,
        ]);
        const drawer = live
          ? await computeExpectedDrawer(db, live.id, live.opening_cash)
          : { expected_cash: null, by_currency: [], sales_cash_nis: 0 };
        const advances = await listShiftAdvances(db, shiftId);
        res.status(result.replayed ? 200 : 201).json({
          ...result,
          expected_cash: drawer.expected_cash,
          expected_by_currency: drawer.by_currency,
          cash_sales: drawer.sales_cash_nis,
          advances: advances.rows,
          advances_total: advances.total,
        });
      } catch (e) {
        if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
        next(e);
      }
    }
  );

  router.get("/", requireAuth, requireShiftAudit, async (req, res) => {
    const status =
      typeof req.query.status === "string" &&
      ["open", "pending_count", "closed"].includes(req.query.status)
        ? req.query.status
        : null;
    const cashierId =
      req.query.cashier_id != null && String(req.query.cashier_id).trim() !== ""
        ? Number(req.query.cashier_id)
        : null;
    const dateFrom = parseDate(req.query.date_from);
    const dateTo = parseDate(req.query.date_to);

    let sql = `
      SELECT s.id, s.cashier_id, u.username AS cashier_name, s.start_time, s.end_time,
             s.business_day, s.opening_cash, s.closing_cash, s.expected_cash, s.variance, s.status,
             (SELECT COUNT(*) FROM transactions t WHERE t.shift_id = s.id) AS sale_count
      FROM cashier_shifts s
      JOIN users u ON u.id = s.cashier_id
      WHERE 1=1`;
    const params = [];
    if (status) {
      sql += " AND s.status = ?";
      params.push(status);
    }
    if (cashierId && !Number.isNaN(cashierId)) {
      sql += " AND s.cashier_id = ?";
      params.push(cashierId);
    }
    if (dateFrom || dateTo) {
      const bounds = shopDaySqlBounds(dateFrom || "1970-01-01", dateTo || "2100-12-31");
      const started = sqlUtcTimestampExpr("s.start_time");
      sql += ` AND (
        (s.business_day IS NOT NULL AND s.business_day >= ? AND s.business_day <= ?)
        OR (s.business_day IS NULL AND ${started} >= datetime(?) AND ${started} <= datetime(?))
      )`;
      params.push(dateFrom || "1970-01-01", dateTo || "2100-12-31", bounds.startSql, bounds.endSql);
    }
    sql += " ORDER BY datetime(COALESCE(s.end_time, s.start_time)) DESC, s.id DESC";
    sql += listLimitSql(req.query, 100, req.user?.role).sql;
    const rows = await db.all(sql, params);
    for (const row of rows) {
      row.sale_count = Number(row.sale_count) || 0;
    }
    await attachDrawers(db, rows);
    await attachVisas(db, rows);
    res.json(rows);
  });

  router.get("/:shiftId/cash-movements", requireAuth, async (req, res) => {
    const shiftId = Number(req.params.shiftId);
    if (!shiftId) return res.status(400).json({ error: "معرّف الوردية غير صالح" });
    const shift = await db.get("SELECT * FROM cashier_shifts WHERE id = ?", [shiftId]);
    if (!shift) return res.status(404).json({ error: "الوردية غير موجودة" });
    if (!(await canViewShiftDetail(db, req.user, shift))) {
      return res.status(403).json({ error: "ممنوع" });
    }
    const rows = await db.all(
      `SELECT id, movement_type, amount, description, created_at, transaction_id, refund_id
       FROM shift_cash_movements WHERE shift_id = ? ORDER BY created_at ASC, id ASC${listLimitSql(req.query, 500).sql}`,
      [shiftId]
    );
    res.json(rows);
  });

  router.get("/:shiftId/export.csv", requireAuth, async (req, res) => {
    const shiftId = Number(req.params.shiftId);
    if (!shiftId) return res.status(400).json({ error: "معرّف الوردية غير صالح" });
    const shift = await db.get(
      `SELECT s.*, u.username AS cashier_name FROM cashier_shifts s JOIN users u ON u.id = s.cashier_id WHERE s.id = ?`,
      [shiftId]
    );
    if (!shift) return res.status(404).json({ error: "الوردية غير موجودة" });
    if (!(await canViewShiftDetail(db, req.user, shift))) {
      return res.status(403).json({ error: "ممنوع" });
    }
    const movements = await db.all(
      `SELECT id, movement_type, amount, description, created_at, transaction_id, refund_id
       FROM shift_cash_movements WHERE shift_id = ? ORDER BY created_at ASC, id ASC`,
      [shiftId]
    );
    await attachDrawer(db, shift);
    const visa = await computeShiftVisa(db, shiftId);
    applyVisa(shift, visa);
    const visaRefunds = await db.all(
      `SELECT r.id, r.original_transaction_id, r.total, t.receipt_number AS original_receipt,
              t.shift_id AS original_shift_id
       FROM refunds r
       LEFT JOIN transactions t ON t.id = r.original_transaction_id
       WHERE r.shift_id = ? AND r.status = 'approved' AND r.payment_method = 'visa'
       ORDER BY r.id ASC`,
      [shiftId]
    );
    const esc = (v) => {
      let s = v == null ? "" : String(v);
      // Formula-injection guard for Excel/Sheets.
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const lines = [
      [
        "shift_id",
        "cashier",
        "start_time",
        "end_time",
        "opening_cash",
        "closing_cash",
        "expected_cash",
        "variance",
        "status",
        "cash_sales",
        "cash_sales_incomplete",
        "visa_sales",
        "visa_refunds",
        "visa_net",
        "visa_incomplete",
      ].join(","),
      [
        shift.id,
        shift.cashier_name,
        shift.start_time,
        shift.end_time ?? "",
        shift.opening_cash,
        shift.closing_cash ?? "",
        shift.expected_cash ?? "",
        shift.variance ?? "",
        shift.status,
        shift.cash_sales,
        shift.cash_sales_incomplete ? 1 : 0,
        visa.visa_sales,
        visa.visa_refunds,
        visa.visa_net,
        visa.visa_incomplete ? 1 : 0,
      ]
        .map(esc)
        .join(","),
      "",
      [SHIFT_CASH_SALES_LABEL, shift.cash_sales].map(esc).join(","),
      [SHIFT_MIXED_CASH_LABEL, shift.mixed_cash_sales].map(esc).join(","),
      [SHIFT_MIXED_CASH_INCLUDED_NOTE, ""].map(esc).join(","),
      [SHIFT_VISA_LABELS.sales, visa.visa_sales].map(esc).join(","),
      [SHIFT_TENDER_TOTAL_LABEL, shift.tender_total].map(esc).join(","),
      [SHIFT_CASH_REFUNDS_LABEL, shift.cash_refunds].map(esc).join(","),
      [SHIFT_VISA_LABELS.refunds, visa.visa_refunds].map(esc).join(","),
      [SHIFT_CASH_NET_LABEL, shift.cash_net].map(esc).join(","),
      [SHIFT_VISA_LABELS.net, visa.visa_net].map(esc).join(","),
      [SHIFT_EXPECTED_CASH_LABEL, shift.expected_cash ?? ""].map(esc).join(","),
      ["دفعات الموردين", (await listShiftSupplierPayments(db, shiftId)).total].map(esc).join(","),
      ["ذمم نقدية للعملاء", (await listShiftCustomerCashDebts(db, shiftId)).total].map(esc).join(","),
      ["قبض ذمم سابق — للمراجعة", (await listShiftCustomerCollections(db, shiftId)).total].map(esc).join(","),
      ["سلف", (await listShiftAdvances(db, shiftId)).total].map(esc).join(","),
      ["البيان", VISA_RECORDED_NOTE].map(esc).join(","),
      [
        "اكتمال السجل",
        visa.visa_incomplete ? VISA_INCOMPLETE_NOTE : "مكتمل",
      ]
        .map(esc)
        .join(","),
      [
        "اكتمال المبيعات النقدية",
        shift.cash_sales_incomplete ? CASH_SALES_INCOMPLETE_NOTE : "مكتمل",
      ]
        .map(esc)
        .join(","),
      "",
      "visa_refund_id,original_transaction_id,original_receipt,original_shift_id,amount",
    ];
    for (const refund of visaRefunds) {
      lines.push(
        [
          refund.id,
          refund.original_transaction_id,
          refund.original_receipt ?? "",
          refund.original_shift_id ?? "",
          refund.total,
        ]
          .map(esc)
          .join(",")
      );
    }
    lines.push(
      "",
      "movement_id,type,amount,description,created_at,transaction_id,refund_id"
    );
    for (const m of movements) {
      lines.push(
        [m.id, m.movement_type, m.amount, m.description ?? "", formatShopWall(m.created_at)?.dateTime || m.created_at, m.transaction_id ?? "", m.refund_id ?? ""]
          .map(esc)
          .join(",")
      );
    }
    const body = "\uFEFF" + lines.join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="shift-${shiftId}.csv"`);
    res.send(body);
  });

  router.post("/:shiftId/adjust", requireAuth, requireShiftAudit, async (req, res, next) => {
    const shiftId = Number(req.params.shiftId);
    if (!shiftId) return res.status(400).json({ error: "معرّف الوردية غير صالح" });
    const shift = await db.get("SELECT * FROM cashier_shifts WHERE id = ?", [shiftId]);
    if (!shift) return res.status(404).json({ error: "الوردية غير موجودة" });
    if (shift.status !== "open") {
      return res.status(400).json({ error: "لا يمكن تعديل وردية غير مفتوحة" });
    }
    const amount = round2(Number((req.body || {}).amount));
    if (Number.isNaN(amount) || amount === 0) {
      return res.status(400).json({ error: "مبلغ التسوية غير صالح" });
    }
    const description =
      (req.body || {}).description != null ? String((req.body || {}).description).trim() : "";
    const desc = description || "تسوية نقدية";
    try {
      await db.run(
        `INSERT INTO shift_cash_movements (shift_id, movement_type, amount, description)
         VALUES (?, 'adjustment', ?, ?)`,
        [shiftId, amount, desc]
      );
      const row = await db.get(
        `SELECT id, movement_type, amount, description, created_at, transaction_id, refund_id
         FROM shift_cash_movements WHERE shift_id = ? ORDER BY id DESC LIMIT 1`,
        [shiftId]
      );
      res.status(201).json({ success: true, movement: row });
      await logAudit(db, req, AUDIT_ACTIONS.SHIFT_ADJUST, "cashier_shifts", shiftId, null, { amount, description: desc });
    } catch (e) {
      next(e);
    }
  });

  router.post("/:shiftId/approve", requireAuth, requireShiftAudit, async (req, res, next) => {
    const shiftId = Number(req.params.shiftId);
    if (!shiftId) return res.status(400).json({ error: "معرّف الوردية غير صالح" });
    const shift = await db.get("SELECT * FROM cashier_shifts WHERE id = ?", [shiftId]);
    if (!shift) return res.status(404).json({ error: "الوردية غير موجودة" });
    if (!shift.requires_approval) {
      return res.status(400).json({ error: "لا تتطلب هذه الوردية موافقة", code: "NO_APPROVAL_NEEDED" });
    }
    try {
      const now = new Date().toISOString();
      await db.run(
        `UPDATE cashier_shifts SET requires_approval = 0, manager_approved_by = ?, manager_approved_at = ? WHERE id = ?`,
        [req.user.id, now, shiftId]
      );
      await logAudit(db, req, AUDIT_ACTIONS.SHIFT_APPROVE, "cashier_shifts", shiftId, { requires_approval: 1 }, { manager_approved_by: req.user.id });
      res.json({ success: true, shift_id: shiftId, manager_approved_by: req.user.id, manager_approved_at: now });
    } catch (e) {
      next(e);
    }
  });

  router.post("/:shiftId/reconcile", requireAuth, requireShiftAudit, async (req, res, next) => {
    const shiftId = Number(req.params.shiftId);
    if (!shiftId) return res.status(400).json({ error: "معرّف الوردية غير صالح" });
    const shift = await db.get("SELECT * FROM cashier_shifts WHERE id = ?", [shiftId]);
    if (!shift) return res.status(404).json({ error: "الوردية غير موجودة" });
    if (shift.status !== "pending_count") {
      return res.status(400).json({ error: "الوردية ليست بانتظار العد", code: "NOT_PENDING" });
    }
    const drawer = await computeExpectedDrawer(db, shiftId, shift.opening_cash);
    const counted = await resolveCountedCash(db, req.body || {}, drawer);
    if (counted.error) {
      return res.status(400).json({ error: counted.error });
    }
    const closing_notes =
      (req.body || {}).closing_notes != null
        ? String((req.body || {}).closing_notes).trim()
        : (req.body || {}).notes != null
          ? String((req.body || {}).notes).trim()
          : null;

    try {
      const payload = await closeShiftWithCash(
        db,
        req,
        shift,
        counted.closing_cash,
        null,
        closing_notes,
        counted.counted_cash
      );
      if (payload.requires_approval) {
        return res.status(202).json({
          ...payload,
          warning: "الفارق يتجاوز الحد — مطلوبت موافقة المدير",
          code: "VARIANCE_APPROVAL_REQUIRED",
        });
      }
      res.json(payload);
    } catch (e) {
      next(e);
    }
  });

  router.post("/:shiftId/end", requireAuth, async (req, res, next) => {
    const shiftId = Number(req.params.shiftId);
    if (!shiftId) return res.status(400).json({ error: "معرّف الوردية غير صالح" });
    const shift = await db.get("SELECT * FROM cashier_shifts WHERE id = ?", [shiftId]);
    if (!shift) return res.status(404).json({ error: "الوردية غير موجودة" });
    const isOwner = Number(shift.cashier_id) === Number(req.user.id);
    const isAdminUser = isAdmin(req.user.role);
    if (!isOwner && !isAdminUser) {
      return res.status(403).json({ error: "غير مسموح بإغلاق هذه الوردية" });
    }
    if (shift.status !== "open") {
      return res.status(400).json({ error: "الوردية مغلقة بالفعل" });
    }

    const notes = (req.body || {}).notes != null ? String((req.body || {}).notes).trim() : null;
    const closing_notes =
      (req.body || {}).closing_notes != null ? String((req.body || {}).closing_notes).trim() : notes;
    const countedInput = Array.isArray((req.body || {}).counted_currencies)
      ? (req.body || {}).counted_currencies
      : null;
    const closingRaw = (req.body || {}).closing_cash ?? (req.body || {}).actual_cash;
    const hasClosingCash =
      (countedInput && countedInput.length > 0) ||
      (closingRaw !== undefined && closingRaw !== null && String(closingRaw).trim() !== "");

    if (isOwner && !isAdminUser) {
      try {
        const pending = await withTransaction(db, async () => {
          const live = await db.get("SELECT * FROM cashier_shifts WHERE id = ?", [shiftId]);
          if (!live || live.status !== "open") {
            const err = new Error("الوردية مغلقة بالفعل");
            err.status = 400;
            throw err;
          }
          const expected_cash = await computeExpectedCash(db, shiftId, live.opening_cash);
          const { card_total, refund_total, visa } = await computeShiftTotals(db, shiftId);
          const endTime = new Date().toISOString();
          const upd = await db.run(
            `UPDATE cashier_shifts SET
              end_time = ?, expected_cash = ?, notes = ?, closing_notes = ?,
              card_total = ?, refund_total = ?, status = 'pending_count'
             WHERE id = ? AND status = 'open'`,
            [endTime, expected_cash, notes, closing_notes, card_total, refund_total, shiftId]
          );
          if (!upd.changes) {
            const err = new Error("الوردية مغلقة بالفعل");
            err.status = 400;
            throw err;
          }
          return { expected_cash, card_total, refund_total, visa };
        });
        await logAudit(db, req, AUDIT_ACTIONS.SHIFT_CLOSE, "cashier_shifts", shiftId, { status: "open" }, {
          expected_cash: pending.expected_cash,
          card_total: pending.card_total,
          refund_total: pending.refund_total,
          visa_sales: pending.visa.visa_sales,
          visa_refunds: pending.visa.visa_refunds,
          visa_net: pending.visa.visa_net,
          pending_count: true,
        });
        return res.json({
          shift_id: shiftId,
          status: "pending_count",
          expected_cash: pending.expected_cash,
          card_total: pending.card_total,
          refund_total: pending.refund_total,
          ...pending.visa,
          message: "تم إرسال الوردية للمراجعة — سيقوم المدير بعد النقد",
        });
      } catch (e) {
        return next(e);
      }
    }

    if (!hasClosingCash) {
      return res.status(400).json({ error: "مبلغ إغلاق الوردية مطلوب" });
    }

    const drawer = await computeExpectedDrawer(db, shiftId, shift.opening_cash);
    const counted = await resolveCountedCash(db, req.body || {}, drawer);
    if (counted.error) {
      return res.status(400).json({ error: counted.error });
    }

    try {
      const payload = await closeShiftWithCash(
        db,
        req,
        shift,
        counted.closing_cash,
        notes,
        closing_notes,
        counted.counted_cash
      );
      if (payload.requires_approval) {
        return res.status(202).json({
          ...payload,
          warning: "الفارق يتجاوز الحد — مطلوبت موافقة المدير",
          code: "VARIANCE_APPROVAL_REQUIRED",
        });
      }
      res.json(payload);
    } catch (e) {
      next(e);
    }
  });

  router.get(
    "/transactions/:transactionId/receipt",
    requireAuth,
    requireShiftAudit,
    async (req, res) => {
      const tid = Number(req.params.transactionId);
      if (!tid) {
        return res.status(400).json({ error: "رقم العملية غير صالح" });
      }
      const tx = await db.get("SELECT * FROM transactions WHERE id = ?", [tid]);
      if (!tx) {
        return res.status(404).json({ error: "العملية غير موجودة" });
      }

      let items;
      try {
        items = JSON.parse(tx.items_json);
      } catch {
        return res.status(500).json({ error: "بيانات العملية غير صالحة" });
      }

      const cashier = await db.get("SELECT username FROM users WHERE id = ?", [tx.cashier_id]);
      const customer = tx.customer_id
        ? await db.get("SELECT name FROM customers WHERE id = ?", [tx.customer_id])
        : null;
      const payments = await loadSalePayments(db, tid);
      const settings = await getAppSettings(db);

      const storedItems = await db.all(RECEIPT_STORED_ITEMS_SQL, [tid]);
      const lines = mapSaleItemsToReceiptLines(items, storedItems);

      const { receipt_text, receipt_html } = buildReceiptPayload({
        transactionId: tid,
        receiptNumber: tx.receipt_number,
        timestamp: tx.created_at,
        cashierName: cashier?.username || "",
        customerName: customer?.name || "",
        lines,
        subtotal: Number(tx.subtotal),
        tax: Number(tx.tax),
        discount: Number(tx.discount) || 0,
        total: Number(tx.total),
        roundingAdjustment: tx.rounding_adjustment,
        paymentMethod: tx.payment_method,
        payments,
        changeNis: tx.change_amount,
        settings,
        partyBalance: await partyBalanceForSale(db, {
          customerId: tx.customer_id,
          payments,
          transactionId: tid,
          status: "posted",
        }),
      });

      res.json({
        success: true,
        receipt_text,
        receipt_html,
        transaction_id: tid,
      });
    }
  );

  router.get("/:shiftId", requireAuth, async (req, res) => {
    const shiftId = Number(req.params.shiftId);
    if (!shiftId) return res.status(400).json({ error: "معرّف الوردية غير صالح" });
    const shift = await db.get(
      `SELECT s.*, u.username AS cashier_name FROM cashier_shifts s JOIN users u ON u.id = s.cashier_id WHERE s.id = ?`,
      [shiftId]
    );
    if (!shift) return res.status(404).json({ error: "الوردية غير موجودة" });
    if (!(await canViewShiftDetail(db, req.user, shift))) {
      return res.status(403).json({ error: "ممنوع" });
    }

    // Every row carries its items_json, so an unbounded shift detail is the
    // biggest single response in the app. 500 covers any realistic shift; the
    // counts below let the client say so when it does not.
    const detailLimit = listLimitSql(req.query, 500);
    const transactions = await db.all(
      `SELECT id, cashier_id, items_json, subtotal, tax, discount, total, amount_before_rounding, rounding_adjustment,
              payment_method, receipt_number, notes, created_at, shift_id
       FROM transactions WHERE shift_id = ? ORDER BY created_at ASC, id ASC${detailLimit.sql}`,
      [shiftId]
    );
    const refunds = await db.all(
      `SELECT r.id, r.original_transaction_id, r.items_json, r.subtotal, r.tax, r.total, r.rounding_adjustment,
              r.payment_method, r.reason, r.cashier_id, r.created_at, r.shift_id, r.status,
              t.receipt_number AS original_receipt_number, t.shift_id AS original_shift_id
       FROM refunds r
       LEFT JOIN transactions t ON t.id = r.original_transaction_id
       WHERE r.shift_id = ? ORDER BY r.created_at ASC, r.id ASC${detailLimit.sql}`,
      [shiftId]
    );
    const cash_movements = await db.all(
      `SELECT id, movement_type, amount, description, created_at, transaction_id, refund_id, voucher_id
       FROM shift_cash_movements WHERE shift_id = ? ORDER BY created_at ASC, id ASC${detailLimit.sql}`,
      [shiftId]
    );
    const supplierPayments = await listShiftSupplierPayments(db, shiftId);
    const supplierPaymentRequests = await listShiftSupplierPaymentRequests(db, shiftId);
    const customerCollections = await listShiftCustomerCollections(db, shiftId);
    const customerCashDebts = await listShiftCustomerCashDebts(db, shiftId);
    const advances = await listShiftAdvances(db, shiftId);
    const counts = await db.get(
      `SELECT (SELECT COUNT(*) FROM transactions WHERE shift_id = ?) AS transactions,
              (SELECT COUNT(*) FROM refunds WHERE shift_id = ?) AS refunds,
              (SELECT COUNT(*) FROM shift_cash_movements WHERE shift_id = ?) AS cash_movements`,
      [shiftId, shiftId, shiftId]
    );

    await attachDrawer(db, shift);
    const visa = await computeShiftVisa(db, shiftId);
    applyVisa(shift, visa);

    const cashSummary = {
      cash_sales: shift.cash_sales,
      cash_only_sales: shift.cash_only_sales,
      mixed_cash_sales: shift.mixed_cash_sales,
      cash_refunds: shift.cash_refunds,
      cash_net: shift.cash_net,
      tender_total: shift.tender_total,
      cash_sales_incomplete: !!shift.cash_sales_incomplete,
      cash_sales_label: SHIFT_CASH_SALES_LABEL,
      mixed_cash_label: SHIFT_MIXED_CASH_LABEL,
      mixed_cash_included_note: SHIFT_MIXED_CASH_INCLUDED_NOTE,
      visa_amount_label: SHIFT_VISA_AMOUNT_LABEL,
      tender_total_label: SHIFT_TENDER_TOTAL_LABEL,
      cash_refunds_label: SHIFT_CASH_REFUNDS_LABEL,
      cash_net_label: SHIFT_CASH_NET_LABEL,
      expected_cash_label: SHIFT_EXPECTED_CASH_LABEL,
    };
    const decisions = await listShiftDecisionState(db, shiftId, req.user);
    const summary =
      shift.status === "closed"
        ? {
            expected: round2(Number(shift.expected_cash)),
            expected_by_currency: shift.expected_by_currency,
            actual: round2(Number(shift.closing_cash)),
            counted_cash: shift.counted_cash,
            variance: round2(Number(shift.variance)),
            visa,
            ...cashSummary,
            supplier_payments_total: supplierPayments.total,
            customer_collections_total: customerCollections.total,
            customer_cash_debts_total: customerCashDebts.total,
            advances_total: advances.total,
          }
        : {
            expected: round2(Number(shift.expected_cash)),
            expected_by_currency: shift.expected_by_currency,
            actual: null,
            counted_cash: null,
            variance: null,
            visa,
            ...cashSummary,
            supplier_payments_total: supplierPayments.total,
            customer_collections_total: customerCollections.total,
            customer_cash_debts_total: customerCashDebts.total,
            advances_total: advances.total,
          };
    summary.balanced = decisions.balanced;
    summary.handover_blocks_count = decisions.count_blocked;

    const suspended_summary = await getSuspendedSalesSummary(db, shiftId);

    res.json({
      shift,
      transactions,
      refunds,
      cash_movements,
      supplier_payments: supplierPayments.rows,
      supplier_payment_requests: supplierPaymentRequests,
      customer_collections: customerCollections.rows,
      customer_cash_debts: customerCashDebts.rows,
      advances: advances.rows,
      totals: {
        transactions: Number(counts?.transactions) || 0,
        refunds: Number(counts?.refunds) || 0,
        cash_movements: Number(counts?.cash_movements) || 0,
        supplier_payments: supplierPayments.rows.length,
        customer_collections: customerCollections.rows.length,
        customer_cash_debts: customerCashDebts.rows.length,
        advances: advances.rows.length,
      },
      summary,
      suspended_summary,
      pending_requests: decisions.pending_requests,
      handover_discrepancies: decisions.handover_discrepancies,
      count_blocked: decisions.count_blocked,
    });
  });

  return router;
}
