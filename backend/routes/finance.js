import { Router } from "express";
import { postSupplierPaymentVoucher } from "./vouchers.js";
import { requireAuth, requireReportsPermission } from "../middleware/auth.js";
import { round2 } from "../utils/money.js";
import { aggregatePaymentLinesForDate } from "../utils/salePayments.js";
import {
  fetchRefundsForShopDate,
  fetchTransactionsForShopDate,
} from "../utils/businessDay.js";
import { nextCalendarYmd } from "../utils/shopTime.js";
import { listLimitSql } from "../utils/listQuery.js";
import { buildFinanceOverview, parseOverviewRange } from "../utils/financeOverview.js";
import {
  assertExpenseNotLinked,
  isSalaryExpenseCategory,
  postSalaryExpenseFromOffice,
} from "../services/employeePaymentService.js";

function parseDateParam(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return null;
  return s.trim();
}

async function shopDayCashCardTotals(db, day) {
  const paymentAgg = await aggregatePaymentLinesForDate(db, day);
  const txRows = await fetchTransactionsForShopDate(db, day);
  let cashChange = 0;
  for (const r of txRows) {
    cashChange = round2(cashChange + Number(r.change_amount || 0));
  }
  const refundRows = await fetchRefundsForShopDate(db, day);
  let refund_cash = 0;
  let refund_card = 0;
  for (const r of refundRows) {
    if (r.payment_method === "cash") refund_cash = round2(refund_cash + Number(r.total));
    else refund_card = round2(refund_card + Number(r.total));
  }
  return {
    sales_cash: round2(paymentAgg.cash_total - cashChange),
    sales_card: paymentAgg.card_total,
    refund_cash,
    refund_card,
  };
}

