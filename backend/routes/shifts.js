import { Router } from "express";
import { requireAuth, requirePosAccess, requireReportsPermission } from "../middleware/auth.js";
import { isAdmin } from "../utils/roles.js";
import { hasAccountantPermission } from "../utils/accountantPermissions.js";
import { getOpenShiftForCashier } from "../middleware/getCurrentShift.js";
import { getAppSettings } from "../utils/settings.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { buildSaleSummary } from "../utils/saleSummary.js";
import {
  sumShiftCardPayments,
  loadSalePayments,
  computeExpectedCash,
  computeExpectedDrawer,
  computeExpectedDrawers,
  resolveCountedCash,
} from "../utils/salePayments.js";
import { listLimitSql } from "../utils/listQuery.js";
import { round2 } from "../utils/money.js";
import { buildReceiptPayload } from "../utils/receipt.js";
import { getSuspendedSalesSummary } from "../services/suspendedSaleService.js";
import { withTransaction } from "../utils/dbTx.js";

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
  const card_total = await sumShiftCardPayments(db, shiftId);
  const refundRow = await db.get(
    `SELECT COALESCE(SUM(total), 0) AS s FROM refunds WHERE shift_id = ? AND status = 'approved'`,
    [shiftId]
  );
  return {
    card_total,
    refund_total: round2(Number(refundRow?.s) || 0),
  };
}

