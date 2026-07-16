import { Router } from "express";
import { requireAuth, requireAdmin, requireRoles } from "../middleware/auth.js";
import { round2, computePurchaseInvoiceTotals, applyPurchaseDiscount } from "../utils/tax.js";
import { recordMovement } from "../utils/inventory.js";
import { getAppSettings } from "../utils/settings.js";
import { getDefaultUnit } from "../utils/productUnits.js";
import { shopTodayYmd } from "../utils/shopTime.js";

const requireReports = requireRoles("admin", "accountant");

// Unit cost is derived (total ÷ qty) and can be a long fraction (e.g. 42/52).
// Keep extra precision so cost of goods sold / weighted-average cost stay accurate.
function round6(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

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

// Resolve the purchase unit for a line: explicit unit_id if valid, else the
// product's default unit. Returns { id, unit_name, conversion } or a conversion
// of 1 fallback (legacy clients that send no unit behave as base units).
async function resolvePurchaseUnit(db, productId, unitId) {
  if (unitId) {
    const unit = await db.get(
      "SELECT id, unit_name, conversion_to_base FROM product_units WHERE id = ? AND product_id = ?",
      [unitId, productId]
    );
    if (unit) {
      return {
        id: unit.id,
        unit_name: unit.unit_name,
        conversion: Math.max(0.0001, Number(unit.conversion_to_base) || 1),
      };
    }
  }
  // No explicit unit: prefer the configured purchase-default unit, then fall
  // back to the product's general default unit.
  const purchaseDefault = await db.get(
    "SELECT id, unit_name, conversion_to_base FROM product_units WHERE product_id = ? AND is_default_purchase = 1 LIMIT 1",
    [productId]
  );
  if (purchaseDefault) {
    return {
      id: purchaseDefault.id,
      unit_name: purchaseDefault.unit_name,
      conversion: Math.max(0.0001, Number(purchaseDefault.conversion_to_base) || 1),
    };
  }
  const def = await getDefaultUnit(db, productId);
  if (def) {
    return {
      id: def.id,
      unit_name: def.unit_name,
      conversion: Math.max(0.0001, Number(def.conversion_to_base) || 1),
    };
  }
  return { id: null, unit_name: null, conversion: 1 };
}

async function normalizeItems(db, items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const out = [];
  for (const it of items) {
    const pid = Number(it.product_id);
    const qty = Number(it.quantity);
    // total_cost is the supplier cost for the whole line quantity (not per unit).
    // Accept unit_cost (per entered unit) as a fallback for clients that send it.
    const hasTotal = it.total_cost != null && it.total_cost !== "";
    const totalCost = hasTotal
      ? round2(Number(it.total_cost) || 0)
      : round2((Number(it.unit_cost) || 0) * (Number(qty) || 0));
    if (!pid || !Number.isFinite(qty) || qty <= 0) return null;
    const rawUnitId = it.unit_id != null ? Number(it.unit_id) : it.product_unit_id != null ? Number(it.product_unit_id) : null;
    const unit = await resolvePurchaseUnit(db, pid, rawUnitId);
    const discountPct = Math.min(100, Math.max(0, Number(it.discount_pct) || 0));
    const bonusQty = Math.max(0, Number(it.bonus_quantity) || 0);
    const baseQuantity = round6((qty + bonusQty) * unit.conversion);
    // unit_cost = cost per entered unit (display); base_unit_cost = cost per base
    // unit (used for weighted-average cost + inventory ledger at posting).
    const unitCost = round6(totalCost / qty);
    const baseUnitCost = baseQuantity > 0 ? round6(totalCost / baseQuantity) : 0;
    const payableTotal = applyPurchaseDiscount(totalCost, discountPct);
    out.push({
      product_id: pid,
      quantity: qty,
      total_cost: totalCost,
      unit_cost: unitCost,
      base_unit_cost: baseUnitCost,
      product_unit_id: unit.id,
      unit_name: unit.unit_name,
      conversion_used: unit.conversion,
      base_quantity: baseQuantity,
      discount_pct: discountPct,
      bonus_quantity: bonusQty,
      payable_total: payableTotal,
      vat_rate: Number(it.vat_rate),
    });
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
    const norm = await normalizeItems(db, items);
    if (!norm) return res.status(400).json({ error: "أصناف غير صالحة", code: "VALIDATION_ERROR" });
    const total = round2(norm.reduce((s, i) => s + i.payable_total, 0));
    await db.run("BEGIN IMMEDIATE");
    try {
      const no = await nextNo(db, "purchase_orders", "order_no");
      const ins = await db.run(
        `INSERT INTO purchase_orders (order_no, supplier_id, order_date, total_amount, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [no, sid, order_date || shopTodayYmd(), total, notes || null, req.user.id]
      );
      for (const i of norm) {
        await db.run(
          `INSERT INTO purchase_order_items
             (order_id, product_id, quantity, total_cost, unit_cost, line_total, product_unit_id, unit_name, conversion_used, base_quantity, discount_pct, bonus_quantity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [ins.lastID, i.product_id, i.quantity, i.total_cost, i.unit_cost, i.payable_total, i.product_unit_id, i.unit_name, i.conversion_used, i.base_quantity, i.discount_pct, i.bonus_quantity]
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

  router.put("/orders/:id", requireAuth, requireAdmin, async (req, res) => {
    const order = await db.get("SELECT * FROM purchase_orders WHERE id = ?", [req.params.id]);
    if (!order) return res.status(404).json({ error: "أمر الشراء غير موجود", code: "NOT_FOUND" });
    if (order.status === "received") return res.status(400).json({ error: "لا يمكن تعديل أمر مستلم", code: "LOCKED" });
    const { supplier_id, order_date, notes, items } = req.body || {};
    const sid = Number(supplier_id);
    if (!sid) return res.status(400).json({ error: "المورد مطلوب", code: "VALIDATION_ERROR" });
    const norm = await normalizeItems(db, items);
    if (!norm) return res.status(400).json({ error: "أصناف غير صالحة", code: "VALIDATION_ERROR" });
    const total = round2(norm.reduce((s, i) => s + i.payable_total, 0));
    await db.run("BEGIN IMMEDIATE");
    try {
      await db.run(
        `UPDATE purchase_orders SET supplier_id = ?, order_date = ?, total_amount = ?, notes = ? WHERE id = ?`,
        [sid, order_date || order.order_date, total, notes || null, order.id]
      );
      await db.run("DELETE FROM purchase_order_items WHERE order_id = ?", [order.id]);
      for (const i of norm) {
        await db.run(
          `INSERT INTO purchase_order_items
             (order_id, product_id, quantity, total_cost, unit_cost, line_total, product_unit_id, unit_name, conversion_used, base_quantity, discount_pct, bonus_quantity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [order.id, i.product_id, i.quantity, i.total_cost, i.unit_cost, i.payable_total, i.product_unit_id, i.unit_name, i.conversion_used, i.base_quantity, i.discount_pct, i.bonus_quantity]
        );
      }
      await db.run("COMMIT");
      res.json(await db.get("SELECT * FROM purchase_orders WHERE id = ?", [order.id]));
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
    const { subtotal, vat, total, lines } = computePurchaseInvoiceTotals(norm, def);
    return { subtotal, vat, total, lines };
  }

  router.post("/invoices", requireAuth, requireAdmin, async (req, res) => {
    const { supplier_id, order_id, ref_text, invoice_date, notes, items } = req.body || {};
    const sid = Number(supplier_id);
    if (!sid) return res.status(400).json({ error: "المورد مطلوب", code: "VALIDATION_ERROR" });
    const norm = await normalizeItems(db, items);
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
         invoice_date || shopTodayYmd(), subtotal, vat, total, notes || null, req.user.id]
      );
      for (const i of lines) {
        await db.run(
          `INSERT INTO purchase_invoice_items
             (invoice_id, product_id, quantity, total_cost, unit_cost, vat_rate, line_net, line_vat, line_total, product_unit_id, unit_name, conversion_used, base_quantity, discount_pct, bonus_quantity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [ins.lastID, i.product_id, i.quantity, i.total_cost, i.unit_cost, i.vat_rate, i.line_net, i.line_vat, i.line_total, i.product_unit_id, i.unit_name, i.conversion_used, i.base_quantity, i.discount_pct, i.bonus_quantity]
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

  router.put("/invoices/:id", requireAuth, requireAdmin, async (req, res) => {
    const inv = await db.get("SELECT * FROM purchase_invoices WHERE id = ?", [req.params.id]);
    if (!inv) return res.status(404).json({ error: "الفاتورة غير موجودة", code: "NOT_FOUND" });
    if (inv.status === "posted") return res.status(400).json({ error: "لا يمكن تعديل فاتورة مرحّلة", code: "ALREADY_POSTED" });
    const { supplier_id, ref_text, invoice_date, notes, items } = req.body || {};
    const sid = Number(supplier_id);
    if (!sid) return res.status(400).json({ error: "المورد مطلوب", code: "VALIDATION_ERROR" });
    const norm = await normalizeItems(db, items);
    if (!norm) return res.status(400).json({ error: "أصناف غير صالحة", code: "VALIDATION_ERROR" });
    const { subtotal, vat, total, lines } = await computeInvoiceTotals(db, norm);
    await db.run("BEGIN IMMEDIATE");
    try {
      await db.run(
        `UPDATE purchase_invoices
           SET supplier_id = ?, ref_text = ?, invoice_date = ?, notes = ?, subtotal = ?, vat = ?, total = ?
         WHERE id = ?`,
        [sid, ref_text || null, invoice_date || inv.invoice_date, notes || null, subtotal, vat, total, inv.id]
      );
      await db.run("DELETE FROM purchase_invoice_items WHERE invoice_id = ?", [inv.id]);
      for (const i of lines) {
        await db.run(
          `INSERT INTO purchase_invoice_items
             (invoice_id, product_id, quantity, total_cost, unit_cost, vat_rate, line_net, line_vat, line_total, product_unit_id, unit_name, conversion_used, base_quantity, discount_pct, bonus_quantity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [inv.id, i.product_id, i.quantity, i.total_cost, i.unit_cost, i.vat_rate, i.line_net, i.line_vat, i.line_total, i.product_unit_id, i.unit_name, i.conversion_used, i.base_quantity, i.discount_pct, i.bonus_quantity]
        );
      }
      await db.run("COMMIT");
      res.json(await db.get("SELECT * FROM purchase_invoices WHERE id = ?", [inv.id]));
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
        // Stock moves in base units (paid + bonus); weighted-average cost uses net spread over all units.
        const addQty = it.base_quantity != null ? Number(it.base_quantity) : Number(it.quantity) || 0;
        const lineNet = it.line_net != null ? Number(it.line_net) : Number(it.total_cost) || 0;
        const baseUnitCost = addQty > 0 ? round6(lineNet / addQty) : Number(it.unit_cost) || 0;
        const newStock = oldStock + addQty;
        // weighted-average cost
        const newCost = newStock > 0
          ? round2((oldStock * oldCost + addQty * baseUnitCost) / newStock)
          : round2(baseUnitCost);
        await db.run("UPDATE products SET cost = ? WHERE id = ?", [newCost, it.product_id]);
        await recordMovement(db, {
          productId: it.product_id,
          movementType: "purchase",
          quantity: addQty,
          unitCost: baseUnitCost,
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
    const norm = await normalizeItems(db, items);
    if (!norm) return res.status(400).json({ error: "أصناف غير صالحة", code: "VALIDATION_ERROR" });
    const total = round2(norm.reduce((s, i) => s + i.payable_total, 0));
    await db.run("BEGIN IMMEDIATE");
    try {
      const no = await nextNo(db, "purchase_returns", "return_no");
      const ins = await db.run(
        `INSERT INTO purchase_returns (return_no, supplier_id, invoice_id, return_date, status, total, notes, created_by)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
        [no, sid, invoice_id ? Number(invoice_id) : null, return_date || shopTodayYmd(), total, notes || null, req.user.id]
      );
      for (const i of norm) {
        await db.run(
          `INSERT INTO purchase_return_items
             (return_id, product_id, quantity, total_cost, unit_cost, line_total, product_unit_id, unit_name, conversion_used, base_quantity, discount_pct, bonus_quantity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [ins.lastID, i.product_id, i.quantity, i.total_cost, i.unit_cost, i.payable_total, i.product_unit_id, i.unit_name, i.conversion_used, i.base_quantity, i.discount_pct, i.bonus_quantity]
        );
      }
      await db.run("COMMIT");
      res.status(201).json(await db.get("SELECT * FROM purchase_returns WHERE id = ?", [ins.lastID]));
    } catch (e) {
      try { await db.run("ROLLBACK"); } catch (_) {}
      res.status(500).json({ error: e.message, code: "DB_ERROR" });
    }
  });

  router.put("/returns/:id", requireAuth, requireAdmin, async (req, res) => {
    const ret = await db.get("SELECT * FROM purchase_returns WHERE id = ?", [req.params.id]);
    if (!ret) return res.status(404).json({ error: "المرتجع غير موجود", code: "NOT_FOUND" });
    if (ret.status === "posted") return res.status(400).json({ error: "لا يمكن تعديل مرتجع مرحّل", code: "ALREADY_POSTED" });
    const { supplier_id, return_date, notes, items } = req.body || {};
    const sid = Number(supplier_id);
    if (!sid) return res.status(400).json({ error: "المورد مطلوب", code: "VALIDATION_ERROR" });
    const norm = await normalizeItems(db, items);
    if (!norm) return res.status(400).json({ error: "أصناف غير صالحة", code: "VALIDATION_ERROR" });
    const total = round2(norm.reduce((s, i) => s + i.payable_total, 0));
    await db.run("BEGIN IMMEDIATE");
    try {
      await db.run(
        `UPDATE purchase_returns
           SET supplier_id = ?, return_date = ?, notes = ?, total = ?
         WHERE id = ?`,
        [sid, return_date || ret.return_date, notes || null, total, ret.id]
      );
      await db.run("DELETE FROM purchase_return_items WHERE return_id = ?", [ret.id]);
      for (const i of norm) {
        await db.run(
          `INSERT INTO purchase_return_items
             (return_id, product_id, quantity, total_cost, unit_cost, line_total, product_unit_id, unit_name, conversion_used, base_quantity, discount_pct, bonus_quantity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [ret.id, i.product_id, i.quantity, i.total_cost, i.unit_cost, i.payable_total, i.product_unit_id, i.unit_name, i.conversion_used, i.base_quantity, i.discount_pct, i.bonus_quantity]
        );
      }
      await db.run("COMMIT");
      res.json(await db.get("SELECT * FROM purchase_returns WHERE id = ?", [ret.id]));
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
        const baseQty = it.base_quantity != null ? Number(it.base_quantity) : Number(it.quantity) || 0;
        const baseUnitCost = baseQty > 0 ? round6(Number(it.total_cost) / baseQty) : Number(it.unit_cost) || 0;
        await recordMovement(db, {
          productId: it.product_id,
          movementType: "purchase_return",
          quantity: -baseQty,
          unitCost: baseUnitCost,
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
