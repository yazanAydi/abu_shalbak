import { Router } from "express";
import { requireAuth, requireReportsPermission, requireAnyReportsPermission } from "../middleware/auth.js";
import { round2, computePurchaseInvoiceTotals, applyPurchaseDiscount } from "../utils/tax.js";
import { recordMovement } from "../utils/inventory.js";
import { getAppSettings } from "../utils/settings.js";
import { getDefaultUnit, toBaseQuantity, refreshUnitCostCache } from "../utils/productUnits.js";
import { shopTodayYmd } from "../utils/shopTime.js";
import { listLimitSql } from "../utils/listQuery.js";
import { withTransaction } from "../utils/dbTx.js";
import {
  partyBalanceForPurchaseInvoice,
  partyBalanceForPurchaseReturn,
} from "../utils/partyBalanceAroundMove.js";
import {
  purchaseBaseQty,
  purchaseBaseUnitCost,
  purchaseLineGross,
  round6,
  wacAfterInbound,
  wacAfterOutbound,
} from "../utils/purchaseInventoryCost.js";
import { parseOverviewRange } from "../utils/financeOverview.js";
import { postedPurchaseTotalsForDateRange } from "../utils/purchasePeriodTotals.js";
import { normalizeExpiryDate } from "../utils/expiryDate.js";
import {
  applyPurchaseReceiveBatches,
  applyPurchaseReturnBatches,
} from "../services/stockBatchService.js";
import { resolveSupplierPurchaseUnitPrice } from "../utils/supplierPurchasePrice.js";
import { resolveBakeryReportCategories } from "../services/bakeryReportService.js";
import { bakeryMembershipSql, BAKERY_KIND_WORKSPACE } from "../utils/bakeryMembership.js";

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

async function bakeryDocFilter(db, req) {
  const raw = String(req.query?.membership || req.query?.workspace || "").trim().toLowerCase();
  if (raw !== "bakery") return null;
  const resolved = await resolveBakeryReportCategories(db);
  const names = (resolved.categories || []).map((row) => String(row.name || "").trim()).filter(Boolean);
  return bakeryMembershipSql(names, { alias: "p", kind: BAKERY_KIND_WORKSPACE });
}

function decorateBakeryDoc(row) {
  const bakeryTotal = round2(Number(row.bakery_total) || 0);
  const invoiceTotal = round2(Number(row.total) || 0);
  const bakeryLines = Number(row.bakery_line_count) || 0;
  const otherLines = Number(row.other_line_count) || 0;
  row.bakery_total = bakeryTotal;
  row.invoice_total = invoiceTotal;
  row.bakery_line_count = bakeryLines;
  row.other_line_count = otherLines;
  row.mixed = bakeryLines > 0 && otherLines > 0;
  return row;
}

async function annotateDocItemsMembership(db, items) {
  if (!Array.isArray(items) || !items.length) return items;
  const resolved = await resolveBakeryReportCategories(db);
  const names = (resolved.categories || []).map((row) => String(row.name || "").trim()).filter(Boolean);
  const filter = bakeryMembershipSql(names, { alias: "p", kind: BAKERY_KIND_WORKSPACE });
  const ids = [...new Set(items.map((it) => Number(it.product_id)).filter(Boolean))];
  const memberIds = new Set();
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    const rows = await db.all(
      `SELECT p.id FROM products p WHERE p.id IN (${placeholders})${filter.sql}`,
      [...ids, ...filter.params]
    );
    for (const row of rows) memberIds.add(Number(row.id));
  }
  for (const item of items) {
    item.bakery_item = memberIds.has(Number(item.product_id)) ? 1 : 0;
  }
  return items;
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
    const baseQuantity = toBaseQuantity(qty + bonusQty, unit.conversion);
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
      expiry_date: normalizeExpiryDate(it.expiry_date),
    });
  }
  return out;
}

