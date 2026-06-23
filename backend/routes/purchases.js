import { Router } from "express";
import { requireAuth, requireAdmin, requireRoles } from "../middleware/auth.js";
import { round2 } from "../utils/tax.js";
import { recordMovement } from "../utils/inventory.js";
import { getAppSettings } from "../utils/settings.js";

const requireReports = requireRoles("admin", "accountant");

async function nextNo(db, table, col) {
  // SQLINJECTION_REGRESSION: table/col must be hardcoded allowlist only — never user input
  const ALLOWED = {
    purchase_orders: ["order_no"],
    purchase_invoices: ["invoice_no"],
    purchase_returns: ["return_no"],
  };
  const cols = ALLOWED[table];
  if (!cols || !cols.includes(col)) {
    throw new Error("Invalid table/column for nextNo");
  }
  const row = await db.get(`SELECT MAX(${col}) AS mx FROM ${table}`);
  return (Number(row?.mx) || 0) + 1;
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const out = [];
  for (const it of items) {
    const pid = Number(it.product_id);
    const qty = Number(it.quantity);
    const cost = round2(Number(it.unit_cost) || 0);
    if (!pid || !Number.isFinite(qty) || qty <= 0) return null;
    out.push({ product_id: pid, quantity: qty, unit_cost: cost, vat_rate: Number(it.vat_rate) });
  }
  return out;
}

