import { Router } from "express";
import { requireAuth, requirePosAccess, requireRoles } from "../middleware/auth.js";
import { isAdmin, canViewReports } from "../utils/roles.js";
import { getOpenShiftForCashier } from "../middleware/getCurrentShift.js";
import { getAppSettings } from "../utils/settings.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { refundedQtyByProduct } from "../services/refundRequestService.js";
import { sumShiftCashPayments, sumShiftCardPayments } from "../utils/salePayments.js";
import { getSuspendedSalesSummary } from "../services/suspendedSaleService.js";

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function parseDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return null;
  return s.trim();
}

async function computeExpectedCash(db, shiftId, openingCash) {
  const sid = Number(shiftId);
  const open = round2(Number(openingCash) || 0);
  const cashSales = await sumShiftCashPayments(db, sid);
  const cashRefundsRow = await db.get(
    `SELECT COALESCE(SUM(total), 0) AS s FROM refunds WHERE shift_id = ? AND payment_method = 'cash' AND status = 'approved'`,
    [sid]
  );
  const adjRow = await db.get(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'adjustment'`,
    [sid]
  );
  const cashRefunds = round2(Number(cashRefundsRow?.s) || 0);
  const adjustments = round2(Number(adjRow?.s) || 0);
  return round2(open + cashSales - cashRefunds + adjustments);
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

function canViewShiftDetail(user, shift) {
  if (!user || !shift) return false;
  if (canViewReports(user.role)) return true;
  return Number(shift.cashier_id) === Number(user.id);
}

function parseTransactionItems(itemsJson) {
  try {
    const arr = JSON.parse(itemsJson);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function buildItemsPreview(items, maxItems = 3) {
  const parts = [];
  for (const it of items.slice(0, maxItems)) {
    const name = String(it.name || "").trim() || "صنف";
    const qty = Number(it.quantity) || 0;
    parts.push(qty > 1 ? `${name} ×${qty}` : name);
  }
  if (items.length > maxItems) parts.push("…");
  return parts.join("، ");
}

async function buildSaleSummary(db, tx) {
  const items = parseTransactionItems(tx.items_json);
  const item_count = items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
  const items_preview = buildItemsPreview(items);
  const already = await refundedQtyByProduct(db, tx.id);

  let fully_refunded = items.length > 0;
  for (const it of items) {
    const pid = Number(it.product_id);
    const uid = Number(it.unit_id ?? it.product_unit_id ?? 0);
    const sold = Number(it.quantity) || 0;
    const ref =
      already.get(`${pid}:${uid}`) ??
      already.get(`${pid}:0`) ??
      already.get(pid) ??
      0;
    if (Math.max(0, sold - ref) > 0) {
      fully_refunded = false;
      break;
    }
  }
  if (items.length === 0) fully_refunded = false;

  return {
    transaction_id: tx.id,
    receipt_number: tx.receipt_number || null,
    created_at: tx.created_at,
    total: round2(Number(tx.total)),
    payment_method: tx.payment_method,
    item_count,
    items_preview,
    fully_refunded,
    returnable: !fully_refunded,
  };
}

async function closeShiftWithCash(db, req, shift, closing_cash, notes, closing_notes) {
  const shiftId = shift.id;
  const settings = await getAppSettings(db);
  const varianceThreshold = round2(Number(settings.shift_variance_threshold) || 50);
  const expected_cash = await computeExpectedCash(db, shiftId, shift.opening_cash);
  const variance = round2(closing_cash - expected_cash);
  const { card_total, refund_total } = await computeShiftTotals(db, shiftId);
  const needsApproval = Math.abs(variance) > varianceThreshold;
  const endTime = shift.end_time || new Date().toISOString();

  await db.run("BEGIN IMMEDIATE");
  await db.run(
    `UPDATE cashier_shifts SET
      end_time = ?, closing_cash = ?, actual_cash = ?, expected_cash = ?, variance = ?,
      notes = COALESCE(?, notes), closing_notes = ?, card_total = ?, refund_total = ?,
      variance_threshold = ?, requires_approval = ?, status = 'closed'
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
      shiftId,
    ]
  );
  await db.run(
    `INSERT INTO shift_cash_movements (shift_id, movement_type, amount, description)
     VALUES (?, 'closing', ?, ?)`,
    [shiftId, closing_cash, closing_notes ? `إغلاق الوردية — ${closing_notes}` : "إغلاق الوردية"]
  );
  await db.run("COMMIT");

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
    status: "closed",
  };
}

