import { Router } from "express";
import { requireAuth, requireAdmin, requireRoles } from "../middleware/auth.js";
import { round2 } from "../utils/tax.js";

const requireReports = requireRoles("admin", "accountant");

/**
 * Supplier master data + ledger.
 * supplier.balance is positive when WE OWE the supplier (a payable).
 *  - posted purchase invoice  -> balance += total   (credit / we owe more)
 *  - posted purchase return    -> balance -= total   (debit  / we owe less)
 *  - payment (voucher payment line or legacy supplier_payments) -> balance -= amount (debit)
 */
export function createSuppliersRouter(db) {
  const router = Router();

  router.get("/", requireAuth, async (req, res) => {
    const { q } = req.query;
    let rows;
    if (q) {
      const like = `%${q}%`;
      rows = await db.all(
        `SELECT * FROM suppliers WHERE name LIKE ? OR contact_phone LIKE ? OR supplier_code LIKE ? ORDER BY name LIMIT 200`,
        [like, like, like]
      );
    } else {
      rows = await db.all("SELECT * FROM suppliers ORDER BY name LIMIT 500");
    }
    res.json(rows);
  });

  router.get("/balances", requireAuth, requireReports, async (req, res) => {
    const onlyOpen = String(req.query.only_open || "") === "1";
    const rows = await db.all(
      `SELECT id, supplier_code, name, contact_phone, balance
       FROM suppliers
       ${onlyOpen ? "WHERE ABS(balance) > 0.009" : ""}
       ORDER BY balance DESC, name`
    );
    const totals = await db.get(
      `SELECT COALESCE(SUM(CASE WHEN balance > 0 THEN balance ELSE 0 END),0) AS total_payable,
              COALESCE(SUM(CASE WHEN balance < 0 THEN -balance ELSE 0 END),0) AS total_advance
       FROM suppliers`
    );
    res.json({
      suppliers: rows,
      total_payable: round2(Number(totals?.total_payable) || 0),
      total_advance: round2(Number(totals?.total_advance) || 0),
    });
  });

  router.get("/:id", requireAuth, async (req, res) => {
    const row = await db.get("SELECT * FROM suppliers WHERE id = ?", [req.params.id]);
    if (!row) return res.status(404).json({ error: "المورد غير موجود", code: "NOT_FOUND" });
    res.json(row);
  });

  router.post("/", requireAuth, requireAdmin, async (req, res) => {
    const b = req.body || {};
    const name = b.name ? String(b.name).trim() : "";
    if (!name) return res.status(400).json({ error: "اسم المورد مطلوب", code: "VALIDATION_ERROR" });
    const phone = b.contact_phone ?? b.phone ?? null;
    const opening = round2(Number(b.opening_balance) || 0);
    const ins = await db.run(
      `INSERT INTO suppliers
         (name, contact_phone, contact_email, notes, supplier_code, address, payment_terms, opening_balance, balance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        phone || null,
        b.contact_email || null,
        b.notes || null,
        b.supplier_code ? String(b.supplier_code).trim() : null,
        b.address || null,
        b.payment_terms || null,
        opening,
        opening,
      ]
    );
    const row = await db.get("SELECT * FROM suppliers WHERE id = ?", [ins.lastID]);
    res.status(201).json(row);
  });

  router.put("/:id", requireAuth, requireAdmin, async (req, res) => {
    const ex = await db.get("SELECT * FROM suppliers WHERE id = ?", [req.params.id]);
    if (!ex) return res.status(404).json({ error: "المورد غير موجود", code: "NOT_FOUND" });
    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : ex.name;
    if (!name) return res.status(400).json({ error: "اسم المورد مطلوب", code: "VALIDATION_ERROR" });
    const phone = b.contact_phone !== undefined ? (b.contact_phone || null) : (b.phone !== undefined ? (b.phone || null) : ex.contact_phone);
    const email = b.contact_email !== undefined ? (b.contact_email || null) : ex.contact_email;
    const notes = b.notes !== undefined ? (b.notes || null) : ex.notes;
    const code = b.supplier_code !== undefined ? (b.supplier_code ? String(b.supplier_code).trim() : null) : ex.supplier_code;
    const address = b.address !== undefined ? (b.address || null) : ex.address;
    const terms = b.payment_terms !== undefined ? (b.payment_terms || null) : ex.payment_terms;
    await db.run(
      `UPDATE suppliers SET name=?, contact_phone=?, contact_email=?, notes=?, supplier_code=?, address=?, payment_terms=? WHERE id=?`,
      [name, phone, email, notes, code, address, terms, req.params.id]
    );
    const row = await db.get("SELECT * FROM suppliers WHERE id = ?", [req.params.id]);
    res.json(row);
  });

  router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
    const ex = await db.get("SELECT * FROM suppliers WHERE id = ?", [req.params.id]);
    if (!ex) return res.status(404).json({ error: "المورد غير موجود", code: "NOT_FOUND" });
    if (Math.abs(Number(ex.balance) || 0) > 0.009) {
      return res.status(400).json({ error: "لا يمكن حذف مورد برصيد غير صفري", code: "NON_ZERO_BALANCE" });
    }
    const inv = await db.get("SELECT COUNT(*) AS n FROM purchase_invoices WHERE supplier_id = ?", [req.params.id]);
    if (inv.n > 0) return res.status(400).json({ error: "لا يمكن حذف مورد له فواتير", code: "HAS_INVOICES" });
    await db.run("DELETE FROM suppliers WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  // ───── Ledger + statement ─────

  async function buildLedger(db, supplier, from, to) {
    const id = supplier.id;
    const dateClause = (col) => {
      let c = "";
      const p = [];
      if (from) { c += ` AND ${col} >= ?`; p.push(from); }
      if (to) { c += ` AND ${col} <= ?`; p.push(to + (col.includes("date") ? "" : "T23:59:59")); }
      return { c, p };
    };
    const pinv = dateClause("invoice_date");
    const pret = dateClause("return_date");
    const vpay = dateClause("v.voucher_date");
    const lpay = dateClause("paid_on");

    const events = await db.all(
      `SELECT 'purchase' AS ev_type, invoice_date AS ev_date, total AS credit, 0 AS debit, id AS ref_id
         FROM purchase_invoices WHERE supplier_id = ? AND status = 'posted' ${pinv.c}
       UNION ALL
       SELECT 'purchase_return' AS ev_type, return_date AS ev_date, 0 AS credit, total AS debit, id AS ref_id
         FROM purchase_returns WHERE supplier_id = ? AND status = 'posted' ${pret.c}
       UNION ALL
       SELECT 'payment' AS ev_type, v.voucher_date AS ev_date, 0 AS credit, vl.amount_nis AS debit, v.id AS ref_id
         FROM voucher_lines vl JOIN vouchers v ON v.id = vl.voucher_id
         WHERE vl.supplier_id = ? AND v.voucher_type = 'payment' AND v.status = 'posted' ${vpay.c}
       UNION ALL
       SELECT 'payment' AS ev_type, paid_on AS ev_date, 0 AS credit, amount AS debit, id AS ref_id
         FROM supplier_payments WHERE supplier_id = ? ${lpay.c}
       ORDER BY ev_date ASC`,
      [id, ...pinv.p, id, ...pret.p, id, ...vpay.p, id, ...lpay.p]
    );

    let running = round2(Number(supplier.opening_balance) || 0);
    const opening = { ev_type: "opening", ev_date: null, debit: 0, credit: running > 0 ? running : 0, ref_id: null, running_balance: running };
    const rows = events.map((e) => {
      running = round2(running + e.credit - e.debit);
      return { ...e, running_balance: running };
    });
    return { opening, events: rows, closing_balance: running };
  }

  router.get("/:id/ledger", requireAuth, requireReports, async (req, res) => {
    const supplier = await db.get("SELECT * FROM suppliers WHERE id = ?", [req.params.id]);
    if (!supplier) return res.status(404).json({ error: "المورد غير موجود", code: "NOT_FOUND" });
    const { from, to } = req.query;
    const led = await buildLedger(db, supplier, from, to);
    res.json({ supplier, ...led });
  });

  router.get("/:id/statement", requireAuth, requireReports, async (req, res) => {
    const supplier = await db.get("SELECT * FROM suppliers WHERE id = ?", [req.params.id]);
    if (!supplier) return res.status(404).json({ error: "المورد غير موجود", code: "NOT_FOUND" });
    const { from, to } = req.query;
    const led = await buildLedger(db, supplier, from, to);
    res.json({ supplier, ...led });
  });

  return router;
}