async function applyPurchaseInvoicePost(db, inv, items, userId) {
  for (const it of items) {
    const product = await db.get("SELECT stock, cost FROM products WHERE id = ?", [it.product_id]);
    if (!product) continue;
    const oldStock = Number(product.stock) || 0;
    const oldCost = Number(product.cost) || 0;
    const addQty = purchaseBaseQty(it);
    const lineGross = purchaseLineGross(it);
    const baseUnitCost = addQty > 0 ? round6(lineGross / addQty) : Number(it.unit_cost) || 0;
    const newCost = wacAfterInbound(oldStock, oldCost, addQty, baseUnitCost);
    await db.run("UPDATE products SET cost = ? WHERE id = ?", [newCost, it.product_id]);
    await refreshUnitCostCache(db, it.product_id);
    await applyPurchaseReceiveBatches(db, {
      productId: it.product_id,
      expiryDate: it.expiry_date,
      quantity: addQty,
      cost: baseUnitCost,
      referenceId: inv.id,
      invoiceItemId: it.id,
    });
    await recordMovement(db, {
      productId: it.product_id,
      movementType: "purchase",
      quantity: addQty,
      unitCost: baseUnitCost,
      refType: "purchase_invoice",
      refId: inv.id,
      notes: `فاتورة شراء #${inv.invoice_no ?? inv.id}`,
      userId,
      applyStock: true,
    });
  }

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
  return db.get("SELECT * FROM purchase_invoices WHERE id = ?", [inv.id]);
}

async function postPurchaseInvoice(db, invoiceId, userId) {
  const inv = await db.get("SELECT * FROM purchase_invoices WHERE id = ?", [invoiceId]);
  if (!inv) return { error: "الفاتورة غير موجودة", status: 404, code: "NOT_FOUND" };
  if (inv.status === "posted") return { error: "الفاتورة مرحّلة بالفعل", status: 400, code: "ALREADY_POSTED" };
  const items = await db.all("SELECT * FROM purchase_invoice_items WHERE invoice_id = ?", [inv.id]);
  if (items.length === 0) return { error: "لا توجد أصناف", status: 400, code: "EMPTY" };
  let alreadyPosted = false;
  const row = await withTransaction(db, async () => {
    const fresh = await db.get("SELECT status FROM purchase_invoices WHERE id = ?", [inv.id]);
    if (fresh?.status === "posted") {
      alreadyPosted = true;
      return null;
    }
    return applyPurchaseInvoicePost(db, inv, items, userId);
  });
  if (alreadyPosted) return { error: "الفاتورة مرحّلة بالفعل", status: 400, code: "ALREADY_POSTED" };
  return { row };
}

async function applyPurchaseReturnPost(db, ret, items, userId) {
  for (const it of items) {
    const product = await db.get("SELECT stock, cost FROM products WHERE id = ?", [it.product_id]);
    if (!product) continue;
    const oldStock = Number(product.stock) || 0;
    const oldCost = Number(product.cost) || 0;
    const baseQty = purchaseBaseQty(it);
    const baseUnitCost = purchaseBaseUnitCost(it);
    const newCost = wacAfterOutbound(oldStock, oldCost, baseQty, baseUnitCost);
    await db.run("UPDATE products SET cost = ? WHERE id = ?", [newCost, it.product_id]);
    await refreshUnitCostCache(db, it.product_id);
    await applyPurchaseReturnBatches(db, {
      productId: it.product_id,
      expiryDate: it.expiry_date,
      quantity: baseQty,
      referenceId: ret.id,
      invoiceItemId: it.id,
    });
    await recordMovement(db, {
      productId: it.product_id,
      movementType: "purchase_return",
      quantity: -baseQty,
      unitCost: baseUnitCost,
      refType: "purchase_return",
      refId: ret.id,
      notes: `مرتجع شراء #${ret.return_no ?? ret.id}`,
      userId,
      applyStock: true,
    });
  }
  await db.run("UPDATE suppliers SET balance = balance - ? WHERE id = ?", [ret.total, ret.supplier_id]);
  await db.run("UPDATE purchase_returns SET status = 'posted', posted_at = datetime('now') WHERE id = ?", [ret.id]);
  return db.get("SELECT * FROM purchase_returns WHERE id = ?", [ret.id]);
}