export function createShiftsRouter(db) {
  const router = Router();

  router.post("/start", requireAuth, requirePosAccess, async (req, res, next) => {
    const settings = await getAppSettings(db);
    const opening_cash = round2(Number(settings.default_opening_cash));
    if (Number.isNaN(opening_cash) || opening_cash < 0) {
      return res.status(400).json({ error: "مبلغ افتتاح الوردية غير صالح في الإعدادات" });
    }
    const existing = await getOpenShiftForCashier(db, req.user.id);
    if (existing) {
      return res.status(409).json({ error: "لديك وردية مفتوحة بالفعل" });
    }
    try {
      await db.run("BEGIN IMMEDIATE");
      const ins = await db.run(
        `INSERT INTO cashier_shifts (cashier_id, opening_cash, status) VALUES (?, ?, 'open')`,
        [req.user.id, opening_cash]
      );
      const shiftId = ins.lastID;
      await db.run(
        `INSERT INTO shift_cash_movements (shift_id, movement_type, amount, description)
         VALUES (?, 'opening', ?, ?)`,
        [shiftId, opening_cash, "افتتاح الوردية"]
      );
      await db.run("COMMIT");
      await logAudit(db, req, AUDIT_ACTIONS.SHIFT_OPEN, "cashier_shifts", shiftId, null, { opening_cash });
      const row = await db.get("SELECT * FROM cashier_shifts WHERE id = ?", [shiftId]);
      res.status(201).json({
        shift_id: shiftId,
        status: row.status,
        opened_at: row.start_time,
        opening_cash,
      });
    } catch (e) {
      try {
        await db.run("ROLLBACK");
      } catch (_) {}
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
    const rows = await db.all(
      `SELECT id, receipt_number, total, payment_method, created_at, items_json
       FROM transactions WHERE shift_id = ? ORDER BY created_at DESC, id DESC`,
      [shift.id]
    );
    const sales = [];
    for (const tx of rows) {
      sales.push(await buildSaleSummary(db, tx));
    }
    res.json({ shift_id: shift.id, sales });
  });

  router.get("/pending", requireAuth, requireRoles("admin", "accountant"), async (req, res) => {
    const rows = await db.all(
      `SELECT s.id, s.cashier_id, u.username AS cashier_name, s.start_time, s.end_time,
              s.opening_cash, s.expected_cash, s.status
       FROM cashier_shifts s
       JOIN users u ON u.id = s.cashier_id
       WHERE s.status = 'pending_count'
       ORDER BY datetime(s.end_time) ASC, s.id ASC`
    );
    res.json(rows);
  });

  router.get("/", requireAuth, requireRoles("admin", "accountant"), async (req, res) => {
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
             s.opening_cash, s.closing_cash, s.expected_cash, s.variance, s.status
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
    const rows = await db.all(sql, params);
    res.json(rows);
  });

  router.get("/:shiftId/cash-movements", requireAuth, async (req, res) => {
    const shiftId = Number(req.params.shiftId);
    if (!shiftId) return res.status(400).json({ error: "معرّف الوردية غير صالح" });
    const shift = await db.get("SELECT * FROM cashier_shifts WHERE id = ?", [shiftId]);
    if (!shift) return res.status(404).json({ error: "الوردية غير موجودة" });
    if (!canViewShiftDetail(req.user, shift)) {
      return res.status(403).json({ error: "ممنوع" });
    }
    const rows = await db.all(
      `SELECT id, movement_type, amount, description, created_at, transaction_id, refund_id
       FROM shift_cash_movements WHERE shift_id = ? ORDER BY created_at ASC, id ASC`,
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
    if (!canViewShiftDetail(req.user, shift)) {
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

  router.post("/:shiftId/adjust", requireAuth, requireRoles("admin", "accountant"), async (req, res, next) => {
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

  router.post("/:shiftId/approve", requireAuth, requireRoles("admin", "accountant"), async (req, res, next) => {
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

  router.post("/:shiftId/reconcile", requireAuth, requireRoles("admin", "accountant"), async (req, res, next) => {
    const shiftId = Number(req.params.shiftId);
    if (!shiftId) return res.status(400).json({ error: "معرّف الوردية غير صالح" });
    const shift = await db.get("SELECT * FROM cashier_shifts WHERE id = ?", [shiftId]);
    if (!shift) return res.status(404).json({ error: "الوردية غير موجودة" });
    if (shift.status !== "pending_count") {
      return res.status(400).json({ error: "الوردية ليست بانتظار العد", code: "NOT_PENDING" });
    }
    const closing_cash = round2(Number((req.body || {}).closing_cash ?? (req.body || {}).actual_cash));
    if (Number.isNaN(closing_cash) || closing_cash < 0) {
      return res.status(400).json({ error: "مبلغ النقد الفعلي غير صالح" });
    }
    const closing_notes =
      (req.body || {}).closing_notes != null
        ? String((req.body || {}).closing_notes).trim()
        : (req.body || {}).notes != null
          ? String((req.body || {}).notes).trim()
          : null;

    try {
      const payload = await closeShiftWithCash(db, req, shift, closing_cash, null, closing_notes);
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
    const closingRaw = (req.body || {}).closing_cash ?? (req.body || {}).actual_cash;
    const hasClosingCash =
      closingRaw !== undefined && closingRaw !== null && String(closingRaw).trim() !== "";

    if (isOwner && !isAdminUser) {
      const expected_cash = await computeExpectedCash(db, shiftId, shift.opening_cash);
      const { card_total, refund_total } = await computeShiftTotals(db, shiftId);
      const endTime = new Date().toISOString();

      try {
        await db.run("BEGIN IMMEDIATE");
        await db.run(
          `UPDATE cashier_shifts SET
            end_time = ?, expected_cash = ?, notes = ?, closing_notes = ?,
            card_total = ?, refund_total = ?, status = 'pending_count'
           WHERE id = ? AND status = 'open'`,
          [endTime, expected_cash, notes, closing_notes, card_total, refund_total, shiftId]
        );
        await db.run("COMMIT");
        await logAudit(db, req, AUDIT_ACTIONS.SHIFT_CLOSE, "cashier_shifts", shiftId, { status: "open" }, {
          expected_cash,
          card_total,
          refund_total,
          pending_count: true,
        });
      } catch (e) {
        try {
          await db.run("ROLLBACK");
        } catch (_) {}
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

    const closing_cash = round2(Number(closingRaw));
    if (Number.isNaN(closing_cash) || closing_cash < 0) {
      return res.status(400).json({ error: "مبلغ إغلاق الوردية غير صالح" });
    }

    try {
      const payload = await closeShiftWithCash(db, req, shift, closing_cash, notes, closing_notes);
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

  router.get("/:shiftId", requireAuth, async (req, res) => {
    const shiftId = Number(req.params.shiftId);
    if (!shiftId) return res.status(400).json({ error: "معرّف الوردية غير صالح" });
    const shift = await db.get(
      `SELECT s.*, u.username AS cashier_name FROM cashier_shifts s JOIN users u ON u.id = s.cashier_id WHERE s.id = ?`,
      [shiftId]
    );
    if (!shift) return res.status(404).json({ error: "الوردية غير موجودة" });
    if (!canViewShiftDetail(req.user, shift)) {
      return res.status(403).json({ error: "ممنوع" });
    }

    const transactions = await db.all(
      `SELECT id, cashier_id, items_json, subtotal, tax, total, payment_method, created_at, shift_id
       FROM transactions WHERE shift_id = ? ORDER BY created_at ASC, id ASC`,
      [shiftId]
    );
    const refunds = await db.all(
      `SELECT id, original_transaction_id, items_json, subtotal, tax, total, payment_method, reason, cashier_id, created_at, shift_id
       FROM refunds WHERE shift_id = ? ORDER BY created_at ASC, id ASC`,
      [shiftId]
    );
    const cash_movements = await db.all(
      `SELECT id, movement_type, amount, description, created_at, transaction_id, refund_id
       FROM shift_cash_movements WHERE shift_id = ? ORDER BY created_at ASC, id ASC`,
      [shiftId]
    );

    let expected_live = null;
    if (shift.status === "open") {
      expected_live = await computeExpectedCash(db, shiftId, shift.opening_cash);
    }

    const summary =
      shift.status === "closed"
        ? {
            expected: round2(Number(shift.expected_cash)),
            actual: round2(Number(shift.closing_cash)),
            variance: round2(Number(shift.variance)),
          }
        : shift.status === "pending_count"
          ? {
              expected: round2(Number(shift.expected_cash)),
              actual: null,
              variance: null,
            }
          : {
              expected: expected_live,
              actual: null,
              variance: null,
            };

    const suspended_summary = await getSuspendedSalesSummary(db, shiftId);

    res.json({
      shift,
      transactions,
      refunds,
      cash_movements,
      summary,
      suspended_summary,
    });
  });

  return router;
}