export function createFinanceRouter(db) {
  const router = Router();

  router.use(requireAuth, requireReportsPermission(db, "finance"));
  const requireSupplierWrites = requireReportsPermission(db, "suppliers");
  const requireVoucherWrites = requireReportsPermission(db, "vouchers");
  const requireExpenseWrites = requireReportsPermission(db, "expenses");
  const requirePurchaseWrites = requireReportsPermission(db, "purchases");

  /** Period financial dashboard (sales / profit) plus current snapshots. */
  router.get("/overview", async (req, res) => {
    const range = parseOverviewRange(req.query);
    if (range.error) {
      return res.status(range.status).json({ error: range.error });
    }
    res.json(await buildFinanceOverview(db, range.from, range.to));
  });

  router.get("/suppliers", async (_req, res) => {
    const rows = await db.all(
      `SELECT id, name, contact_phone, contact_email, notes, created_at
       FROM suppliers ORDER BY name`
    );
    res.json(rows);
  });

  router.post("/suppliers", requireSupplierWrites, async (req, res) => {
    const { name, contact_phone, contact_email, notes } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "الاسم مطلوب" });
    }
    const info = await db.run(
      `INSERT INTO suppliers (name, contact_phone, contact_email, notes)
       VALUES (?, ?, ?, ?)`,
      [
        String(name).trim(),
        contact_phone != null ? String(contact_phone) : null,
        contact_email != null ? String(contact_email) : null,
        notes != null ? String(notes) : null,
      ]
    );
    const row = await db.get("SELECT * FROM suppliers WHERE id = ?", [info.lastID]);
    res.status(201).json(row);
  });

  router.put("/suppliers/:id", requireSupplierWrites, async (req, res) => {
    const id = Number(req.params.id);
    const ex = await db.get("SELECT * FROM suppliers WHERE id = ?", [id]);
    if (!ex) return res.status(404).json({ error: "المورد غير موجود" });
    const b = req.body || {};
    const name = b.name != null ? String(b.name).trim() : ex.name;
    if (!name) return res.status(400).json({ error: "الاسم مطلوب" });
    const contact_phone =
      b.contact_phone !== undefined
        ? b.contact_phone
          ? String(b.contact_phone)
          : null
        : ex.contact_phone;
    const contact_email =
      b.contact_email !== undefined
        ? b.contact_email
          ? String(b.contact_email)
          : null
        : ex.contact_email;
    const notes =
      b.notes !== undefined
        ? b.notes
          ? String(b.notes)
          : null
        : ex.notes;
    await db.run(
      `UPDATE suppliers SET name = ?, contact_phone = ?, contact_email = ?, notes = ? WHERE id = ?`,
      [name, contact_phone, contact_email, notes, id]
    );
    const row = await db.get("SELECT * FROM suppliers WHERE id = ?", [id]);
    res.json(row);
  });

  router.delete("/suppliers/:id", requireSupplierWrites, async (req, res) => {
    const id = Number(req.params.id);
    const ex = await db.get("SELECT * FROM suppliers WHERE id = ?", [id]);
    if (!ex) return res.status(404).json({ error: "المورد غير موجود" });
    const c = await db.get(
      "SELECT COUNT(*) as n FROM supplier_payments WHERE supplier_id = ?",
      [id]
    );
    if (c.n > 0) {
      return res
        .status(400)
        .json({ error: "لا يمكن حذف مورد له سجل دفعات" });
    }
    await db.run("DELETE FROM suppliers WHERE id = ?", [id]);
    res.status(204).send();
  });

  router.get("/payments", async (req, res) => {
    const from = req.query.from ? parseDateParam(req.query.from) : null;
    const to = req.query.to ? parseDateParam(req.query.to) : null;
    const supplierId = req.query.supplier_id
      ? Number(req.query.supplier_id)
      : null;

    let sql = `SELECT
        p.id,
        p.supplier_id,
        s.name AS supplier_name,
        p.amount,
        p.paid_on,
        p.payment_method,
        p.reference_note,
        p.recorded_by_id,
        u.username AS recorded_by_username,
        p.created_at
      FROM supplier_payments p
      JOIN suppliers s ON s.id = p.supplier_id
      LEFT JOIN users u ON u.id = p.recorded_by_id
      WHERE 1=1`;
    const params = [];
    if (from) {
      sql += " AND p.paid_on >= ?";
      params.push(from);
    }
    if (to) {
      sql += " AND p.paid_on <= ?";
      params.push(to);
    }
    if (supplierId) {
      sql += " AND p.supplier_id = ?";
      params.push(supplierId);
    }
    sql += " ORDER BY p.paid_on DESC, p.id DESC";
    sql += listLimitSql(req.query).sql;
    const rows = await db.all(sql, params);
    res.json(rows);
  });

  router.post("/payments", requireVoucherWrites, async (req, res) => {
    const { supplier_id, amount, paid_on, payment_method, reference_note, invoice_id } =
      req.body || {};
    const sid = Number(supplier_id);
    const amt = round2(Number(amount));
    const day = parseDateParam(paid_on) || (typeof paid_on === "string" ? paid_on.trim().slice(0, 10) : null);
    if (!sid || !day) {
      return res.status(400).json({ error: "مطلوب supplier_id و paid_on (YYYY-MM-DD)" });
    }
    if (Number.isNaN(amt) || amt <= 0) {
      return res.status(400).json({ error: "المبلغ يجب أن يكون رقماً موجباً" });
    }
    const sup = await db.get("SELECT id FROM suppliers WHERE id = ?", [sid]);
    if (!sup) return res.status(400).json({ error: "مورد غير صالح" });
    let invId = invoice_id != null && invoice_id !== "" ? Number(invoice_id) : null;
    if (invId) {
      const inv = await db.get("SELECT * FROM supplier_invoices WHERE id = ? AND supplier_id = ?", [invId, sid]);
      if (!inv) return res.status(400).json({ error: "فاتورة غير صالحة لهذا المورد" });
    } else {
      invId = null;
    }
    const methods = ["cash", "transfer", "check", "other"];
    const pm = methods.includes(payment_method) ? payment_method : "transfer";
    const uid = req.user.id;
    const voucher = await postSupplierPaymentVoucher(db, {
      supplierId: sid,
      amount: amt,
      paidOn: day,
      method: pm,
      note: reference_note != null ? String(reference_note) : null,
      userId: uid,
    });
    if (invId) {
      const inv = await db.get("SELECT * FROM supplier_invoices WHERE id = ?", [invId]);
      const newPaid = round2(Number(inv.amount_paid) + amt);
      const at = round2(Number(inv.amount_total));
      const st = at - newPaid < 0.01 ? "closed" : "open";
      const capped = newPaid > at ? at : newPaid;
      await db.run("UPDATE supplier_invoices SET amount_paid = ?, status = ? WHERE id = ?", [
        capped,
        st,
        invId,
      ]);
    }
    const supplier = await db.get("SELECT name FROM suppliers WHERE id = ?", [sid]);
    res.status(201).json({
      id: voucher.id,
      voucher_id: voucher.id,
      supplier_id: sid,
      supplier_name: supplier?.name || null,
      amount: amt,
      paid_on: day,
      payment_method: pm,
      reference_note: reference_note != null ? String(reference_note) : null,
      recorded_by_id: uid,
      representation: "voucher",
    });
  });

  router.delete("/payments/:id", requireVoucherWrites, async (req, res) => {
    const id = Number(req.params.id);
    const info = await db.run("DELETE FROM supplier_payments WHERE id = ?", [id]);
    if (info.changes === 0) return res.status(404).json({ error: "غير موجود" });
    res.status(204).send();
  });

  const OPEX_CATS = ["rent", "utilities", "salaries", "delivery", "fees", "other"];
  const OPEX_LABEL = {
    rent: "إيجار",
    utilities: "مرافق",
    salaries: "رواتب",
    delivery: "توصيل",
    fees: "عمولات/رسوم",
    other: "أخرى",
  };

  router.get("/opex-labels", (_req, res) => {
    res.json({ categories: OPEX_CATS, labels: OPEX_LABEL });
  });

  router.get("/operating-expenses", async (req, res) => {
    const from = req.query.from ? parseDateParam(String(req.query.from)) : null;
    const to = req.query.to ? parseDateParam(String(req.query.to)) : null;
    let sql = `SELECT o.*, u.username AS recorded_by_username
      FROM operating_expenses o
      LEFT JOIN users u ON u.id = o.recorded_by_id
      WHERE 1=1`;
    const params = [];
    if (from) {
      sql += " AND o.paid_on >= ?";
      params.push(from);
    }
    if (to) {
      sql += " AND o.paid_on <= ?";
      params.push(to);
    }
    sql += " ORDER BY o.paid_on DESC, o.id DESC";
    sql += listLimitSql(req.query).sql;
    const rows = await db.all(sql, params);
    res.json(rows);
  });

  router.post("/operating-expenses", requireExpenseWrites, async (req, res, next) => {
    try {
      const { category, amount, paid_on, payment_method, reference_note, employee_id, purpose } = req.body || {};
      const cat = OPEX_CATS.includes(String(category)) ? String(category) : "other";
      const amt = round2(Number(amount));
      const day = parseDateParam(paid_on) || (typeof paid_on === "string" ? String(paid_on).slice(0, 10) : null);
      if (!day) return res.status(400).json({ error: "مطلوب paid_on (YYYY-MM-DD)" });
      if (Number.isNaN(amt) || amt <= 0) return res.status(400).json({ error: "مبلغ غير صالح" });
      const methods = ["cash", "transfer", "check", "other"];
      const pm = methods.includes(payment_method) ? payment_method : "transfer";

      if (isSalaryExpenseCategory(cat)) {
        const ledger = await postSalaryExpenseFromOffice(
          db,
          {
            employee_id,
            purpose,
            amount: amt,
            paid_on: day,
            payment_method: pm,
            reference_note,
            category,
          },
          req,
          { name: cat, category: cat }
        );
        const row = await db.get(
          `SELECT o.*, u.username AS recorded_by_username, e.id AS employee_id, e.name AS employee_name
           FROM operating_expenses o
           LEFT JOIN users u ON u.id = o.recorded_by_id
           LEFT JOIN employee_ledger_entries l ON l.operating_expense_id = o.id
           LEFT JOIN employees e ON e.id = l.employee_id
           WHERE o.id = ?`,
          [ledger.operating_expense_id]
        );
        return res.status(201).json(row);
      }

      const info = await db.run(
        `INSERT INTO operating_expenses (category, amount, paid_on, payment_method, reference_note, recorded_by_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [cat, amt, day, pm, reference_note != null ? String(reference_note) : null, req.user.id]
      );
      const row = await db.get(
        `SELECT o.*, u.username AS recorded_by_username
         FROM operating_expenses o LEFT JOIN users u ON u.id = o.recorded_by_id
         WHERE o.id = ?`,
        [info.lastID]
      );
      res.status(201).json(row);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  });

  router.delete("/operating-expenses/:id", requireExpenseWrites, async (req, res, next) => {
    try {
      await assertExpenseNotLinked(db, req.params.id);
      const id = Number(req.params.id);
      const info = await db.run("DELETE FROM operating_expenses WHERE id = ?", [id]);
      if (info.changes === 0) return res.status(404).json({ error: "غير موجود" });
      res.status(204).send();
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  });

  router.get("/cash/expected", async (req, res) => {
    const day = parseDateParam(String(req.query.date || ""));
    if (!day) return res.status(400).json({ error: "مطلوب date=YYYY-MM-DD" });
    const totals = await shopDayCashCardTotals(db, day);
    res.json({
      date: day,
      expected_cash: round2(totals.sales_cash - totals.refund_cash),
      expected_card: round2(totals.sales_card - totals.refund_card),
      sales_cash: round2(totals.sales_cash),
      sales_card: round2(totals.sales_card),
      refund_cash: totals.refund_cash,
      refund_card: totals.refund_card,
    });
  });

  router.get("/cash/reconciliation", async (req, res) => {
    const day = parseDateParam(String(req.query.date || ""));
    if (!day) return res.status(400).json({ error: "مطلوب date=YYYY-MM-DD" });
    const row = await db.get("SELECT * FROM cash_reconciliations WHERE recon_date = ?", [day]);
    res.json(row || null);
  });

  router.post("/cash/reconciliation", async (req, res) => {
    const { recon_date, counted_cash, note } = req.body || {};
    const day = parseDateParam(recon_date) || (typeof recon_date === "string" ? recon_date.slice(0, 10) : null);
    if (!day) return res.status(400).json({ error: "مطلوب recon_date (YYYY-MM-DD)" });
    const totals = await shopDayCashCardTotals(db, day);
    const expCash = round2(totals.sales_cash - totals.refund_cash);
    const expCard = round2(totals.sales_card - totals.refund_card);
    const got = round2(Number(counted_cash));
    if (Number.isNaN(got)) return res.status(400).json({ error: "مطلوب counted_cash" });
    const overShort = round2(got - expCash);
    const existing = await db.get("SELECT id FROM cash_reconciliations WHERE recon_date = ?", [day]);
    if (existing) {
      await db.run(
        `UPDATE cash_reconciliations SET
          expected_cash = ?, expected_card = ?, counted_cash = ?, over_short = ?, note = ?, recorded_by_id = ?
         WHERE recon_date = ?`,
        [expCash, expCard, got, overShort, note != null ? String(note) : null, req.user.id, day]
      );
    } else {
      await db.run(
        `INSERT INTO cash_reconciliations (recon_date, expected_cash, expected_card, counted_cash, over_short, note, recorded_by_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [day, expCash, expCard, got, overShort, note != null ? String(note) : null, req.user.id]
      );
    }
    const row = await db.get("SELECT * FROM cash_reconciliations WHERE recon_date = ?", [day]);
    res.json(row);
  });

  router.get("/invoices", async (req, res) => {
    const rows = await db.all(
      `SELECT i.*, s.name AS supplier_name
       FROM supplier_invoices i
       JOIN suppliers s ON s.id = i.supplier_id
       ORDER BY i.due_on IS NULL, i.due_on, i.id DESC${listLimitSql(req.query).sql}`
    );
    res.json(rows);
  });

  router.post("/invoices", requirePurchaseWrites, async (req, res) => {
    const { supplier_id, ref_text, amount_total, amount_paid, due_on } = req.body || {};
    const sid = Number(supplier_id);
    const at = round2(Number(amount_total));
    if (!sid || Number.isNaN(at) || at <= 0) {
      return res.status(400).json({ error: "مطلوب supplier_id و amount_total" });
    }
    const ap = amount_paid !== undefined ? round2(Number(amount_paid)) : 0;
    const st = at - ap < 0.01 ? "closed" : "open";
    const due = due_on && /^\d{4}-\d{2}-\d{2}$/.test(String(due_on)) ? String(due_on).trim() : null;
    const info = await db.run(
      `INSERT INTO supplier_invoices (supplier_id, ref_text, amount_total, amount_paid, due_on, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sid, ref_text != null ? String(ref_text) : null, at, ap, due, st]
    );
    const row = await db.get(
      `SELECT i.*, s.name AS supplier_name FROM supplier_invoices i
       JOIN suppliers s ON s.id = i.supplier_id WHERE i.id = ?`,
      [info.lastID]
    );
    res.status(201).json(row);
  });

  router.put("/invoices/:id", requirePurchaseWrites, async (req, res) => {
    const id = Number(req.params.id);
    const ex = await db.get("SELECT * FROM supplier_invoices WHERE id = ?", [id]);
    if (!ex) return res.status(404).json({ error: "غير موجود" });
    const b = req.body || {};
    const ap = b.amount_paid !== undefined ? round2(Number(b.amount_paid)) : ex.amount_paid;
    const at = b.amount_total !== undefined ? round2(Number(b.amount_total)) : ex.amount_total;
    const st = at - ap < 0.01 ? "closed" : "open";
    const due = b.due_on !== undefined ? b.due_on : ex.due_on;
    const refT = b.ref_text !== undefined ? b.ref_text : ex.ref_text;
    await db.run(
      `UPDATE supplier_invoices SET amount_total = ?, amount_paid = ?, due_on = ?, ref_text = ?, status = ? WHERE id = ?`,
      [at, ap, due, refT, st, id]
    );
    const row = await db.get(
      `SELECT i.*, s.name AS supplier_name FROM supplier_invoices i
       JOIN suppliers s ON s.id = i.supplier_id WHERE i.id = ?`,
      [id]
    );
    res.json(row);
  });

  router.get("/export.csv", async (req, res) => {
    const from = parseDateParam(String(req.query.from || ""));
    const to = parseDateParam(String(req.query.to || ""));
    if (!from || !to) return res.status(400).json({ error: "مطلوب from و to (YYYY-MM-DD)" });
    const toExclusive = nextCalendarYmd(to);
    const salesRow = await db.get(
      `SELECT COALESCE(SUM(total),0) t FROM transactions
       WHERE created_at >= ? AND created_at < ?`,
      [from, toExclusive]
    );
    const payRows = await db.all(
      `SELECT * FROM supplier_payments WHERE paid_on >= ? AND paid_on <= ? ORDER BY paid_on`,
      [from, to]
    );
    const opexRows = await db.all(
      `SELECT * FROM operating_expenses WHERE paid_on >= ? AND paid_on <= ? ORDER BY paid_on`,
      [from, to]
    );
    const refRows = await db.all(
      `SELECT id, total, substr(created_at, 1, 10) as d, original_transaction_id, payment_method
       FROM refunds WHERE created_at >= ? AND created_at < ?`,
      [from, toExclusive]
    );
    const lines = [
      `Summary ${from} to ${to}`,
      `Gross sales,${round2(Number(salesRow?.t) || 0)}`,
    ];
    for (const p of payRows) {
      lines.push(`Supplier payment,${p.paid_on},${p.amount},${p.id}`);
    }
    for (const o of opexRows) {
      lines.push(`Opex ${o.category},${o.paid_on},${o.amount},${o.id}`);
    }
    for (const r of refRows) {
      lines.push(`Refund,${r.d},${r.total},refund ${r.id}`);
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="finance-${from}-${to}.csv"`);
    res.send("\uFEFF" + lines.join("\n"));
  });

  return router;
}