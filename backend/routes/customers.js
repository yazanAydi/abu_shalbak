import { Router } from "express";
import { requireAuth, requireAdmin, requireRoles } from "../middleware/auth.js";
import { round2 } from "../utils/tax.js";
const requireReports = requireRoles("admin", "accountant");

const CUSTOMER_CATEGORIES = ["retail", "wholesale", "vip", "credit", "corporate"];
function normalizeCategory(c) {
  return CUSTOMER_CATEGORIES.includes(String(c)) ? String(c) : "retail";
}

export function createCustomersRouter(db) {
  const router = Router();

  router.get("/", requireAuth, async (req, res) => {
    const { q } = req.query;
    let rows;
    if (q) {
      const like = `%${q}%`;
      rows = await db.all(
        `SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? OR customer_code LIKE ? ORDER BY name LIMIT 100`,
        [like, like, like]
      );
    } else {
      rows = await db.all("SELECT * FROM customers ORDER BY name LIMIT 500");
    }
    res.json(rows);
  });

  // ───── Categories (reference) ─────
  router.get("/meta/categories", requireAuth, (_req, res) => {
    res.json({
      categories: CUSTOMER_CATEGORIES,
      labels: {
        retail: "مفرق",
        wholesale: "جملة",
        vip: "مميز VIP",
        credit: "عميل آجل",
        corporate: "شركات",
      },
    });
  });

  // ───── Balances report (all customers with a balance) ─────
  router.get("/balances", requireAuth, requireReports, async (req, res) => {
    const onlyOpen = String(req.query.only_open || "") === "1";
    const rows = await db.all(
      `SELECT id, customer_code, name, phone, price_category, credit_limit, balance
       FROM customers
       ${onlyOpen ? "WHERE ABS(balance) > 0.009" : ""}
       ORDER BY balance DESC, name`
    );
    const totals = await db.get(
      `SELECT COALESCE(SUM(CASE WHEN balance > 0 THEN balance ELSE 0 END),0) AS total_due,
              COALESCE(SUM(CASE WHEN balance < 0 THEN -balance ELSE 0 END),0) AS total_credit
       FROM customers`
    );
    res.json({
      customers: rows,
      total_due: round2(Number(totals?.total_due) || 0),
      total_credit: round2(Number(totals?.total_credit) || 0),
    });
  });

  router.get("/:id", requireAuth, async (req, res) => {
    const row = await db.get("SELECT * FROM customers WHERE id = ?", [req.params.id]);
    if (!row) return res.status(404).json({ error: "العميل غير موجود", code: "NOT_FOUND" });
    res.json(row);
  });

  router.post("/", requireAuth, requireAdmin, async (req, res) => {
    const {
      name, phone, phone2, address, city, price_category, credit_limit, notes,
      customer_code, payment_terms, opening_balance,
    } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "اسم العميل مطلوب", code: "VALIDATION_ERROR" });
    }
    const limit = Number(credit_limit) || 0;
    const opening = round2(Number(opening_balance) || 0);
    const ins = await db.run(
      `INSERT INTO customers
        (name, phone, phone2, address, city, price_category, credit_limit, notes,
         customer_code, payment_terms, opening_balance, balance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(name).trim(),
        phone || null,
        phone2 || null,
        address || null,
        city || null,
        normalizeCategory(price_category),
        limit,
        notes || null,
        customer_code ? String(customer_code).trim() : null,
        payment_terms || null,
        opening,
        opening,
      ]
    );
    const row = await db.get("SELECT * FROM customers WHERE id = ?", [ins.lastID]);
    res.status(201).json(row);
  });

  router.put("/:id", requireAuth, requireAdmin, async (req, res) => {
    const existing = await db.get("SELECT * FROM customers WHERE id = ?", [req.params.id]);
    if (!existing) return res.status(404).json({ error: "العميل غير موجود", code: "NOT_FOUND" });
    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : existing.name;
    const phone = b.phone !== undefined ? (b.phone || null) : existing.phone;
    const phone2 = b.phone2 !== undefined ? (b.phone2 || null) : existing.phone2;
    const address = b.address !== undefined ? (b.address || null) : existing.address;
    const city = b.city !== undefined ? (b.city || null) : existing.city;
    const price_category = b.price_category !== undefined ? normalizeCategory(b.price_category) : existing.price_category;
    const credit_limit = b.credit_limit !== undefined ? Number(b.credit_limit) : existing.credit_limit;
    const no_credit = b.no_credit !== undefined ? (b.no_credit ? 1 : 0) : existing.no_credit;
    const notes = b.notes !== undefined ? (b.notes || null) : existing.notes;
    const customer_code = b.customer_code !== undefined ? (b.customer_code ? String(b.customer_code).trim() : null) : existing.customer_code;
    const payment_terms = b.payment_terms !== undefined ? (b.payment_terms || null) : existing.payment_terms;
    await db.run(
      `UPDATE customers SET name=?, phone=?, phone2=?, address=?, city=?, price_category=?,
          credit_limit=?, no_credit=?, notes=?, customer_code=?, payment_terms=? WHERE id=?`,
      [name, phone, phone2, address, city, price_category, credit_limit, no_credit, notes, customer_code, payment_terms, req.params.id]
    );
    const row = await db.get("SELECT * FROM customers WHERE id = ?", [req.params.id]);
    res.json(row);
  });

  router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
    const existing = await db.get("SELECT * FROM customers WHERE id = ?", [req.params.id]);
    if (!existing) return res.status(404).json({ error: "العميل غير موجود", code: "NOT_FOUND" });
    if (existing.balance !== 0) {
      return res.status(400).json({ error: "لا يمكن حذف عميل برصيد غير صفري", code: "NON_ZERO_BALANCE" });
    }
    await db.run("DELETE FROM customers WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  // ───── Statement of Account ─────

  router.get("/:id/statement", requireAuth, requireReports, async (req, res) => {
    const { from, to } = req.query;
    const customer = await db.get("SELECT * FROM customers WHERE id = ?", [req.params.id]);
    if (!customer) return res.status(404).json({ error: "العميل غير موجود", code: "NOT_FOUND" });

    const params = [req.params.id, req.params.id];
    let dateFilter = "";
    if (from) { dateFilter += " AND ev_date >= ?"; params.push(from); }
    if (to) { dateFilter += " AND ev_date <= ?"; params.push(to + "T23:59:59"); }

    const events = await db.all(
      `SELECT 'sale' AS ev_type, t.created_at AS ev_date, t.total AS debit, 0 AS credit,
          t.id AS ref_id, t.payment_method
       FROM transactions t
       WHERE t.customer_id = ? AND t.payment_method = 'on_account' ${dateFilter}
       UNION ALL
       SELECT 'refund' AS ev_type, r.created_at AS ev_date, 0 AS debit, r.total AS credit,
          r.id AS ref_id, 'refund' AS payment_method
       FROM refunds r
       WHERE r.customer_id = ? AND r.status = 'approved' ${dateFilter}
       ORDER BY ev_date ASC`,
      params
    );

    let running = 0;
    const rows = events.map((e) => {
      running = round2(running + e.debit - e.credit);
      return { ...e, running_balance: running };
    });
    res.json({ customer, events: rows });
  });

  // ───── Full ledger (opening + sales + returns + payments) ─────

  router.get("/:id/ledger", requireAuth, requireReports, async (req, res) => {
    const { from, to } = req.query;
    const customer = await db.get("SELECT * FROM customers WHERE id = ?", [req.params.id]);
    if (!customer) return res.status(404).json({ error: "العميل غير موجود", code: "NOT_FOUND" });

    const id = req.params.id;
    const dateClause = (col) => {
      let c = "";
      const p = [];
      if (from) { c += ` AND ${col} >= ?`; p.push(from); }
      if (to) { c += ` AND ${col} <= ?`; p.push(to + "T23:59:59"); }
      return { c, p };
    };

    const sales = dateClause("t.created_at");
    const refs = dateClause("r.created_at");
    const pays = dateClause("v.voucher_date");

    const events = await db.all(
      `SELECT 'sale' AS ev_type, t.created_at AS ev_date, t.total AS debit, 0 AS credit, t.id AS ref_id
         FROM transactions t
         WHERE t.customer_id = ? AND t.payment_method = 'on_account' ${sales.c}
       UNION ALL
       SELECT 'refund' AS ev_type, r.created_at AS ev_date, 0 AS debit, r.total AS credit, r.id AS ref_id
         FROM refunds r
         WHERE r.customer_id = ? AND r.status = 'approved' ${refs.c}
       UNION ALL
       SELECT 'payment' AS ev_type, v.voucher_date AS ev_date, 0 AS debit, vl.amount_nis AS credit, v.id AS ref_id
         FROM voucher_lines vl
         JOIN vouchers v ON v.id = vl.voucher_id
         WHERE vl.customer_id = ? AND v.voucher_type = 'receipt' AND v.status = 'posted' ${pays.c}
       ORDER BY ev_date ASC`,
      [id, ...sales.p, id, ...refs.p, id, ...pays.p]
    );

    let running = round2(Number(customer.opening_balance) || 0);
    const opening = {
      ev_type: "opening",
      ev_date: null,
      debit: running > 0 ? running : 0,
      credit: running < 0 ? -running : 0,
      ref_id: null,
      running_balance: running,
    };
    const rows = events.map((e) => {
      running = round2(running + e.debit - e.credit);
      return { ...e, running_balance: running };
    });
    res.json({ customer, opening, events: rows, closing_balance: running });
  });

  // ───── Payment history (receipt vouchers) ─────

  router.get("/:id/payments", requireAuth, requireReports, async (req, res) => {
    const customer = await db.get("SELECT * FROM customers WHERE id = ?", [req.params.id]);
    if (!customer) return res.status(404).json({ error: "العميل غير موجود", code: "NOT_FOUND" });
    const rows = await db.all(
      `SELECT v.id AS voucher_id, v.voucher_no, v.voucher_date, v.status,
              vl.amount, vl.amount_nis, vl.line_type, vl.description, u.username AS recorded_by
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       LEFT JOIN users u ON u.id = v.recorded_by_id
       WHERE vl.customer_id = ? AND v.voucher_type = 'receipt'
       ORDER BY v.voucher_date DESC, v.id DESC`,
      [req.params.id]
    );
    res.json(rows);
  });

  // ───── Bulk credit payment ─────

  router.post("/:id/payment", requireAuth, requireAdmin, async (req, res) => {
    const customer = await db.get("SELECT * FROM customers WHERE id = ?", [req.params.id]);
    if (!customer) return res.status(404).json({ error: "العميل غير موجود", code: "NOT_FOUND" });
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "المبلغ غير صالح", code: "VALIDATION_ERROR" });
    }
    const newBalance = round2(customer.balance - amount);
    await db.run("UPDATE customers SET balance = ? WHERE id = ?", [newBalance, customer.id]);
    res.json({ success: true, new_balance: newBalance });
  });

  return router;
}
