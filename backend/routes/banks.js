import { Router } from "express";
import { requireAuth, requireAdmin, requireRoles } from "../middleware/auth.js";
import { round2 } from "../utils/tax.js";
const requireReports = requireRoles("admin", "accountant");

export function createBanksRouter(db) {
  const router = Router();

  // ───── Bank Accounts ─────

  router.get("/accounts", requireAuth, async (_req, res) => {
    res.json(await db.all("SELECT * FROM bank_accounts ORDER BY name"));
  });

  router.post("/accounts", requireAuth, requireAdmin, async (req, res) => {
    const { name, bank_name, account_no, currency, notes } = req.body || {};
    if (!name) return res.status(400).json({ error: "اسم الحساب مطلوب", code: "VALIDATION_ERROR" });
    const ins = await db.run(
      "INSERT INTO bank_accounts (name, bank_name, account_no, currency, notes) VALUES (?,?,?,?,?)",
      [String(name).trim(), bank_name || null, account_no || null, currency || "NIS", notes || null]
    );
    res.status(201).json(await db.get("SELECT * FROM bank_accounts WHERE id = ?", [ins.lastID]));
  });

  router.put("/accounts/:id", requireAuth, requireAdmin, async (req, res) => {
    const acc = await db.get("SELECT * FROM bank_accounts WHERE id = ?", [req.params.id]);
    if (!acc) return res.status(404).json({ error: "الحساب غير موجود", code: "NOT_FOUND" });
    const b = req.body || {};
    await db.run(
      "UPDATE bank_accounts SET name=?, bank_name=?, account_no=?, currency=?, notes=? WHERE id=?",
      [
        b.name !== undefined ? String(b.name).trim() : acc.name,
        b.bank_name !== undefined ? (b.bank_name || null) : acc.bank_name,
        b.account_no !== undefined ? (b.account_no || null) : acc.account_no,
        b.currency !== undefined ? (b.currency || "NIS") : acc.currency,
        b.notes !== undefined ? (b.notes || null) : acc.notes,
        req.params.id,
      ]
    );
    res.json(await db.get("SELECT * FROM bank_accounts WHERE id = ?", [req.params.id]));
  });

  // ───── Checks ─────

  router.get("/checks", requireAuth, requireReports, async (req, res) => {
    const { status, type, from, to } = req.query;
    let sql = `SELECT c.*, cu.name as customer_name, su.name as supplier_name
               FROM bank_checks c
               LEFT JOIN customers cu ON c.customer_id = cu.id
               LEFT JOIN suppliers su ON c.supplier_id = su.id
               WHERE 1=1`;
    const params = [];
    if (status) { sql += " AND c.status = ?"; params.push(status); }
    if (type) { sql += " AND c.check_type = ?"; params.push(type); }
    if (from) { sql += " AND c.due_date >= ?"; params.push(from); }
    if (to) { sql += " AND c.due_date <= ?"; params.push(to); }
    sql += " ORDER BY c.due_date ASC, c.created_at DESC LIMIT 500";
    res.json(await db.all(sql, params));
  });

  router.get("/checks/:id", requireAuth, async (req, res) => {
    const row = await db.get("SELECT * FROM bank_checks WHERE id = ?", [req.params.id]);
    if (!row) return res.status(404).json({ error: "الشيك غير موجود", code: "NOT_FOUND" });
    res.json(row);
  });

  router.post("/checks", requireAuth, requireRoles("admin", "accountant"), async (req, res, next) => {
    const {
      check_type, check_no, bank_name, branch, amount, currency, due_date,
      customer_id, supplier_id, bank_account_id, notes,
    } = req.body || {};
    if (!["received", "issued"].includes(check_type)) {
      return res.status(400).json({ error: "نوع الشيك يجب أن يكون received أو issued", code: "VALIDATION_ERROR" });
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: "المبلغ غير صالح", code: "VALIDATION_ERROR" });
    }
    const ins = await db.run(
      `INSERT INTO bank_checks
         (check_type, check_no, bank_name, branch, amount, currency, due_date,
          customer_id, supplier_id, bank_account_id, notes, recorded_by_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        check_type, check_no || null, bank_name || null, branch || null, amt,
        currency || "NIS", due_date || null,
        customer_id ? Number(customer_id) : null,
        supplier_id ? Number(supplier_id) : null,
        bank_account_id ? Number(bank_account_id) : null,
        notes || null,
        req.user.id,
      ]
    );
    res.status(201).json(await db.get("SELECT * FROM bank_checks WHERE id = ?", [ins.lastID]));
  });

  router.patch("/checks/:id/status", requireAuth, requireAdmin, async (req, res) => {
    const check = await db.get("SELECT * FROM bank_checks WHERE id = ?", [req.params.id]);
    if (!check) return res.status(404).json({ error: "الشيك غير موجود", code: "NOT_FOUND" });
    const { status } = req.body || {};
    const allowed = ["pending", "cleared", "bounced", "cancelled"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `الحالة يجب أن تكون: ${allowed.join(" أو ")}`, code: "VALIDATION_ERROR" });
    }

    await db.run("BEGIN IMMEDIATE");
    try {
      await db.run("UPDATE bank_checks SET status = ? WHERE id = ?", [status, check.id]);

      if (check.bank_account_id && status === "cleared") {
        const sign = check.check_type === "received" ? 1 : -1;
        await db.run(
          "UPDATE bank_accounts SET balance = balance + ? WHERE id = ?",
          [round2(sign * check.amount), check.bank_account_id]
        );
      }

      if (check.bank_account_id && check.status === "cleared" && status !== "cleared") {
        const sign = check.check_type === "received" ? -1 : 1;
        await db.run(
          "UPDATE bank_accounts SET balance = balance + ? WHERE id = ?",
          [round2(sign * check.amount), check.bank_account_id]
        );
      }

      await db.run("COMMIT");
    } catch (e) {
      try { await db.run("ROLLBACK"); } catch (_) {}
      return res.status(500).json({ error: e.message, code: "DB_ERROR" });
    }
    res.json(await db.get("SELECT * FROM bank_checks WHERE id = ?", [check.id]));
  });

  // ───── Upcoming checks summary ─────

  router.get("/checks-due", requireAuth, requireReports, async (req, res) => {
    const { days = 7 } = req.query;
    const d = Math.max(1, Number(days) || 7);
    const rows = await db.all(
      `SELECT c.*, cu.name as customer_name, su.name as supplier_name
       FROM bank_checks c
       LEFT JOIN customers cu ON c.customer_id = cu.id
       LEFT JOIN suppliers su ON c.supplier_id = su.id
       WHERE c.status = 'pending' AND c.due_date IS NOT NULL
         AND julianday(c.due_date) <= julianday('now', '+' || ? || ' days')
       ORDER BY c.due_date ASC`,
      [d]
    );
    res.json(rows);
  });

  return router;
}