async function canViewShiftDetail(db, user, shift) {
  if (!user || !shift) return false;
  if (isAdmin(user.role)) return true;
  if (user.role === "accountant") {
    const settings = await getAppSettings(db);
    return hasAccountantPermission(user.role, settings.accountant_permissions, "shift_audit");
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
  const expected_cash = await computeExpectedCash(db, shiftId, shift.opening_cash);
  const variance = round2(closing_cash - expected_cash);
  const { card_total, refund_total } = await computeShiftTotals(db, shiftId);
  const needsApproval = Math.abs(variance) > varianceThreshold;
  const endTime = shift.end_time || new Date().toISOString();
  const countedJson = counted_cash ? JSON.stringify(counted_cash) : null;

  await withTransaction(db, async () => {
    await db.run(
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
    await db.run(
      `INSERT INTO shift_cash_movements (shift_id, movement_type, amount, description)
       VALUES (?, 'closing', ?, ?)`,
      [shiftId, closing_cash, closing_notes ? `إغلاق الوردية — ${closing_notes}` : "إغلاق الوردية"]
    );
  });

  const auditAction =
    shift.status === "pending_count" ? AUDIT_ACTIONS.SHIFT_RECONCILE : AUDIT_ACTIONS.SHIFT_CLOSE;
  await logAudit(db, req, auditAction, "cashier_shifts", shiftId, { status: shift.status }, {
    expected_cash,
    actual_cash: closing_cash,
    variance,
    card_total,
    refund_total,
    requires_approval: needsApproval,
  });

  return {
    shift_id: shiftId,
    opening_cash: round2(Number(shift.opening_cash)),
    closing_cash,
    actual_cash: closing_cash,
    expected_cash,
    variance,
    card_total,
    refund_total,
    variance_threshold: varianceThreshold,
    requires_approval: needsApproval,
    counted_cash: counted_cash || null,
    status: "closed",
  };
}

export function createShiftsRouter(db) {
  const router = Router();
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
        const ins = await db.run(
          `INSERT INTO cashier_shifts (cashier_id, opening_cash, status, hourly_rate_snapshot)
           VALUES (?, ?, 'open', (SELECT hourly_rate FROM users WHERE id = ?))`,
          [req.user.id, opening_cash, req.user.id]
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
    res.json({
      shift: {
        id: shift.id,
        cashier_id: shift.cashier_id,
        start_time: shift.start_time,
        opening_cash: shift.opening_cash,
        status: shift.status,
      },
      transactions_count: Number(cnt?.c) || 0,
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
    const sales = [];
    for (const tx of rows) {
      sales.push(await buildSaleSummary(db, tx));
    }
    res.json({
      shift_id: shift.id,
      sales,
      total: Number(countRow?.total) || 0,
      limit,
      offset,
    });
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
    res.json(rows);
  });

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
             s.opening_cash, s.closing_cash, s.expected_cash, s.variance, s.status,
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
    if (dateFrom) {
      sql += " AND date(s.start_time) >= ?";
      params.push(dateFrom);
    }
    if (dateTo) {
      sql += " AND date(s.start_time) <= ?";
      params.push(dateTo);
    }
    sql += " ORDER BY datetime(COALESCE(s.end_time, s.start_time)) DESC, s.id DESC";
    sql += listLimitSql(req.query, 100).sql;
    const rows = await db.all(sql, params);
    for (const row of rows) {
      row.sale_count = Number(row.sale_count) || 0;
    }
    await attachDrawers(db, rows);
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
    const esc = (v) => {
      let s = v == null ? "" : String(v);
      // Formula-injection guard for Excel/Sheets.
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const lines = [
      ["shift_id", "cashier", "start_time", "end_time", "opening_cash", "closing_cash", "expected_cash", "variance", "status"].join(
        ","
      ),
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
      ]
        .map(esc)
        .join(","),
      "",
      "movement_id,type,amount,description,created_at,transaction_id,refund_id",
    ];
    for (const m of movements) {
      lines.push(
        [m.id, m.movement_type, m.amount, m.description ?? "", m.created_at, m.transaction_id ?? "", m.refund_id ?? ""]
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
      try {
        await db.run("ROLLBACK");
      } catch (_) {}
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
      const expected_cash = await computeExpectedCash(db, shiftId, shift.opening_cash);
      const { card_total, refund_total } = await computeShiftTotals(db, shiftId);
      const endTime = new Date().toISOString();

      try {
        await withTransaction(db, async () => {
          await db.run(
            `UPDATE cashier_shifts SET
              end_time = ?, expected_cash = ?, notes = ?, closing_notes = ?,
              card_total = ?, refund_total = ?, status = 'pending_count'
             WHERE id = ? AND status = 'open'`,
            [endTime, expected_cash, notes, closing_notes, card_total, refund_total, shiftId]
          );
        });
        await logAudit(db, req, AUDIT_ACTIONS.SHIFT_CLOSE, "cashier_shifts", shiftId, { status: "open" }, {
          expected_cash,
          card_total,
          refund_total,
          pending_count: true,
        });
      } catch (e) {
        return next(e);
      }

      return res.json({
        shift_id: shiftId,
        status: "pending_count",
        expected_cash,
        card_total,
        refund_total,
        message: "تم إرسال الوردية للمراجعة — سيقوم المدير بعد النقد",
      });
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
      try {
        await db.run("ROLLBACK");
      } catch (_) {}
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
      const payments = await loadSalePayments(db, tid);
      const settings = await getAppSettings(db);

      const lines = (Array.isArray(items) ? items : []).map((it) => ({
        name: it.name || `صنف ${it.product_id}`,
        quantity: Number(it.quantity) || 0,
        price: Number(it.price) || 0,
        lineTotal: (Number(it.quantity) || 0) * (Number(it.price) || 0),
      }));

      const { receipt_text, receipt_html } = buildReceiptPayload({
        transactionId: tid,
        timestamp: tx.created_at,
        cashierName: cashier?.username || "",
        lines,
        subtotal: Number(tx.subtotal),
        tax: Number(tx.tax),
        total: Number(tx.total),
        paymentMethod: tx.payment_method,
        payments,
        changeNis: tx.change_amount,
        settings,
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
      `SELECT id, cashier_id, items_json, subtotal, tax, total, payment_method, receipt_number, created_at, shift_id
       FROM transactions WHERE shift_id = ? ORDER BY created_at ASC, id ASC${detailLimit.sql}`,
      [shiftId]
    );
    const refunds = await db.all(
      `SELECT id, original_transaction_id, items_json, subtotal, tax, total, payment_method, reason, cashier_id, created_at, shift_id
       FROM refunds WHERE shift_id = ? ORDER BY created_at ASC, id ASC${detailLimit.sql}`,
      [shiftId]
    );
    const cash_movements = await db.all(
      `SELECT id, movement_type, amount, description, created_at, transaction_id, refund_id
       FROM shift_cash_movements WHERE shift_id = ? ORDER BY created_at ASC, id ASC${detailLimit.sql}`,
      [shiftId]
    );
    const counts = await db.get(
      `SELECT (SELECT COUNT(*) FROM transactions WHERE shift_id = ?) AS transactions,
              (SELECT COUNT(*) FROM refunds WHERE shift_id = ?) AS refunds,
              (SELECT COUNT(*) FROM shift_cash_movements WHERE shift_id = ?) AS cash_movements`,
      [shiftId, shiftId, shiftId]
    );

    await attachDrawer(db, shift);

    const summary =
      shift.status === "closed"
        ? {
            expected: round2(Number(shift.expected_cash)),
            expected_by_currency: shift.expected_by_currency,
            actual: round2(Number(shift.closing_cash)),
            counted_cash: shift.counted_cash,
            variance: round2(Number(shift.variance)),
          }
        : {
            expected: round2(Number(shift.expected_cash)),
            expected_by_currency: shift.expected_by_currency,
            actual: null,
            counted_cash: null,
            variance: null,
          };

    const suspended_summary = await getSuspendedSalesSummary(db, shiftId);

    res.json({
      shift,
      transactions,
      refunds,
      cash_movements,
      totals: {
        transactions: Number(counts?.transactions) || 0,
        refunds: Number(counts?.refunds) || 0,
        cash_movements: Number(counts?.cash_movements) || 0,
      },
      summary,
      suspended_summary,
    });
  });

  return router;
}
