import { Router } from "express";
import { requireAuth, requireAdmin, requireRoles } from "../middleware/auth.js";
import { round2 } from "../utils/tax.js";
const requireReports = requireRoles("admin", "accountant");

export function createVouchersRouter(db) {
  const router = Router();

  // ───── Voucher list ─────

  router.get("/", requireAuth, requireReports, async (req, res) => {
    const { type, status, from, to } = req.query;
    let sql = `SELECT v.*, u.username as recorded_by_name
               FROM vouchers v LEFT JOIN users u ON v.recorded_by_id = u.id
               WHERE 1=1`;
    const params = [];
    if (type) { sql += " AND v.voucher_type = ?"; params.push(type); }
    if (status) { sql += " AND v.status = ?"; params.push(status); }
    if (from) { sql += " AND v.voucher_date >= ?"; params.push(from); }
    if (to) { sql += " AND v.voucher_date <= ?"; params.push(to); }
    sql += " ORDER BY v.voucher_date DESC, v.id DESC LIMIT 500";
    res.json(await db.all(sql, params));
  });

  router.get("/:id", requireAuth, async (req, res) => {
    const voucher = await db.get(
      `SELECT v.*, u.username as recorded_by_name
       FROM vouchers v LEFT JOIN users u ON v.recorded_by_id = u.id
       WHERE v.id = ?`,
      [req.params.id]
    );
    if (!voucher) return res.status(404).json({ error: "السند غير موجود", code: "NOT_FOUND" });
    const lines = await db.all(
      `SELECT vl.*, c.name as customer_name, s.name as supplier_name
       FROM voucher_lines vl
       LEFT JOIN customers c ON vl.customer_id = c.id
       LEFT JOIN suppliers s ON vl.supplier_id = s.id
       WHERE vl.voucher_id = ? ORDER BY vl.id`,
      [voucher.id]
    );
    res.json({ ...voucher, lines });
  });

  // ───── Create draft voucher ─────

  router.post("/", requireAuth, requireRoles("admin", "accountant"), async (req, res, next) => {
    const { voucher_type, voucher_date, notes, lines } = req.body || {};
    if (!["receipt", "payment"].includes(voucher_type)) {
      return res.status(400).json({
        error: "نوع السند يجب أن يكون receipt أو payment",
        code: "VALIDATION_ERROR",
      });
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: "أسطر السند مطلوبة", code: "VALIDATION_ERROR" });
    }

    for (const L of lines) {
      const amt = Number(L.amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ error: "مبلغ السطر غير صالح", code: "VALIDATION_ERROR" });
      }
      if (!["cash", "check", "bank"].includes(L.line_type)) {
        return res.status(400).json({ error: "نوع السطر يجب أن يكون cash أو check أو bank", code: "VALIDATION_ERROR" });
      }
    }

    const total = round2(lines.reduce((s, L) => s + Number(L.amount), 0));

    await db.run("BEGIN IMMEDIATE");
    try {
      const ins = await db.run(
        `INSERT INTO vouchers (voucher_type, voucher_date, notes, total_amount, recorded_by_id)
         VALUES (?, ?, ?, ?, ?)`,
        [voucher_type, voucher_date || new Date().toISOString().slice(0, 10), notes || null, total, req.user.id]
      );
      const voucherId = ins.lastID;

      // Set sequential voucher_no per type
      const maxNo = await db.get(
        "SELECT MAX(voucher_no) AS mx FROM vouchers WHERE voucher_type = ?",
        [voucher_type]
      );
      const nextNo = ((maxNo?.mx) || 0) + 1;
      await db.run("UPDATE vouchers SET voucher_no = ? WHERE id = ?", [nextNo, voucherId]);

      for (const L of lines) {
        const amt = Number(L.amount);
        const rate = Number(L.exchange_rate) || 1;
        const amtNis = round2(amt * rate);
        await db.run(
          `INSERT INTO voucher_lines
             (voucher_id, line_type, amount, currency, exchange_rate, amount_nis,
              customer_id, supplier_id, check_id, bank_account_id, account_category, description)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            voucherId, L.line_type, amt, L.currency || "NIS", rate, amtNis,
            L.customer_id ? Number(L.customer_id) : null,
            L.supplier_id ? Number(L.supplier_id) : null,
            L.check_id ? Number(L.check_id) : null,
            L.bank_account_id ? Number(L.bank_account_id) : null,
            L.account_category || null,
            L.description || null,
          ]
        );
      }

      await db.run("COMMIT");
      const voucher = await db.get("SELECT * FROM vouchers WHERE id = ?", [voucherId]);
      const savedLines = await db.all("SELECT * FROM voucher_lines WHERE voucher_id = ?", [voucherId]);
      res.status(201).json({ ...voucher, lines: savedLines });
    } catch (e) {
      try { await db.run("ROLLBACK"); } catch (_) {}
      res.status(500).json({ error: e.message, code: "DB_ERROR" });
    }
  });

  // ───── Post voucher (applies effects) ─────

  router.post("/:id/post", requireAuth, requireAdmin, async (req, res) => {
    const voucher = await db.get("SELECT * FROM vouchers WHERE id = ?", [req.params.id]);
    if (!voucher) return res.status(404).json({ error: "السند غير موجود", code: "NOT_FOUND" });
    if (voucher.status === "posted") {
      return res.status(400).json({ error: "السند مرحّل بالفعل", code: "ALREADY_POSTED" });
    }
    const lines = await db.all("SELECT * FROM voucher_lines WHERE voucher_id = ?", [voucher.id]);

    await db.run("BEGIN IMMEDIATE");
    try {
      for (const L of lines) {
        if (L.customer_id) {
          const delta = voucher.voucher_type === "receipt" ? -L.amount_nis : L.amount_nis;
          await db.run("UPDATE customers SET balance = balance + ? WHERE id = ?", [delta, L.customer_id]);
        }
        if (L.supplier_id && voucher.voucher_type === "payment") {
          await db.run(
            "UPDATE suppliers SET balance = balance - ? WHERE id = ?",
            [L.amount_nis, L.supplier_id]
          );
        }
        if (L.bank_account_id) {
          const delta = voucher.voucher_type === "receipt" ? L.amount_nis : -L.amount_nis;
          await db.run("UPDATE bank_accounts SET balance = balance + ? WHERE id = ?", [delta, L.bank_account_id]);
        }
      }
      await db.run(
        "UPDATE vouchers SET status = 'posted', posted_at = datetime('now') WHERE id = ?",
        [voucher.id]
      );
      await db.run("COMMIT");
    } catch (e) {
      try { await db.run("ROLLBACK"); } catch (_) {}
      return res.status(500).json({ error: e.message, code: "DB_ERROR" });
    }
    res.json(await db.get("SELECT * FROM vouchers WHERE id = ?", [voucher.id]));
  });

  router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
    const voucher = await db.get("SELECT * FROM vouchers WHERE id = ?", [req.params.id]);
    if (!voucher) return res.status(404).json({ error: "السند غير موجود", code: "NOT_FOUND" });
    if (voucher.status === "posted") {
      return res.status(400).json({ error: "لا يمكن حذف سند مرحّل", code: "ALREADY_POSTED" });
    }
    await db.run("DELETE FROM vouchers WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  return router;
}