export function createPurchasesRouter(db) {
  const router = Router();

  // ════════════ Purchase Orders ════════════

  router.get("/orders", requireAuth, requireReports, async (_req, res) => {
    const rows = await db.all(
      `SELECT po.*, s.name AS supplier_name FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       ORDER BY po.created_at DESC LIMIT 300`
    );
    res.json(rows);
  });

  router.get("/orders/:id", requireAuth, requireReports, async (req, res) => {
    const order = await db.get(
      `SELECT po.*, s.name AS supplier_name FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?`,
      [req.params.id]
    );
    if (!order) return res.status(404).json({ error: "أمر الشراء غير موجود", code: "NOT_FOUND" });
    const items = await db.all(
      `SELECT poi.*, p.name, p.barcode FROM purchase_order_items poi
       JOIN products p ON p.id = poi.product_id WHERE poi.order_id = ?`,
      [order.id]
    );
    res.json({ ...order, items });
  });

  router.post("/orders", requireAuth, requireAdmin, async (req, res) => {
    const { supplier_id, order_date, notes, items } = req.body || {};
    const sid = Number(supplier_id);
    if (!sid) return res.status(400).json({ error: "المورد مطلوب", code: "VALIDATION_ERROR" });
    const norm = normalizeItems(items);
    if (!norm) return res.status(400).json({ error: "أصناف غير صالحة", code: "VALIDATION_ERROR" });
    const total = round2(norm.reduce((s, i) => s + i.quantity * i.unit_cost, 0));
    await db.run("BEGIN IMMEDIATE");
    try {
      const no = await nextNo(db, "purchase_orders", "order_no");
      const ins = await db.run(
        `INSERT INTO purchase_orders (order_no, supplier_id, order_date, total_amount, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [no, sid, order_date || new Date().toISOString().slice(0, 10), total, notes || null, req.user.id]
      );
      for (const i of norm) {
        await db.run(
          `INSERT INTO purchase_order_items (order_id, product_id, quantity, unit_cost, line_total)
           VALUES (?, ?, ?, ?, ?)`,
          [ins.lastID, i.product_id, i.quantity, i.unit_cost, round2(i.quantity * i.unit_cost)]
        );
      }
      await db.run("COMMIT");
      const row = await db.get("SELECT * FROM purchase_orders WHERE id = ?", [ins.lastID]);
      res.status(201).json(row);
    } catch (e) {
      try { await db.run("ROLLBACK"); } catch (_) {}
      res.status(500).json({ error: e.message, code: "DB_ERROR" });
    }
  });

  router.delete("/orders/:id", requireAuth, requireAdmin, async (req, res) => {
    const order = await db.get("SELECT * FROM purchase_orders WHERE id = ?", [req.params.id]);
    if (!order) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    if (order.status === "received") return res.status(400).json({ error: "لا يمكن حذف أمر مستلم", code: "LOCKED" });
    await db.run("DELETE FROM purchase_orders WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  // ════════════ Purchase Invoices ════════════

  router.get("/invoices", requireAuth, requireReports, async (req, res) => {
    const { supplier_id, status } = req.query;
    let sql = `SELECT pi.*, s.name AS supplier_name FROM purchase_invoices pi
               JOIN suppliers s ON s.id = pi.supplier_id WHERE 1=1`;
    const params = [];
    if (supplier_id) { sql += " AND pi.supplier_id = ?"; params.push(Number(supplier_id)); }
    if (status) { sql += " AND pi.status = ?"; params.push(status); }
    sql += " ORDER BY pi.created_at DESC LIMIT 300";
    res.json(await db.all(sql, params));
  });

  router.get("/invoices/:id", requireAuth, requireReports, async (req, res) => {
    const inv = await db.get(
      `SELECT pi.*, s.name AS supplier_name FROM purchase_invoices pi
       JOIN suppliers s ON s.id = pi.supplier_id WHERE pi.id = ?`,
      [req.params.id]
    );
    if (!inv) return res.status(404).json({ error: "الفاتورة غير موجودة", code: "NOT_FOUND" });
    const items = await db.all(
      `SELECT pii.*, p.name, p.barcode FROM purchase_invoice_items pii
       JOIN products p ON p.id = pii.product_id WHERE pii.invoice_id = ?`,
      [inv.id]
    );
    res.json({ ...inv, items });
  });

  async function computeInvoiceTotals(db, norm) {
    const settings = await getAppSettings(db);
    const def = Number(settings.default_tax_rate) || 0;
    let subtotal = 0, vat = 0;
    const lines = norm.map((i) => {
      const rate = Number.isFinite(i.vat_rate) ? i.vat_rate : def;
      const net = round2(i.quantity * i.unit_cost);
      const lineVat = round2(net * rate);
      subtotal = round2(subtotal + net);
      vat = round2(vat + lineVat);
      return { ...i, vat_rate: rate, line_net: net, line_vat: lineVat, line_total: round2(net + lineVat) };
    });
    return { subtotal, vat, total: round2(subtotal + vat), lines };
  }

  router.post("/invoices", requireAuth, requireAdmin, async (req, res) => {
    const { supplier_id, order_id, ref_text, invoice_date, notes, items } = req.body || {};
    const sid = Number(supplier_id);
    if (!sid) return res.status(400).json({ error: "المورد مطلوب", code: "VALIDATION_ERROR" });
    const norm = normalizeItems(items);
    if (!norm) return res.status(400).json({ error: "أصناف غير صالحة", code: "VALIDATION_ERROR" });
    const { subtotal, vat, total, lines } = await computeInvoiceTotals(db, norm);
    await db.run("BEGIN IMMEDIATE");
    try {
      const no = await nextNo(db, "purchase_invoices", "invoice_no");
      const ins = await db.run(
        `INSERT INTO purchase_invoices
           (invoice_no, supplier_id, order_id, ref_text, invoice_date, status, subtotal, vat, total, notes, created_by)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
        [no, sid, order_id ? Number(order_id) : null, ref_text || null,
         invoice_date || new Date().toISOString().slice(0, 10), subtotal, vat, total, notes || null, req.user.id]
      );
      for (const i of lines) {
        await db.run(
          `INSERT INTO purchase_invoice_items
             (invoice_id, product_id, quantity, unit_cost, vat_rate, line_net, line_vat, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [ins.lastID, i.product_id, i.quantity, i.unit_cost, i.vat_rate, i.line_net, i.line_vat, i.line_total]
        );
      }
      await db.run("COMMIT");
      const row = await db.get("SELECT * FROM purchase_invoices WHERE id = ?", [ins.lastID]);
      res.status(201).json(row);
    } catch (e) {
      try { await db.run("ROLLBACK"); } catch (_) {}
      res.status(500).json({ error: e.message, code: "DB_ERROR" });
    }
  });

  router.post("/invoices/:id/post", requireAuth, requireAdmin, async (req, res) => {
    const inv = await db.get("SELECT * FROM purchase_invoices WHERE id = ?", [req.params.id]);
    if (!inv) return res.status(404).json({ error: "الفاتورة غير موجودة", code: "NOT_FOUND" });
    if (inv.status === "posted") return res.status(400).json({ error: "الفاتورة مرحّلة بالفعل", code: "ALREADY_POSTED" });
    const items = await db.all("SELECT * FROM purchase_invoice_items WHERE invoice_id = ?", [inv.id]);
    if (items.length === 0) return res.status(400).json({ error: "لا توجد أصناف", code: "EMPTY" });

    await db.run("BEGIN IMMEDIATE");
    try {
      for (const it of items) {
        const product = await db.get("SELECT stock, cost FROM products WHERE id = ?", [it.product_id]);
        if (!product) continue;
        const oldStock = Number(product.stock) || 0;
        const oldCost = Number(product.cost) || 0;
        const addQty = Number(it.quantity) || 0;
        const newStock = oldStock + addQty;
        // weighted-average cost
        const newCost = newStock > 0
          ? round2((oldStock * oldCost + addQty * Number(it.unit_cost)) / newStock)
          : round2(Number(it.unit_cost));
        await db.run("UPDATE products SET cost = ? WHERE id = ?", [newCost, it.product_id]);
        await recordMovement(db, {
          productId: it.product_id,
          movementType: "purchase",
          quantity: addQty,
          unitCost: it.unit_cost,
          refType: "purchase_invoice",
          refId: inv.id,
          notes: `فاتورة شراء #${inv.invoice_no ?? inv.id}`,
          userId: req.user.id,
          applyStock: true,
        });
      }

      // Continuity: write a legacy supplier_invoices AP row so finance /overview keeps working
      const legacy = await db.run(
        `INSERT INTO supplier_invoices (supplier_id, ref_text, amount_total, amount_paid, due_on, status)
         VALUES (?, ?, ?, 0, NULL, 'open')`,
        [inv.supplier_id, inv.ref_text || `PINV-${inv.invoice_no ?? inv.id}`, inv.total]
      );

      await db.run("UPDATE suppliers SET balance = balance + ? WHERE id = ?", [inv.total, inv.supplier_id]);

      await db.run(
        "UPDATE purchase_invoices SET status = 'posted', posted_at = datetime('now'), supplier_invoice_id = ? WHERE id = ?",
        [legacy.lastID, inv.id]
      );
      if (inv.order_id) {
        await db.run("UPDATE purchase_orders SET status = 'received' WHERE id = ?", [inv.order_id]);
      }
      await db.run("COMMIT");
      res.json(await db.get("SELECT * FROM purchase_invoices WHERE id = ?", [inv.id]));
    } catch (e) {
      try { await db.run("ROLLBACK"); } catch (_) {}
      res.status(500).json({ error: e.message, code: "DB_ERROR" });
    }
  });

  router.delete("/invoices/:id", requireAuth, requireAdmin, async (req, res) => {
    const inv = await db.get("SELECT * FROM purchase_invoices WHERE id = ?", [req.params.id]);
    if (!inv) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    if (inv.status === "posted") return res.status(400).json({ error: "لا يمكن حذف فاتورة مرحّلة", code: "ALREADY_POSTED" });
    await db.run("DELETE FROM purchase_invoices WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  // ════════════ Purchase Returns ════════════

  router.get("/returns", requireAuth, requireReports, async (_req, res) => {
    const rows = await db.all(
      `SELECT pr.*, s.name AS supplier_name FROM purchase_returns pr
       JOIN suppliers s ON s.id = pr.supplier_id ORDER BY pr.created_at DESC LIMIT 300`
    );
    res.json(rows);
  });

  router.get("/returns/:id", requireAuth, requireReports, async (req, res) => {
    const ret = await db.get(
      `SELECT pr.*, s.name AS supplier_name FROM purchase_returns pr
       JOIN suppliers s ON s.id = pr.supplier_id WHERE pr.id = ?`,
      [req.params.id]
    );
    if (!ret) return res.status(404).json({ error: "المرتجع غير موجود", code: "NOT_FOUND" });
    const items = await db.all(
      `SELECT pri.*, p.name, p.barcode FROM purchase_return_items pri
       JOIN products p ON p.id = pri.product_id WHERE pri.return_id = ?`,
      [ret.id]
    );
    res.json({ ...ret, items });
  });

  router.post("/returns", requireAuth, requireAdmin, async (req, res) => {
    const { supplier_id, invoice_id, return_date, notes, items } = req.body || {};
    const sid = Number(supplier_id);
    if (!sid) return res.status(400).json({ error: "المورد مطلوب", code: "VALIDATION_ERROR" });
    const norm = normalizeItems(items);
    if (!norm) return res.status(400).json({ error: "أصناف غير صالحة", code: "VALIDATION_ERROR" });
    const total = round2(norm.reduce((s, i) => s + i.quantity * i.unit_cost, 0));
    await db.run("BEGIN IMMEDIATE");
    try {
      const no = await nextNo(db, "purchase_returns", "return_no");
      const ins = await db.run(
        `INSERT INTO purchase_returns (return_no, supplier_id, invoice_id, return_date, status, total, notes, created_by)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
        [no, sid, invoice_id ? Number(invoice_id) : null, return_date || new Date().toISOString().slice(0, 10), total, notes || null, req.user.id]
      );
      for (const i of norm) {
        await db.run(
          `INSERT INTO purchase_return_items (return_id, product_id, quantity, unit_cost, line_total)
           VALUES (?, ?, ?, ?, ?)`,
          [ins.lastID, i.product_id, i.quantity, i.unit_cost, round2(i.quantity * i.unit_cost)]
        );
      }
      await db.run("COMMIT");
      res.status(201).json(await db.get("SELECT * FROM purchase_returns WHERE id = ?", [ins.lastID]));
    } catch (e) {
      try { await db.run("ROLLBACK"); } catch (_) {}
      res.status(500).json({ error: e.message, code: "DB_ERROR" });
    }
  });

  router.post("/returns/:id/post", requireAuth, requireAdmin, async (req, res) => {
    const ret = await db.get("SELECT * FROM purchase_returns WHERE id = ?", [req.params.id]);
    if (!ret) return res.status(404).json({ error: "المرتجع غير موجود", code: "NOT_FOUND" });
    if (ret.status === "posted") return res.status(400).json({ error: "المرتجع مرحّل بالفعل", code: "ALREADY_POSTED" });
    const items = await db.all("SELECT * FROM purchase_return_items WHERE return_id = ?", [ret.id]);
    if (items.length === 0) return res.status(400).json({ error: "لا توجد أصناف", code: "EMPTY" });

    await db.run("BEGIN IMMEDIATE");
    try {
      for (const it of items) {
        await recordMovement(db, {
          productId: it.product_id,
          movementType: "purchase_return",
          quantity: -Number(it.quantity),
          unitCost: it.unit_cost,
          refType: "purchase_return",
          refId: ret.id,
          notes: `مرتجع شراء #${ret.return_no ?? ret.id}`,
          userId: req.user.id,
          applyStock: true,
        });
      }
      await db.run("UPDATE suppliers SET balance = balance - ? WHERE id = ?", [ret.total, ret.supplier_id]);
      await db.run("UPDATE purchase_returns SET status = 'posted', posted_at = datetime('now') WHERE id = ?", [ret.id]);
      await db.run("COMMIT");
      res.json(await db.get("SELECT * FROM purchase_returns WHERE id = ?", [ret.id]));
    } catch (e) {
      try { await db.run("ROLLBACK"); } catch (_) {}
      res.status(500).json({ error: e.message, code: "DB_ERROR" });
    }
  });

  router.delete("/returns/:id", requireAuth, requireAdmin, async (req, res) => {
    const ret = await db.get("SELECT * FROM purchase_returns WHERE id = ?", [req.params.id]);
    if (!ret) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    if (ret.status === "posted") return res.status(400).json({ error: "لا يمكن حذف مرتجع مرحّل", code: "ALREADY_POSTED" });
    await db.run("DELETE FROM purchase_returns WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  return router;
}