async function postPurchaseReturn(db, returnId, userId) {
  const ret = await db.get("SELECT * FROM purchase_returns WHERE id = ?", [returnId]);
  if (!ret) return { error: "المرتجع غير موجود", status: 404, code: "NOT_FOUND" };
  if (ret.status === "posted") return { error: "المرتجع مرحّل بالفعل", status: 400, code: "ALREADY_POSTED" };
  const items = await db.all("SELECT * FROM purchase_return_items WHERE return_id = ?", [ret.id]);
  if (items.length === 0) return { error: "لا توجد أصناف", status: 400, code: "EMPTY" };
  let alreadyPosted = false;
  const row = await withTransaction(db, async () => {
    const fresh = await db.get("SELECT status FROM purchase_returns WHERE id = ?", [ret.id]);
    if (fresh?.status === "posted") {
      alreadyPosted = true;
      return null;
    }
    return applyPurchaseReturnPost(db, ret, items, userId);
  });
  if (alreadyPosted) return { error: "المرتجع مرحّل بالفعل", status: 400, code: "ALREADY_POSTED" };
  return { row };
}

export function createPurchasesRouter(db) {
  const router = Router();
  const requirePurchases = requireReportsPermission(db, "purchases");
  const requirePurchasesOrBakery = requireAnyReportsPermission(db, "purchases", "bakery_supplies");

  // ════════════ Purchase Orders ════════════

  router.get("/orders", requireAuth, requirePurchases, async (req, res, next) => {
    const page = listLimitSql(req.query);
    const rows = await db.all(
      `SELECT po.*, s.name AS supplier_name FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       ORDER BY po.created_at DESC${page.sql}`
    );
    res.json(rows);
  });

  router.get("/orders/:id", requireAuth, requirePurchases, async (req, res, next) => {
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

  router.post("/orders", requireAuth, requirePurchases, async (req, res, next) => {
    const { supplier_id, order_date, notes, items } = req.body || {};
    const sid = Number(supplier_id);
    if (!sid) return res.status(400).json({ error: "المورد مطلوب", code: "VALIDATION_ERROR" });
    const norm = await normalizeItems(db, items);
    if (!norm) return res.status(400).json({ error: "أصناف غير صالحة", code: "VALIDATION_ERROR" });
    const total = round2(norm.reduce((s, i) => s + i.payable_total, 0));
    try {
      const row = await withTransaction(db, async () => {
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
        return db.get("SELECT * FROM purchase_orders WHERE id = ?", [ins.lastID]);
      });
      res.status(201).json(row);
    } catch (e) {
      next(e);
    }
  });

  router.put("/orders/:id", requireAuth, requirePurchases, async (req, res, next) => {
    const order = await db.get("SELECT * FROM purchase_orders WHERE id = ?", [req.params.id]);
    if (!order) return res.status(404).json({ error: "أمر الشراء غير موجود", code: "NOT_FOUND" });
    if (order.status === "received") return res.status(400).json({ error: "لا يمكن تعديل أمر مستلم", code: "LOCKED" });
    const { supplier_id, order_date, notes, items } = req.body || {};
    const sid = Number(supplier_id);
    if (!sid) return res.status(400).json({ error: "المورد مطلوب", code: "VALIDATION_ERROR" });
    const norm = await normalizeItems(db, items);
    if (!norm) return res.status(400).json({ error: "أصناف غير صالحة", code: "VALIDATION_ERROR" });
    const total = round2(norm.reduce((s, i) => s + i.payable_total, 0));
    try {
      const row = await withTransaction(db, async () => {
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
        return db.get("SELECT * FROM purchase_orders WHERE id = ?", [order.id]);
      });
      res.json(row);
    } catch (e) {
      next(e);
    }
  });

  router.delete("/orders/:id", requireAuth, requirePurchases, async (req, res, next) => {
    const order = await db.get("SELECT * FROM purchase_orders WHERE id = ?", [req.params.id]);
    if (!order) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    if (order.status === "received") return res.status(400).json({ error: "لا يمكن حذف أمر مستلم", code: "LOCKED" });
    await db.run("DELETE FROM purchase_orders WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  // ════════════ Purchase Invoices ════════════

  router.get("/supplier-unit-price", requireAuth, requirePurchases, async (req, res, next) => {
    try {
      const result = await resolveSupplierPurchaseUnitPrice(db, {
        supplierId: req.query.supplier_id,
        productId: req.query.product_id,
        unitId: req.query.unit_id,
        asOf: req.query.as_of,
        invoiceId: req.query.invoice_id,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  router.get("/summary", requireAuth, requirePurchasesOrBakery, async (req, res) => {
    const range = parseOverviewRange(req.query);
    if (range.error) return res.status(range.status).json({ error: range.error });
    const totals = await postedPurchaseTotalsForDateRange(db, range.from, range.to);
    res.json({ from: range.from, to: range.to, ...totals });
  });

  router.get("/invoices", requireAuth, requirePurchasesOrBakery, async (req, res, next) => {
    try {
    const { supplier_id, status } = req.query;
    const bakery = await bakeryDocFilter(db, req);
    let sql = `SELECT pi.*, s.name AS supplier_name`;
    const params = [];
    if (bakery) {
      sql += `,
        (SELECT COALESCE(SUM(COALESCE(pii.line_total, pii.total_cost)), 0)
         FROM purchase_invoice_items pii
         JOIN products p ON p.id = pii.product_id
         WHERE pii.invoice_id = pi.id${bakery.sql}) AS bakery_total,
        (SELECT COUNT(*)
         FROM purchase_invoice_items pii
         JOIN products p ON p.id = pii.product_id
         WHERE pii.invoice_id = pi.id${bakery.sql}) AS bakery_line_count,
        (SELECT COUNT(*)
         FROM purchase_invoice_items pii
         JOIN products p ON p.id = pii.product_id
         WHERE pii.invoice_id = pi.id AND NOT (1=1${bakery.sql})) AS other_line_count`;
    }
    sql += ` FROM purchase_invoices pi
               JOIN suppliers s ON s.id = pi.supplier_id WHERE 1=1`;
    if (bakery) {
      sql += ` AND EXISTS (
        SELECT 1 FROM purchase_invoice_items pii
        JOIN products p ON p.id = pii.product_id
        WHERE pii.invoice_id = pi.id${bakery.sql}
      )`;
      params.push(...bakery.params, ...bakery.params, ...bakery.params, ...bakery.params);
    }
    if (supplier_id) { sql += " AND pi.supplier_id = ?"; params.push(Number(supplier_id)); }
    if (status) { sql += " AND pi.status = ?"; params.push(status); }
    sql += ` ORDER BY pi.created_at DESC${listLimitSql(req.query).sql}`;
    const rows = await db.all(sql, params);
    const includeItems =
      req.query.include_items === "1" || req.query.include_items === "true";
    if (includeItems && rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      const items = await db.all(
        `SELECT pii.*, p.name, p.barcode
         FROM purchase_invoice_items pii
         JOIN products p ON p.id = pii.product_id
         WHERE pii.invoice_id IN (${placeholders})`,
        ids
      );
      const byInvoice = new Map();
      for (const item of items) {
        if (!byInvoice.has(item.invoice_id)) byInvoice.set(item.invoice_id, []);
        byInvoice.get(item.invoice_id).push(item);
      }
      for (const row of rows) {
        row.items = byInvoice.get(row.id) || [];
      }
      if (bakery) await annotateDocItemsMembership(db, items);
    }
    if (bakery) {
      for (const row of rows) decorateBakeryDoc(row);
    }
    res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  router.get("/invoices/:id", requireAuth, requirePurchasesOrBakery, async (req, res, next) => {
    try {
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
    const party_balance = await partyBalanceForPurchaseInvoice(db, inv);
    const bakery = await bakeryDocFilter(db, req);
    if (bakery) {
      await annotateDocItemsMembership(db, items);
      const bakeryLines = items.filter((it) => Number(it.bakery_item) === 1);
      inv.bakery_total = round2(bakeryLines.reduce((sum, it) => sum + purchaseLineGross(it), 0));
      inv.invoice_total = round2(Number(inv.total) || 0);
      inv.bakery_line_count = bakeryLines.length;
      inv.other_line_count = items.length - bakeryLines.length;
      inv.mixed = inv.bakery_line_count > 0 && inv.other_line_count > 0;
    }
    res.json({ ...inv, items, party_balance });
    } catch (e) {
      next(e);
    }
  });

  async function computeInvoiceTotals(db, norm) {
    const settings = await getAppSettings(db);
    const def = Number(settings.default_tax_rate) || 0;
    const { subtotal, vat, total, lines } = computePurchaseInvoiceTotals(norm, def);
    return { subtotal, vat, total, lines };
  }

  router.post("/invoices", requireAuth, requirePurchasesOrBakery, async (req, res, next) => {
    const { supplier_id, order_id, ref_text, invoice_date, notes, items } = req.body || {};
    const sid = Number(supplier_id);
    if (!sid) return res.status(400).json({ error: "المورد مطلوب", code: "VALIDATION_ERROR" });
    const norm = await normalizeItems(db, items);
    if (!norm) return res.status(400).json({ error: "أصناف غير صالحة", code: "VALIDATION_ERROR" });
    const { subtotal, vat, total, lines } = await computeInvoiceTotals(db, norm);
    try {
      const row = await withTransaction(db, async () => {
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
               (invoice_id, product_id, quantity, total_cost, unit_cost, vat_rate, line_net, line_vat, line_total, product_unit_id, unit_name, conversion_used, base_quantity, discount_pct, bonus_quantity, expiry_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [ins.lastID, i.product_id, i.quantity, i.total_cost, i.unit_cost, i.vat_rate, i.line_net, i.line_vat, i.line_total, i.product_unit_id, i.unit_name, i.conversion_used, i.base_quantity, i.discount_pct, i.bonus_quantity, i.expiry_date]
          );
        }
        return db.get("SELECT * FROM purchase_invoices WHERE id = ?", [ins.lastID]);
      });
      res.status(201).json(row);
    } catch (e) {
      next(e);
    }
  });

  router.put("/invoices/:id", requireAuth, requirePurchasesOrBakery, async (req, res, next) => {
    const inv = await db.get("SELECT * FROM purchase_invoices WHERE id = ?", [req.params.id]);
    if (!inv) return res.status(404).json({ error: "الفاتورة غير موجودة", code: "NOT_FOUND" });
    if (inv.status === "posted") return res.status(400).json({ error: "لا يمكن تعديل فاتورة مرحّلة", code: "ALREADY_POSTED" });
    const { supplier_id, ref_text, invoice_date, notes, items } = req.body || {};
    const sid = Number(supplier_id);
    if (!sid) return res.status(400).json({ error: "المورد مطلوب", code: "VALIDATION_ERROR" });
    const norm = await normalizeItems(db, items);
    if (!norm) return res.status(400).json({ error: "أصناف غير صالحة", code: "VALIDATION_ERROR" });
    const { subtotal, vat, total, lines } = await computeInvoiceTotals(db, norm);
    try {
      const row = await withTransaction(db, async () => {
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
               (invoice_id, product_id, quantity, total_cost, unit_cost, vat_rate, line_net, line_vat, line_total, product_unit_id, unit_name, conversion_used, base_quantity, discount_pct, bonus_quantity, expiry_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [inv.id, i.product_id, i.quantity, i.total_cost, i.unit_cost, i.vat_rate, i.line_net, i.line_vat, i.line_total, i.product_unit_id, i.unit_name, i.conversion_used, i.base_quantity, i.discount_pct, i.bonus_quantity, i.expiry_date]
          );
        }
        return db.get("SELECT * FROM purchase_invoices WHERE id = ?", [inv.id]);
      });
      res.json(row);
    } catch (e) {
      next(e);
    }
  });

  router.post("/invoices/post-all", requireAuth, requirePurchasesOrBakery, async (req, res, next) => {
    try {
      const drafts = await db.all("SELECT id FROM purchase_invoices WHERE status = 'draft' ORDER BY id");
      const ids = [];
      const errors = [];
      for (const d of drafts) {
        const result = await postPurchaseInvoice(db, d.id, req.user.id);
        if (result.error) errors.push({ id: d.id, error: result.error });
        else ids.push(d.id);
      }
      res.json({ posted_count: ids.length, ids, errors });
    } catch (e) {
      next(e);
    }
  });

  router.post("/invoices/:id/post", requireAuth, requirePurchasesOrBakery, async (req, res, next) => {
    try {
      const result = await postPurchaseInvoice(db, req.params.id, req.user.id);
      if (result.error) {
        return res.status(result.status).json({ error: result.error, code: result.code || "ERROR" });
      }
      res.json(result.row);
    } catch (e) {
      next(e);
    }
  });

  router.delete("/invoices/:id", requireAuth, requirePurchasesOrBakery, async (req, res, next) => {
    const inv = await db.get("SELECT * FROM purchase_invoices WHERE id = ?", [req.params.id]);
    if (!inv) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    if (inv.status === "posted") return res.status(400).json({ error: "لا يمكن حذف فاتورة مرحّلة", code: "ALREADY_POSTED" });
    await db.run("DELETE FROM purchase_invoices WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  // ════════════ Purchase Returns ════════════

  router.get("/returns", requireAuth, requirePurchases, async (req, res, next) => {
    try {
    const bakery = await bakeryDocFilter(db, req);
    let sql = `SELECT pr.*, s.name AS supplier_name`;
    const params = [];
    if (bakery) {
      sql += `,
        (SELECT COALESCE(SUM(COALESCE(pri.line_total, pri.total_cost)), 0)
         FROM purchase_return_items pri
         JOIN products p ON p.id = pri.product_id
         WHERE pri.return_id = pr.id${bakery.sql}) AS bakery_total,
        (SELECT COUNT(*)
         FROM purchase_return_items pri
         JOIN products p ON p.id = pri.product_id
         WHERE pri.return_id = pr.id${bakery.sql}) AS bakery_line_count,
        (SELECT COUNT(*)
         FROM purchase_return_items pri
         JOIN products p ON p.id = pri.product_id
         WHERE pri.return_id = pr.id AND NOT (1=1${bakery.sql})) AS other_line_count`;
      params.push(...bakery.params, ...bakery.params, ...bakery.params);
    }
    sql += ` FROM purchase_returns pr
       JOIN suppliers s ON s.id = pr.supplier_id WHERE 1=1`;
    if (bakery) {
      sql += ` AND EXISTS (
        SELECT 1 FROM purchase_return_items pri
        JOIN products p ON p.id = pri.product_id
        WHERE pri.return_id = pr.id${bakery.sql}
      )`;
      params.push(...bakery.params);
    }
    sql += ` ORDER BY pr.created_at DESC${listLimitSql(req.query).sql}`;
    const rows = await db.all(sql, params);
    if (bakery) {
      for (const row of rows) decorateBakeryDoc(row);
    }
    res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  router.get("/returns/:id", requireAuth, requirePurchases, async (req, res, next) => {
    try {
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
    const party_balance = await partyBalanceForPurchaseReturn(db, ret);
    const bakery = await bakeryDocFilter(db, req);
    if (bakery) {
      await annotateDocItemsMembership(db, items);
      const bakeryLines = items.filter((it) => Number(it.bakery_item) === 1);
      ret.bakery_total = round2(bakeryLines.reduce((sum, it) => sum + purchaseLineGross(it), 0));
      ret.invoice_total = round2(Number(ret.total) || 0);
      ret.bakery_line_count = bakeryLines.length;
      ret.other_line_count = items.length - bakeryLines.length;
      ret.mixed = ret.bakery_line_count > 0 && ret.other_line_count > 0;
    }
    res.json({ ...ret, items, party_balance });
    } catch (e) {
      next(e);
    }
  });

  router.post("/returns", requireAuth, requirePurchases, async (req, res, next) => {
    const { supplier_id, invoice_id, return_date, notes, items } = req.body || {};
    const sid = Number(supplier_id);
    if (!sid) return res.status(400).json({ error: "المورد مطلوب", code: "VALIDATION_ERROR" });
    const norm = await normalizeItems(db, items);
    if (!norm) return res.status(400).json({ error: "أصناف غير صالحة", code: "VALIDATION_ERROR" });
    const { total, lines } = await computeInvoiceTotals(db, norm);
    try {
      const row = await withTransaction(db, async () => {
        const no = await nextNo(db, "purchase_returns", "return_no");
        const ins = await db.run(
          `INSERT INTO purchase_returns (return_no, supplier_id, invoice_id, return_date, status, total, notes, created_by)
           VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
          [no, sid, invoice_id ? Number(invoice_id) : null, return_date || shopTodayYmd(), total, notes || null, req.user.id]
        );
        for (const i of lines) {
          await db.run(
            `INSERT INTO purchase_return_items
               (return_id, product_id, quantity, total_cost, unit_cost, line_total, product_unit_id, unit_name, conversion_used, base_quantity, discount_pct, bonus_quantity, expiry_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [ins.lastID, i.product_id, i.quantity, i.total_cost, i.unit_cost, i.payable_total, i.product_unit_id, i.unit_name, i.conversion_used, i.base_quantity, i.discount_pct, i.bonus_quantity, i.expiry_date]
          );
        }
        return db.get("SELECT * FROM purchase_returns WHERE id = ?", [ins.lastID]);
      });
      res.status(201).json(row);
    } catch (e) {
      next(e);
    }
  });

  router.put("/returns/:id", requireAuth, requirePurchases, async (req, res, next) => {
    const ret = await db.get("SELECT * FROM purchase_returns WHERE id = ?", [req.params.id]);
    if (!ret) return res.status(404).json({ error: "المرتجع غير موجود", code: "NOT_FOUND" });
    if (ret.status === "posted") return res.status(400).json({ error: "لا يمكن تعديل مرتجع مرحّل", code: "ALREADY_POSTED" });
    const { supplier_id, return_date, notes, items } = req.body || {};
    const sid = Number(supplier_id);
    if (!sid) return res.status(400).json({ error: "المورد مطلوب", code: "VALIDATION_ERROR" });
    const norm = await normalizeItems(db, items);
    if (!norm) return res.status(400).json({ error: "أصناف غير صالحة", code: "VALIDATION_ERROR" });
    const { total, lines } = await computeInvoiceTotals(db, norm);
    try {
      const row = await withTransaction(db, async () => {
        const nextInvoiceId =
          req.body?.invoice_id === undefined
            ? ret.invoice_id
            : req.body.invoice_id
              ? Number(req.body.invoice_id)
              : null;
        await db.run(
          `UPDATE purchase_returns
             SET supplier_id = ?, invoice_id = ?, return_date = ?, notes = ?, total = ?
           WHERE id = ?`,
          [sid, nextInvoiceId, return_date || ret.return_date, notes || null, total, ret.id]
        );
        await db.run("DELETE FROM purchase_return_items WHERE return_id = ?", [ret.id]);
        for (const i of lines) {
          await db.run(
            `INSERT INTO purchase_return_items
               (return_id, product_id, quantity, total_cost, unit_cost, line_total, product_unit_id, unit_name, conversion_used, base_quantity, discount_pct, bonus_quantity, expiry_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [ret.id, i.product_id, i.quantity, i.total_cost, i.unit_cost, i.payable_total, i.product_unit_id, i.unit_name, i.conversion_used, i.base_quantity, i.discount_pct, i.bonus_quantity, i.expiry_date]
          );
        }
        return db.get("SELECT * FROM purchase_returns WHERE id = ?", [ret.id]);
      });
      res.json(row);
    } catch (e) {
      next(e);
    }
  });

  router.post("/returns/post-all", requireAuth, requirePurchases, async (req, res, next) => {
    try {
      const drafts = await db.all("SELECT id FROM purchase_returns WHERE status = 'draft' ORDER BY id");
      const ids = [];
      const errors = [];
      for (const d of drafts) {
        const result = await postPurchaseReturn(db, d.id, req.user.id);
        if (result.error) errors.push({ id: d.id, error: result.error });
        else ids.push(d.id);
      }
      res.json({ posted_count: ids.length, ids, errors });
    } catch (e) {
      next(e);
    }
  });

  router.post("/returns/:id/post", requireAuth, requirePurchases, async (req, res, next) => {
    try {
      const result = await postPurchaseReturn(db, req.params.id, req.user.id);
      if (result.error) {
        return res.status(result.status).json({ error: result.error, code: result.code || "ERROR" });
      }
      res.json(result.row);
    } catch (e) {
      next(e);
    }
  });

  router.delete("/returns/:id", requireAuth, requirePurchases, async (req, res, next) => {
    const ret = await db.get("SELECT * FROM purchase_returns WHERE id = ?", [req.params.id]);
    if (!ret) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    if (ret.status === "posted") return res.status(400).json({ error: "لا يمكن حذف مرتجع مرحّل", code: "ALREADY_POSTED" });
    await db.run("DELETE FROM purchase_returns WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  return router;
}
