import { Router } from "express";
import { requireAuth, requireReportsPermission } from "../middleware/auth.js";
import {
  snapshotSalesCogsForRange,
  snapshotRefundCogsForRange,
} from "../utils/cogs.js";
import { round2 } from "../utils/money.js";
import {
  TX_BUSINESS_DAY_JOIN,
  REFUND_BUSINESS_DAY_JOIN,
  txBusinessDayBetween,
  refundBusinessDayBetween,
} from "../utils/businessDay.js";

function parseDateParam(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return null;
  return s.trim();
}

export function createFinanceRouter(db) {
  const router = Router();

  router.use(requireAuth, requireReportsPermission(db, "finance"));

  /** Sales total + supplier payments in date range (financial overview) */
  router.get("/overview", async (req, res) => {
    const from = parseDateParam(req.query.from);
    const to = parseDateParam(req.query.to);
    if (!from || !to) {
      return res.status(400).json({ error: "مطلوب from و to بصيغة YYYY-MM-DD" });
    }
    if (from > to) {
      return res.status(400).json({ error: "from يجب أن يكون قبل to أو يساويه" });
    }

    const salesRow = await db.get(
      `SELECT COALESCE(SUM(t.total), 0) as total, COUNT(*) as n
       FROM transactions t
       ${TX_BUSINESS_DAY_JOIN}
       WHERE ${txBusinessDayBetween("?", "?")}`,
      [from, to]
    );

    const payRow = await db.get(
      `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as n
       FROM supplier_payments
       WHERE paid_on >= ? AND paid_on <= ?`,
      [from, to]
    );

    const refRow = await db.get(
      `SELECT COALESCE(SUM(r.total), 0) as total, COUNT(*) as n
       FROM refunds r
       ${REFUND_BUSINESS_DAY_JOIN}
       WHERE ${refundBusinessDayBetween("?", "?")}`,
      [from, to]
    );
    const expRow = await db.get(
      `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as n
       FROM operating_expenses
       WHERE paid_on >= ? AND paid_on <= ?`,
      [from, to]
    );

    const posGross = round2(Number(salesRow?.total) || 0);
    const refundTotal = round2(Number(refRow?.total) || 0);
    const netPos = round2(posGross - refundTotal);

    // Historical COGS from sale-item snapshots (immune to later cost changes).
    const cogsSales = await snapshotSalesCogsForRange(db, from, to);
    const cogsRefunds = await snapshotRefundCogsForRange(db, from, to);
    const netCogs = round2(cogsSales - cogsRefunds);
    const estGrossProfit = round2(netPos - netCogs);

    const inv = await db.get(
      `SELECT
         COALESCE(SUM(stock * cost), 0) AS at_cost,
         COALESCE(SUM(stock * price), 0) AS at_retail
       FROM products`
    );
    const apRow = await db.get(
      `SELECT COALESCE(SUM(amount_total - amount_paid), 0) as outstanding, COUNT(*) as n
       FROM supplier_invoices
       WHERE status = 'open' AND (amount_total - amount_paid) > 0.009`
    );

    res.json({
      from,
      to,
      pos_sales_total: posGross,
      pos_transaction_count: Number(salesRow?.n) || 0,
      refunds_total: refundTotal,
      refund_count: Number(refRow?.n) || 0,
      net_pos_sales: netPos,
      operating_expenses_total: round2(Number(expRow?.total) || 0),
      operating_expense_count: Number(expRow?.n) || 0,
      supplier_payments_total: round2(Number(payRow?.total) || 0),
      supplier_payment_count: Number(payRow?.n) || 0,
      estimated_cogs_on_sales: cogsSales,
      estimated_cogs_on_refunds: cogsRefunds,
      net_estimated_cogs: netCogs,
      estimated_gross_profit: estGrossProfit,
      inventory_value_at_cost: round2(Number(inv?.at_cost) || 0),
      inventory_value_at_retail: round2(Number(inv?.at_retail) || 0),
      open_payables_total: round2(Number(apRow?.outstanding) || 0),
      open_invoices_count: Number(apRow?.n) || 0,
    });
  });

  router.get("/suppliers", async (_req, res) => {
    const rows = await db.all(
      `SELECT id, name, contact_phone, contact_email, notes, created_at
       FROM suppliers ORDER BY name`
    );
    res.json(rows);
  });

  router.post("/suppliers", async (req, res) => {
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

  router.put("/suppliers/:id", async (req, res) => {
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

  router.delete("/suppliers/:id", async (req, res) => {
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
    const rows = await db.all(sql, params);
    res.json(rows);
  });

  router.post("/payments", async (req, res) => {
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
    const info = await db.run(
      `INSERT INTO supplier_payments
        (supplier_id, amount, paid_on, payment_method, reference_note, recorded_by_id, invoice_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        sid,
        amt,
        day,
        pm,
        reference_note != null ? String(reference_note) : null,
        uid,
        invId,
      ]
    );
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
    const row = await db.get(
      `SELECT
        p.id, p.supplier_id, s.name AS supplier_name, p.amount, p.paid_on,
        p.payment_method, p.reference_note, p.recorded_by_id, u.username AS recorded_by_username, p.created_at
       FROM supplier_payments p
       JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN users u ON u.id = p.recorded_by_id
       WHERE p.id = ?`,
      [info.lastID]
    );
    res.status(201).json(row);
  });

  router.delete("/payments/:id", async (req, res) => {
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
    const rows = await db.all(sql, params);
    res.json(rows);
  });

  router.post("/operating-expenses", async (req, res) => {
    const { category, amount, paid_on, payment_method, reference_note } = req.body || {};
    const cat = OPEX_CATS.includes(String(category)) ? String(category) : "other";
    const amt = round2(Number(amount));
    const day = parseDateParam(paid_on) || (typeof paid_on === "string" ? String(paid_on).slice(0, 10) : null);
    if (!day) return res.status(400).json({ error: "مطلوب paid_on (YYYY-MM-DD)" });
    if (Number.isNaN(amt) || amt <= 0) return res.status(400).json({ error: "مبلغ غير صالح" });
    const methods = ["cash", "transfer", "check", "other"];
    const pm = methods.includes(payment_method) ? payment_method : "transfer";
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
  });

  router.delete("/operating-expenses/:id", async (req, res) => {
    const id = Number(req.params.id);
    const info = await db.run("DELETE FROM operating_expenses WHERE id = ?", [id]);
    if (info.changes === 0) return res.status(404).json({ error: "غير موجود" });
    res.status(204).send();
  });

  router.get("/cash/expected", async (req, res) => {
    const day = parseDateParam(String(req.query.date || ""));
    if (!day) return res.status(400).json({ error: "مطلوب date=YYYY-MM-DD" });
    const cashR = await db.get(
      `SELECT COALESCE(SUM(sp.amount),0) t, COUNT(DISTINCT sp.transaction_id) n
       FROM sale_payments sp
       INNER JOIN transactions t ON t.id = sp.transaction_id
       WHERE date(t.created_at) = ? AND sp.payment_method = 'cash'`,
      [day]
    );
    const cardR = await db.get(
      `SELECT COALESCE(SUM(sp.amount),0) t, COUNT(DISTINCT sp.transaction_id) n
       FROM sale_payments sp
       INNER JOIN transactions t ON t.id = sp.transaction_id
       WHERE date(t.created_at) = ? AND sp.payment_method = 'visa'`,
      [day]
    );
    const refCash = await db.get(
      `SELECT COALESCE(SUM(total),0) t FROM refunds
       WHERE date(created_at) = ? AND payment_method = 'cash'`,
      [day]
    );
    const refCard = await db.get(
      `SELECT COALESCE(SUM(total),0) t FROM refunds
       WHERE date(created_at) = ? AND payment_method = 'visa'`,
      [day]
    );
    res.json({
      date: day,
      expected_cash: round2(Number(cashR?.t) - Number(refCash?.t)),
      expected_card: round2(Number(cardR?.t) - Number(refCard?.t)),
      sales_cash: round2(Number(cashR?.t) || 0),
      sales_card: round2(Number(cardR?.t) || 0),
      refund_cash: round2(Number(refCash?.t) || 0),
      refund_card: round2(Number(refCard?.t) || 0),
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
    const cashR = await db.get(
      `SELECT COALESCE(SUM(sp.amount),0) t FROM sale_payments sp
       INNER JOIN transactions t ON t.id = sp.transaction_id
       WHERE date(t.created_at) = ? AND sp.payment_method = 'cash'`,
      [day]
    );
    const cardR = await db.get(
      `SELECT COALESCE(SUM(sp.amount),0) t FROM sale_payments sp
       INNER JOIN transactions t ON t.id = sp.transaction_id
       WHERE date(t.created_at) = ? AND sp.payment_method = 'visa'`,
      [day]
    );
    const refCash = await db.get(
      `SELECT COALESCE(SUM(total),0) t FROM refunds
       WHERE date(created_at) = ? AND payment_method = 'cash'`,
      [day]
    );
    const refCard = await db.get(
      `SELECT COALESCE(SUM(total),0) t FROM refunds
       WHERE date(created_at) = ? AND payment_method = 'visa'`,
      [day]
    );
    const expCash = round2(Number(cashR?.t) - Number(refCash?.t));
    const expCard = round2(Number(cardR?.t) - Number(refCard?.t));
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

  router.get("/invoices", async (_req, res) => {
    const rows = await db.all(
      `SELECT i.*, s.name AS supplier_name
       FROM supplier_invoices i
       JOIN suppliers s ON s.id = i.supplier_id
       ORDER BY i.due_on IS NULL, i.due_on, i.id DESC`
    );
    res.json(rows);
  });

  router.post("/invoices", async (req, res) => {
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

  router.put("/invoices/:id", async (req, res) => {
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
    const salesRow = await db.get(
      `SELECT COALESCE(SUM(total),0) t FROM transactions
       WHERE date(created_at) >= ? AND date(created_at) <= ?`,
      [from, to]
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
      `SELECT id, total, date(created_at) as d, original_transaction_id, payment_method
       FROM refunds WHERE date(created_at) >= ? AND date(created_at) <= ?`,
      [from, to]
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