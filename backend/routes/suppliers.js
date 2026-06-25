import { Router } from "express";
import { requireAuth, requireAdmin, requireRoles } from "../middleware/auth.js";
import { round2 } from "../utils/tax.js";
import { getAccountStatement } from "../utils/accountStatementService.js";
import { importUploadMiddleware } from "../utils/importUpload.js";
import { handleSupplierBalanceUpload } from "./hesabatiUploadHandlers.js";
import { ensureEntityCode } from "../utils/entityCodes.js";
import { buildSupplierLedger } from "../utils/supplierLedger.js";
import {
  createStatementHistoryPreviewHandler,
  createStatementHistoryConfirmHandler,
} from "./statementHistoryHandlers.js";

const requireReports = requireRoles("admin", "accountant");

/**
 * Supplier master data + ledger.
 * supplier.balance is positive when WE OWE the supplier (a payable).
 */
export function createSuppliersRouter(db) {
  const router = Router();

  router.get("/", requireAuth, async (req, res) => {
    const { q } = req.query;
    let rows;
    if (q) {
      const like = `%${q}%`;
      rows = await db.all(
        `SELECT * FROM suppliers WHERE name LIKE ? OR contact_phone LIKE ? OR supplier_code LIKE ? ORDER BY id ASC LIMIT 200`,
        [like, like, like]
      );
    } else {
      rows = await db.all("SELECT * FROM suppliers ORDER BY id ASC LIMIT 500");
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

  router.post("/upload", requireAuth, requireAdmin, importUploadMiddleware(), async (req, res) => {
    await handleSupplierBalanceUpload(db, req, res);
  });

  router.post(
    "/:id/statement-history/preview",
    requireAuth,
    requireAdmin,
    importUploadMiddleware(),
    createStatementHistoryPreviewHandler(db, "supplier")
  );

  router.post(
    "/:id/statement-history/confirm",
    requireAuth,
    requireAdmin,
    importUploadMiddleware(),
    createStatementHistoryConfirmHandler(db, "supplier")
  );

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
        await ensureEntityCode(db, "supplier", b.supplier_code),
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

  router.get("/:id/ledger", requireAuth, requireReports, async (req, res) => {
    const supplier = await db.get("SELECT * FROM suppliers WHERE id = ?", [req.params.id]);
    if (!supplier) return res.status(404).json({ error: "المورد غير موجود", code: "NOT_FOUND" });
    const { from, to } = req.query;
    const led = await buildSupplierLedger(db, supplier, from, to);
    res.json({ supplier, ...led });
  });

  router.get("/:id/statement", requireAuth, requireReports, async (req, res) => {
    const supplier = await db.get("SELECT * FROM suppliers WHERE id = ?", [req.params.id]);
    if (!supplier) return res.status(404).json({ error: "المورد غير موجود", code: "NOT_FOUND" });
    const { from, to, page, pageSize } = req.query;
    try {
      const report = await getAccountStatement(db, {
        partyType: "supplier",
        partyId: supplier.id,
        from,
        to,
        page,
        pageSize,
        useDefaultRange: false,
      });
      res.json(report);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, code: e.code || "INTERNAL_ERROR" });
    }
  });

  return router;
}
