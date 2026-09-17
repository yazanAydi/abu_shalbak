import { Router } from "express";
import { requireAuth, requireReportsPermission } from "../middleware/auth.js";
import { round2 } from "../utils/tax.js";
import {
  assertExpenseNotLinked,
  isSalaryExpenseCategory,
  postSalaryExpenseFromOffice,
} from "../services/employeePaymentService.js";

const PAY_METHODS = ["cash", "transfer", "check", "other"];

function parseDate(s) {
  if (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return s.trim();
  if (typeof s === "string" && s.trim()) return s.trim().slice(0, 10);
  return null;
}

export function createExpensesRouter(db) {
  const router = Router();
  const requireReports = requireReportsPermission(db, "expenses");

  // ───── Categories ─────

  router.get("/categories", requireAuth, requireReports, async (_req, res) => {
    res.json(await db.all("SELECT * FROM expense_categories ORDER BY active DESC, name_ar, name"));
  });

  router.post("/categories", requireAuth, requireReports, async (req, res) => {
    const { name, name_ar } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "اسم الفئة مطلوب", code: "VALIDATION_ERROR" });
    const ins = await db.run("INSERT INTO expense_categories (name, name_ar) VALUES (?, ?)", [String(name).trim(), name_ar || null]);
    res.status(201).json(await db.get("SELECT * FROM expense_categories WHERE id = ?", [ins.lastID]));
  });

  router.put("/categories/:id", requireAuth, requireReports, async (req, res) => {
    const ex = await db.get("SELECT * FROM expense_categories WHERE id = ?", [req.params.id]);
    if (!ex) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : ex.name;
    const name_ar = b.name_ar !== undefined ? (b.name_ar || null) : ex.name_ar;
    const active = b.active !== undefined ? (b.active ? 1 : 0) : ex.active;
    await db.run("UPDATE expense_categories SET name=?, name_ar=?, active=? WHERE id=?", [name, name_ar, active, req.params.id]);
    res.json(await db.get("SELECT * FROM expense_categories WHERE id = ?", [req.params.id]));
  });

  router.delete("/categories/:id", requireAuth, requireReports, async (req, res) => {
    const used = await db.get("SELECT COUNT(*) AS n FROM operating_expenses WHERE category_id = ?", [req.params.id]);
    if (used.n > 0) {
      await db.run("UPDATE expense_categories SET active = 0 WHERE id = ?", [req.params.id]);
      return res.json({ success: true, deactivated: true });
    }
    await db.run("DELETE FROM expense_categories WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  // ───── Expense vouchers ─────

  router.get("/", requireAuth, requireReports, async (req, res) => {
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    let sql = `SELECT o.*, c.name_ar AS category_name_ar, c.name AS category_name, u.username AS recorded_by_username,
                      e.id AS employee_id, e.name AS employee_name,
                      l.id AS employee_ledger_id, l.purpose AS employee_payment_purpose,
                      l.entry_type AS employee_ledger_entry_type, l.status AS employee_ledger_status
               FROM operating_expenses o
               LEFT JOIN expense_categories c ON c.id = o.category_id
               LEFT JOIN users u ON u.id = o.recorded_by_id
               LEFT JOIN employee_ledger_entries l ON l.operating_expense_id = o.id
               LEFT JOIN employees e ON e.id = l.employee_id
               WHERE 1=1`;
    const params = [];
    if (from) { sql += " AND o.paid_on >= ?"; params.push(from); }
    if (to) { sql += " AND o.paid_on <= ?"; params.push(to); }
    sql += " ORDER BY o.paid_on DESC, o.id DESC LIMIT 500";
    res.json(await db.all(sql, params));
  });

  router.post("/", requireAuth, requireReports, async (req, res, next) => {
    try {
      const { category_id, amount, paid_on, payment_method, reference_note, employee_id, purpose } = req.body || {};
      const cid = Number(category_id);
      const cat = await db.get("SELECT * FROM expense_categories WHERE id = ?", [cid]);
      if (!cat) return res.status(400).json({ error: "فئة غير صالحة", code: "VALIDATION_ERROR" });
      const amt = round2(Number(amount));
      if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: "مبلغ غير صالح", code: "VALIDATION_ERROR" });
      const day = parseDate(paid_on);
      if (!day) return res.status(400).json({ error: "تاريخ غير صالح", code: "VALIDATION_ERROR" });
      const pm = PAY_METHODS.includes(payment_method) ? payment_method : "cash";

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
            category_id: cid,
          },
          req,
          cat
        );
        const row = await db.get(
          `SELECT o.*, c.name_ar AS category_name_ar, c.name AS category_name,
                  e.id AS employee_id, e.name AS employee_name,
                  l.id AS employee_ledger_id, l.purpose AS employee_payment_purpose
           FROM operating_expenses o
           LEFT JOIN expense_categories c ON c.id = o.category_id
           LEFT JOIN employee_ledger_entries l ON l.operating_expense_id = o.id
           LEFT JOIN employees e ON e.id = l.employee_id
           WHERE o.id = ?`,
          [ledger.operating_expense_id]
        );
        return res.status(201).json(row);
      }

      const ins = await db.run(
        `INSERT INTO operating_expenses (category, category_id, amount, paid_on, payment_method, reference_note, recorded_by_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [cat.name, cid, amt, day, pm, reference_note || null, req.user.id]
      );
      const row = await db.get(
        `SELECT o.*, c.name_ar AS category_name_ar, c.name AS category_name
         FROM operating_expenses o LEFT JOIN expense_categories c ON c.id = o.category_id WHERE o.id = ?`,
        [ins.lastID]
      );
      res.status(201).json(row);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  });

  router.delete("/:id", requireAuth, requireReports, async (req, res, next) => {
    try {
      await assertExpenseNotLinked(db, req.params.id);
      const info = await db.run("DELETE FROM operating_expenses WHERE id = ?", [req.params.id]);
      if (info.changes === 0) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
      res.json({ success: true });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      next(e);
    }
  });

  // ───── Reports ─────

  router.get("/summary", requireAuth, requireReports, async (req, res) => {
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    let where = "WHERE 1=1";
    const params = [];
    if (from) { where += " AND paid_on >= ?"; params.push(from); }
    if (to) { where += " AND paid_on <= ?"; params.push(to); }
    const row = await db.get(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM operating_expenses ${where}`, params);
    res.json({ total: round2(Number(row?.total) || 0), count: Number(row?.count) || 0 });
  });

  router.get("/by-category", requireAuth, requireReports, async (req, res) => {
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    let where = "WHERE 1=1";
    const params = [];
    if (from) { where += " AND o.paid_on >= ?"; params.push(from); }
    if (to) { where += " AND o.paid_on <= ?"; params.push(to); }
    const rows = await db.all(
      `SELECT COALESCE(c.id, 0) AS category_id,
              COALESCE(c.name_ar, c.name, o.category, 'غير مصنف') AS category_label,
              COALESCE(SUM(o.amount),0) AS total, COUNT(*) AS count
       FROM operating_expenses o
       LEFT JOIN expense_categories c ON c.id = o.category_id
       ${where}
       GROUP BY COALESCE(c.id, 0), category_label
       ORDER BY total DESC`,
      params
    );
    res.json(rows.map((r) => ({ ...r, total: round2(Number(r.total) || 0) })));
  });

  return router;
}
