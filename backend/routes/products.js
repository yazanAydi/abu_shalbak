import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { isAdmin } from "../utils/roles.js";
import {
  barcodeLookupKeys,
  digitsOnly,
  findProductByBarcode,
  normalizeBarcodeInput,
} from "../utils/barcode.js";
import {
  addProductBarcode,
  ensureProductBarcodeOnCreate,
  syncProductsPrimaryBarcode,
} from "../utils/productBarcodes.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { ensureEntityCode } from "../utils/entityCodes.js";
import { recordPriceChange } from "../utils/priceHistory.js";
import { getSalesByPrice } from "../utils/salesByPrice.js";

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parsePagination(query, defLimit = 100, maxLimit = 500) {
  const limit = Math.min(maxLimit, Math.max(1, Number(query.limit) || defLimit));
  const offset = Math.max(0, Number(query.offset) || 0);
  return { limit, offset };
}

function parseDateParam(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  return value.trim();
}

function marginPct(price, cost) {
  const p = Number(price) || 0;
  const c = Number(cost) || 0;
  if (p <= 0) return 0;
  return round2(((p - c) / p) * 100);
}

const PRODUCT_LIST_SELECT = `id, barcode, name, name_en, price, cost, stock, category, tax_rate, unit, expiry_date, min_price, max_price, sku,
              COALESCE(is_active, 1) AS is_active`;

const PRODUCT_LIST_SELECT_P = `p.id, p.barcode, p.name, p.name_en, p.price, p.cost, p.stock, p.category, p.tax_rate, p.unit, p.expiry_date, p.min_price, p.max_price, p.sku,
              COALESCE(p.is_active, 1) AS is_active`;

export async function searchProducts(db, rawQuery) {
  const normalized = normalizeBarcodeInput(String(rawQuery ?? "").trim());
  if (!normalized) return null;

  const like = `%${normalized}%`;
  const likeLower = `%${normalized.toLowerCase()}%`;

  console.info(`[products-search] q=${JSON.stringify(normalized)} joinsProductBarcodes=true`);

  /** @type {Map<number, object>} */
  const byId = new Map();

  if (/^\d+$/.test(normalized)) {
    const fromPb = await db.all(
      `SELECT ${PRODUCT_LIST_SELECT_P},
              pb.barcode AS matched_barcode, pb.label AS matched_barcode_label
       FROM product_barcodes pb
       JOIN products p ON p.id = pb.product_id
       WHERE pb.barcode = ?`,
      [normalized]
    );
    for (const row of fromPb) {
      byId.set(row.id, row);
    }

    if (!byId.size) {
      const fromPrimary = await db.all(
        `SELECT ${PRODUCT_LIST_SELECT},
                CAST(barcode AS TEXT) AS matched_barcode, 'أساسي' AS matched_barcode_label
         FROM products
         WHERE CAST(barcode AS TEXT) = ?`,
        [normalized]
      );
      for (const row of fromPrimary) {
        byId.set(row.id, row);
      }
    }
  }

  const likeRows = await db.all(
    `SELECT DISTINCT ${PRODUCT_LIST_SELECT_P}
     FROM products p
     LEFT JOIN product_barcodes pb ON pb.product_id = p.id
     WHERE p.name LIKE ?
        OR CAST(p.barcode AS TEXT) LIKE ?
        OR pb.barcode LIKE ?
     ORDER BY p.name ASC`,
    [likeLower, like, like]
  );

  for (const row of likeRows) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }

  return [...byId.values()].sort((a, b) =>
    String(a.name ?? "").localeCompare(String(b.name ?? ""), "ar")
  );
}

export function createProductsRouter(db) {
  const router = Router();

  async function loadProductById(id) {
    const pid = parsePositiveInt(id);
    if (!pid) return null;
    return db.get("SELECT * FROM products WHERE id = ?", [pid]);
  }

  router.get("/", requireAuth, async (req, res) => {
    const searchTerm = String(req.query.search ?? req.query.q ?? "").trim();
    if (searchTerm) {
      const rows = await searchProducts(db, searchTerm);
      return res.json(rows ?? []);
    }

    if (!isAdmin(req.user?.role)) {
      return res.status(403).json({ success: false, error: "للمسؤول فقط", code: "FORBIDDEN" });
    }

    const rows = await db.all(
      `SELECT ${PRODUCT_LIST_SELECT}
       FROM products ORDER BY id ASC`
    );
    return res.json(rows);
  });

  router.get("/:barcode", requireAuth, async (req, res) => {
    const barcode = normalizeBarcodeInput(decodeURIComponent(req.params.barcode));
    const found = await findProductByBarcode(db, barcode);
    if (!found) {
      return res.status(404).json({ error: "المنتج غير موجود" });
    }
    const row = found.product;
    if (Number(row.is_active) === 0) {
      return res.status(404).json({ error: "المنتج غير متاح", code: "PRODUCT_INACTIVE" });
    }
    res.json({
      id: row.id,
      barcode: row.barcode,
      primary_barcode: row.barcode,
      name: row.name,
      name_en: row.name_en ?? null,
      price: row.price,
      cost: row.cost,
      stock: row.stock,
      category: row.category,
      tax_rate: row.tax_rate ?? null,
      unit: row.unit ?? null,
      expiry_date: row.expiry_date ?? null,
      min_price: row.min_price ?? null,
      max_price: row.max_price ?? null,
      sku: row.sku ?? null,
      image_url: row.image_url ?? null,
      scanned_barcode: found.scannedBarcode,
      product_barcode_id: found.productBarcodeId,
      matched_barcode: found.matchedBarcode,
    });
  });

  router.post("/", requireAuth, requireAdmin, async (req, res) => {
    const { barcode, name, name_en, price, cost, category, stock, tax_rate, unit, expiry_date, min_price, max_price, sku, image_url } = req.body || {};
    if (!barcode || !name || price === undefined || stock === undefined) {
      return res.status(400).json({ error: "الباركود والاسم والسعر والمخزون مطلوبة" });
    }
    if (!Number.isFinite(Number(price)) || Number(price) < 0) {
      return res.status(400).json({ error: "السعر غير صالح" });
    }
    const bcNorm = digitsOnly(normalizeBarcodeInput(barcode));
    const pbDup = await db.get("SELECT product_id FROM product_barcodes WHERE barcode = ?", [bcNorm]);
    if (pbDup) {
      return res.status(409).json({ error: "هذا الباركود مرتبط بمنتج آخر" });
    }
    const c = cost !== undefined ? Number(cost) : 0;
    const taxR = tax_rate !== undefined && tax_rate !== null && tax_rate !== "" ? Number(tax_rate) : null;
    if (taxR !== null && (!Number.isFinite(taxR) || taxR < 0 || taxR > 1)) {
      return res.status(400).json({ error: "نسبة الضريبة يجب أن تكون بين 0 و 1" });
    }
    try {
      const skuCode = await ensureEntityCode(db, "product", sku);
      const info = await db.run(
        `INSERT INTO products (barcode, name, name_en, price, cost, category, stock, tax_rate, unit, expiry_date, min_price, max_price, sku, image_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          String(barcode).trim(),
          String(name).trim(),
          name_en ? String(name_en).trim() : null,
          Number(price),
          c,
          category != null ? String(category) : null,
          Number(stock),
          taxR,
          unit ? String(unit).trim() : null,
          expiry_date ? String(expiry_date).trim() : null,
          min_price != null && min_price !== "" ? Number(min_price) : null,
          max_price != null && max_price !== "" ? Number(max_price) : null,
          skuCode,
          image_url ? String(image_url).trim() : null,
        ]
      );
      await ensureProductBarcodeOnCreate(db, info.lastID, barcode);
      const row = await db.get("SELECT * FROM products WHERE id = ?", [info.lastID]);
      await logAudit(db, req, AUDIT_ACTIONS.PRODUCT_CREATE, "products", row.id, null, { name: row.name, price: row.price, stock: row.stock });
      if (Number(row.price) > 0) {
        await recordPriceChange(db, req, {
          productId: row.id,
          oldPrice: null,
          newPrice: Number(row.price),
          reason: "السعر الأولي عند إنشاء المنتج",
        });
      }
      res.status(201).json(row);
    } catch (e) {
      if (e && e.code === "SQLITE_CONSTRAINT") {
        return res.status(409).json({ error: "الباركود موجود مسبقاً" });
      }
      throw e;
    }
  });

  router.put("/:id", requireAuth, requireAdmin, async (req, res) => {
    const id = req.params.id;
    const existing = await db.get("SELECT * FROM products WHERE id = ?", [id]);
    if (!existing) return res.status(404).json({ error: "المنتج غير موجود" });
    const b = req.body || {};
    let barcode = existing.barcode;
    if (b.barcode !== undefined) {
      barcode = normalizeBarcodeInput(String(b.barcode));
      if (!barcode) {
        return res.status(400).json({ error: "الباركود مطلوب" });
      }
      if (barcode !== existing.barcode) {
        const dup = await db.get(
          "SELECT id FROM products WHERE barcode = ? AND id != ?",
          [barcode, id]
        );
        if (dup) {
          return res.status(409).json({ error: "الباركود موجود مسبقاً" });
        }
        const pbDup = await db.get(
          "SELECT product_id FROM product_barcodes WHERE barcode = ? AND product_id != ?",
          [digitsOnly(barcode), id]
        );
        if (pbDup) {
          return res.status(409).json({ error: "هذا الباركود مرتبط بمنتج آخر" });
        }
      }
    }
    const price = b.price !== undefined ? Number(b.price) : existing.price;
    const stock = b.stock !== undefined ? Number(b.stock) : existing.stock;
    const name = b.name !== undefined ? String(b.name).trim() : existing.name;
    const name_en = b.name_en !== undefined ? (b.name_en ? String(b.name_en).trim() : null) : existing.name_en;
    const category = b.category !== undefined ? (b.category || null) : existing.category;
    const unit = b.unit !== undefined ? (b.unit || null) : existing.unit;
    const expiry_date = b.expiry_date !== undefined ? (b.expiry_date || null) : existing.expiry_date;
    const cost = b.cost !== undefined ? Number(b.cost) : existing.cost;
    let tax_rate = existing.tax_rate;
    if (b.tax_rate !== undefined) {
      tax_rate = b.tax_rate !== null && b.tax_rate !== "" ? Number(b.tax_rate) : null;
    }
    const min_price = b.min_price !== undefined ? (b.min_price != null && b.min_price !== "" ? Number(b.min_price) : null) : existing.min_price;
    const max_price = b.max_price !== undefined ? (b.max_price != null && b.max_price !== "" ? Number(b.max_price) : null) : existing.max_price;
    const sku = b.sku !== undefined ? (b.sku ? String(b.sku).trim() : null) : existing.sku;
    const image_url = b.image_url !== undefined ? (b.image_url ? String(b.image_url).trim() : null) : existing.image_url;
    const priceChanged = round2(existing.price) !== round2(price);
    try {
      await db.run(
        `UPDATE products SET barcode = ?, price = ?, stock = ?, name = ?, name_en = ?, category = ?, unit = ?,
            expiry_date = ?, cost = ?, tax_rate = ?, min_price = ?, max_price = ?, sku = ?, image_url = ?
         WHERE id = ?`,
        [barcode, price, stock, name, name_en, category, unit, expiry_date, cost, tax_rate, min_price, max_price, sku, image_url, id]
      );
    } catch (e) {
      if (e && e.code === "SQLITE_CONSTRAINT") {
        return res.status(409).json({ error: "الباركود موجود مسبقاً" });
      }
      throw e;
    }
    if (b.barcode !== undefined && barcode !== existing.barcode) {
      const pbNorm = digitsOnly(barcode);
      const existingPb = await db.get(
        "SELECT id FROM product_barcodes WHERE product_id = ? AND is_primary = 1",
        [id]
      );
      if (existingPb) {
        await db.run("UPDATE product_barcodes SET barcode = ? WHERE id = ?", [pbNorm, existingPb.id]);
      } else {
        await addProductBarcode(db, Number(id), barcode, { isPrimary: true });
      }
      await syncProductsPrimaryBarcode(db, Number(id));
    }
    const row = await db.get("SELECT * FROM products WHERE id = ?", [id]);
    if (priceChanged) {
      // recordPriceChange writes both the price-history row AND the PRICE_CHANGE audit log
      await recordPriceChange(db, req, {
        productId: Number(id),
        oldPrice: existing.price,
        newPrice: price,
        reason: b.reason != null && String(b.reason).trim() !== "" ? String(b.reason).trim() : "تعديل المنتج",
      });
    } else {
      await logAudit(db, req, AUDIT_ACTIONS.PRODUCT_UPDATE, "products", id, existing, row);
    }
    res.json(row);
  });

  router.patch("/:id/active", requireAuth, requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح", code: "VALIDATION_ERROR" });
    const existing = await db.get("SELECT * FROM products WHERE id = ?", [id]);
    if (!existing) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const nextActive = req.body?.is_active === 0 || req.body?.is_active === false ? 0 : 1;
    await db.run("UPDATE products SET is_active = ? WHERE id = ?", [nextActive, id]);
    const row = await db.get("SELECT * FROM products WHERE id = ?", [id]);
    await logAudit(db, req, AUDIT_ACTIONS.PRODUCT_UPDATE, "products", id, existing, row);
    res.json(row);
  });

  // ════════════════════ Product barcodes (admin-only) ════════════════════

  router.get("/:id/barcodes", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const rows = await db.all(
      `SELECT id, product_id, barcode, label, is_primary, created_at
       FROM product_barcodes WHERE product_id = ?
       ORDER BY is_primary DESC, id ASC`,
      [product.id]
    );
    res.json({ product_id: product.id, barcodes: rows });
  });

  router.post("/:id/barcodes", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const { barcode, label } = req.body || {};
    if (!barcode) return res.status(400).json({ error: "الباركود مطلوب" });
    try {
      const result = await addProductBarcode(db, product.id, barcode, {
        label: label ?? null,
        isPrimary: false,
      });
      if (result.duplicate) {
        return res.status(200).json({ success: true, duplicate: true, id: result.id, barcode: result.barcode });
      }
      const row = await db.get("SELECT * FROM product_barcodes WHERE id = ?", [result.id]);
      res.status(201).json(row);
    } catch (e) {
      if (e.status === 409) {
        return res.status(409).json({
          error: e.message,
          existing_product_id: e.existingProductId,
          existing_product_name: e.existingProductName,
        });
      }
      if (e.status === 400) return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  router.delete("/:id/barcodes/:barcodeId", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const barcodeId = parsePositiveInt(req.params.barcodeId);
    if (!barcodeId) return res.status(400).json({ error: "معرّف غير صالح" });
    const pb = await db.get(
      "SELECT * FROM product_barcodes WHERE id = ? AND product_id = ?",
      [barcodeId, product.id]
    );
    if (!pb) return res.status(404).json({ error: "الباركود غير موجود" });
    const count = await db.get(
      "SELECT COUNT(*) AS n FROM product_barcodes WHERE product_id = ?",
      [product.id]
    );
    if (Number(count.n) <= 1) {
      return res.status(400).json({ error: "لا يمكن حذف آخر باركود للمنتج" });
    }
    await db.run("DELETE FROM product_barcodes WHERE id = ?", [barcodeId]);
    if (Number(pb.is_primary) === 1) {
      const next = await db.get(
        "SELECT id FROM product_barcodes WHERE product_id = ? ORDER BY id ASC LIMIT 1",
        [product.id]
      );
      if (next) {
        await db.run("UPDATE product_barcodes SET is_primary = 1 WHERE id = ?", [next.id]);
        await syncProductsPrimaryBarcode(db, product.id);
      }
    }
    res.status(204).send();
  });

  router.patch("/:id/barcodes/:barcodeId/primary", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const barcodeId = parsePositiveInt(req.params.barcodeId);
    if (!barcodeId) return res.status(400).json({ error: "معرّف غير صالح" });
    const pb = await db.get(
      "SELECT * FROM product_barcodes WHERE id = ? AND product_id = ?",
      [barcodeId, product.id]
    );
    if (!pb) return res.status(404).json({ error: "الباركود غير موجود" });
    await db.run("UPDATE product_barcodes SET is_primary = 0 WHERE product_id = ?", [product.id]);
    await db.run("UPDATE product_barcodes SET is_primary = 1 WHERE id = ?", [barcodeId]);
    await syncProductsPrimaryBarcode(db, product.id);
    const rows = await db.all(
      "SELECT id, product_id, barcode, label, is_primary, created_at FROM product_barcodes WHERE product_id = ? ORDER BY is_primary DESC, id ASC",
      [product.id]
    );
    res.json({ product_id: product.id, barcodes: rows });
  });

  // ════════════════════ Product 360 Dashboard (admin-only) ════════════════════

  router.get("/:id/dashboard", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const pid = product.id;

    const today = new Date().toISOString().slice(0, 10);
    const monthStart = `${today.slice(0, 8)}01`;

    const todayRow = await db.get(
      `SELECT COALESCE(SUM(ti.line_gross),0) AS revenue, COALESCE(SUM(ti.quantity),0) AS qty
       FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
       WHERE ti.product_id = ? AND t.status = 'completed' AND date(t.created_at) = ?`,
      [pid, today]
    );
    const monthRow = await db.get(
      `SELECT COALESCE(SUM(ti.line_gross),0) AS revenue, COALESCE(SUM(ti.quantity),0) AS qty
       FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
       WHERE ti.product_id = ? AND t.status = 'completed' AND date(t.created_at) >= ?`,
      [pid, monthStart]
    );
    const totalsRow = await db.get(
      `SELECT COALESCE(SUM(ti.quantity),0) AS qty
       FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
       WHERE ti.product_id = ? AND t.status = 'completed'`,
      [pid]
    );
    const lastPurchase = await db.get(
      `SELECT pii.unit_cost
       FROM purchase_invoice_items pii
       JOIN purchase_invoices pi ON pi.id = pii.invoice_id AND pi.status = 'posted'
       WHERE pii.product_id = ?
       ORDER BY pi.invoice_date DESC, pi.id DESC LIMIT 1`,
      [pid]
    );
    const supplierRow = await db.get(
      `SELECT COUNT(DISTINCT pi.supplier_id) AS n
       FROM purchase_invoice_items pii
       JOIN purchase_invoices pi ON pi.id = pii.invoice_id AND pi.status = 'posted'
       WHERE pii.product_id = ?`,
      [pid]
    );
    const priceChangeRow = await db.get(
      "SELECT COUNT(*) AS n FROM product_price_history WHERE product_id = ?",
      [pid]
    );

    const stock = Number(product.stock) || 0;
    const price = Number(product.price) || 0;
    const avgCost = Number(product.cost) || 0;

    const barcodeCount = await db.get(
      "SELECT COUNT(*) AS n FROM product_barcodes WHERE product_id = ?",
      [pid]
    );

    res.json({
      product: {
        id: product.id,
        barcode: product.barcode,
        barcode_count: Number(barcodeCount?.n) || 0,
        sku: product.sku ?? product.barcode ?? null,
        name: product.name,
        name_en: product.name_en ?? null,
        image_url: product.image_url ?? null,
        category: product.category ?? null,
        unit: product.unit ?? null,
        is_active: Number(product.is_active ?? 1),
        tax_rate: product.tax_rate ?? null,
        expiry_date: product.expiry_date ?? null,
        min_price: product.min_price ?? null,
        max_price: product.max_price ?? null,
        stock,
        price,
        cost: avgCost,
      },
      summary: {
        current_stock: stock,
        today_sales: round2(todayRow?.revenue),
        today_qty: round2(todayRow?.qty),
        month_sales: round2(monthRow?.revenue),
        month_qty: round2(monthRow?.qty),
        total_qty_sold: round2(totalsRow?.qty),
        current_price: price,
        average_cost: avgCost,
        last_purchase_cost: lastPurchase ? round2(lastPurchase.unit_cost) : null,
        profit_margin_pct: marginPct(price, avgCost),
        estimated_gross_profit: round2(stock * (price - avgCost)),
        inventory_value: round2(stock * avgCost),
        supplier_count: Number(supplierRow?.n) || 0,
        price_changes: Number(priceChangeRow?.n) || 0,
      },
    });
  });

  router.get("/:id/overview", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });

    const warehouses = await db.all(
      `SELECT w.id AS warehouse_id, w.name AS warehouse_name, w.code, w.type, ws.quantity
       FROM warehouse_stock ws JOIN warehouses w ON w.id = ws.warehouse_id
       WHERE ws.product_id = ? AND ws.quantity != 0
       ORDER BY w.name`,
      [product.id]
    );

    let daysUntilExpiry = null;
    if (product.expiry_date) {
      const row = await db.get(
        "SELECT CAST(julianday(?) - julianday('now') AS INTEGER) AS d",
        [product.expiry_date]
      );
      daysUntilExpiry = row?.d ?? null;
    }

    const stock = Number(product.stock) || 0;
    res.json({
      basic: {
        id: product.id,
        barcode: product.barcode,
        sku: product.sku ?? product.barcode ?? null,
        name: product.name,
        name_en: product.name_en ?? null,
        category: product.category ?? null,
        unit: product.unit ?? null,
        tax_rate: product.tax_rate ?? null,
      },
      inventory: {
        current_stock: stock,
        inventory_value: round2(stock * (Number(product.cost) || 0)),
        low_stock: stock <= 10,
        out_of_stock: stock <= 0,
      },
      pricing: {
        current_price: Number(product.price) || 0,
        average_cost: Number(product.cost) || 0,
        min_price: product.min_price ?? null,
        max_price: product.max_price ?? null,
        margin_pct: marginPct(product.price, product.cost),
      },
      expiry: {
        expiry_date: product.expiry_date ?? null,
        days_until_expiry: daysUntilExpiry,
      },
      warehouses,
    });
  });

  router.get("/:id/price-history", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const rows = await db.all(
      `SELECT ph.id, ph.old_price, ph.new_price,
              ROUND(ph.new_price - COALESCE(ph.old_price, ph.new_price), 2) AS difference,
              ph.reason, ph.created_at,
              u.username AS changed_by
       FROM product_price_history ph
       LEFT JOIN users u ON u.id = ph.changed_by_user_id
       WHERE ph.product_id = ?
       ORDER BY ph.created_at DESC, ph.id DESC`,
      [product.id]
    );
    res.json({ product_id: product.id, product_name: product.name, current_price: Number(product.price) || 0, rows });
  });

  router.get("/:id/sales-by-price", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });

    const dateFrom = parseDateParam(req.query.date_from);
    const dateTo = parseDateParam(req.query.date_to);
    if (dateFrom && dateTo && dateFrom > dateTo) {
      return res.status(400).json({ error: "date_from يجب أن يسبق date_to", code: "VALIDATION_ERROR" });
    }
    const includeRefunds = req.query.include_refunds === undefined
      ? true
      : !["false", "0"].includes(String(req.query.include_refunds).toLowerCase());

    const { rows, summary } = await getSalesByPrice(
      db,
      product.id,
      { dateFrom, dateTo },
      includeRefunds
    );
    for (const r of rows) {
      r.product_id = product.id;
      r.product_name = product.name;
    }
    res.json({ product_id: product.id, product_name: product.name, rows, summary });
  });

  router.get("/:id/supplier-prices", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });

    const rows = await db.all(
      `SELECT s.id AS supplier_id, s.name AS supplier_name,
              COUNT(DISTINCT pi.id) AS purchase_count,
              ROUND(SUM(pii.quantity), 3) AS total_quantity,
              ROUND(SUM(pii.unit_cost * pii.quantity) / NULLIF(SUM(pii.quantity), 0), 2) AS avg_cost,
              ROUND(MIN(pii.unit_cost), 2) AS min_cost,
              ROUND(MAX(pii.unit_cost), 2) AS max_cost,
              MAX(pi.invoice_date) AS last_purchase_date,
              (SELECT pii2.unit_cost FROM purchase_invoice_items pii2
                 JOIN purchase_invoices pi2 ON pi2.id = pii2.invoice_id AND pi2.status = 'posted'
                 WHERE pii2.product_id = ? AND pi2.supplier_id = s.id
                 ORDER BY pi2.invoice_date DESC, pi2.id DESC LIMIT 1) AS last_purchase_cost,
              (SELECT pi3.invoice_no FROM purchase_invoice_items pii3
                 JOIN purchase_invoices pi3 ON pi3.id = pii3.invoice_id AND pi3.status = 'posted'
                 WHERE pii3.product_id = ? AND pi3.supplier_id = s.id
                 ORDER BY pi3.invoice_date DESC, pi3.id DESC LIMIT 1) AS invoice_number
       FROM purchase_invoice_items pii
       JOIN purchase_invoices pi ON pi.id = pii.invoice_id AND pi.status = 'posted'
       JOIN suppliers s ON s.id = pi.supplier_id
       WHERE pii.product_id = ?
       GROUP BY s.id, s.name
       ORDER BY avg_cost ASC, s.name`,
      [product.id, product.id, product.id]
    );

    let bestAvg = null;
    for (const r of rows) {
      if (r.avg_cost != null && (bestAvg === null || r.avg_cost < bestAvg)) bestAvg = r.avg_cost;
    }
    for (const r of rows) {
      r.last_purchase_cost = r.last_purchase_cost != null ? round2(r.last_purchase_cost) : null;
      r.is_best = bestAvg !== null && r.avg_cost === bestAvg;
    }

    res.json({ product_id: product.id, product_name: product.name, rows });
  });

  router.get("/:id/supplier-prices/:supplierId/history", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const supplierId = parsePositiveInt(req.params.supplierId);
    if (!supplierId) return res.status(400).json({ error: "معرف المورد غير صالح", code: "VALIDATION_ERROR" });

    const supplier = await db.get("SELECT id, name FROM suppliers WHERE id = ?", [supplierId]);
    const rows = await db.all(
      `SELECT pi.id AS invoice_id, pi.invoice_no AS invoice_number, pi.invoice_date,
              pii.quantity, pii.unit_cost, pii.line_total
       FROM purchase_invoice_items pii
       JOIN purchase_invoices pi ON pi.id = pii.invoice_id AND pi.status = 'posted'
       WHERE pii.product_id = ? AND pi.supplier_id = ?
       ORDER BY pi.invoice_date DESC, pi.id DESC`,
      [product.id, supplierId]
    );
    res.json({ product_id: product.id, supplier_id: supplierId, supplier_name: supplier?.name ?? null, rows });
  });

  router.get("/:id/purchase-history", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const { limit, offset } = parsePagination(req.query, 100, 500);
    const rows = await db.all(
      `SELECT pi.id AS invoice_id, pi.invoice_no AS invoice_number, pi.invoice_date,
              pi.supplier_id, s.name AS supplier_name,
              pii.quantity, pii.unit_cost, pii.line_total
       FROM purchase_invoice_items pii
       JOIN purchase_invoices pi ON pi.id = pii.invoice_id AND pi.status = 'posted'
       JOIN suppliers s ON s.id = pi.supplier_id
       WHERE pii.product_id = ?
       ORDER BY pi.invoice_date DESC, pi.id DESC
       LIMIT ? OFFSET ?`,
      [product.id, limit, offset]
    );
    res.json({ product_id: product.id, product_name: product.name, rows });
  });

  router.get("/:id/inventory-history", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const { limit, offset } = parsePagination(req.query, 100, 500);
    const rows = await db.all(
      `SELECT l.id, l.movement_type, l.quantity_delta, l.qty_before, l.qty_after,
              l.reference_type, l.reference_id, l.notes, l.created_at,
              u.username AS user_name
       FROM inventory_ledger l
       LEFT JOIN users u ON u.id = l.user_id
       WHERE l.product_id = ?
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT ? OFFSET ?`,
      [product.id, limit, offset]
    );
    res.json({ product_id: product.id, product_name: product.name, rows });
  });

  router.get("/:id/profit-analysis", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });

    const series = await db.all(
      `SELECT date(t.created_at) AS day,
              ROUND(SUM(ti.line_gross), 2) AS revenue,
              ROUND(SUM(COALESCE(ti.gross_profit, 0)), 2) AS profit,
              ROUND(SUM(ti.quantity), 3) AS quantity,
              ROUND(SUM(ti.unit_cost_at_sale * ti.quantity), 2) AS cost,
              ROUND(SUM(ti.unit_price * ti.quantity) / NULLIF(SUM(ti.quantity), 0), 2) AS avg_price
       FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
       WHERE ti.product_id = ? AND t.status = 'completed'
       GROUP BY date(t.created_at)
       ORDER BY day ASC`,
      [product.id]
    );

    const withMargin = series.map((d) => ({
      ...d,
      margin_pct: Number(d.revenue) > 0 ? round2((Number(d.profit) / Number(d.revenue)) * 100) : 0,
    }));

    const totals = await db.get(
      `SELECT ROUND(SUM(ti.line_gross), 2) AS revenue,
              ROUND(SUM(COALESCE(ti.gross_profit, 0)), 2) AS profit,
              ROUND(SUM(ti.quantity), 3) AS quantity,
              ROUND(SUM(ti.unit_price * ti.quantity) / NULLIF(SUM(ti.quantity), 0), 2) AS avg_selling_price,
              ROUND(SUM(ti.unit_cost_at_sale * ti.quantity) / NULLIF(SUM(ti.quantity), 0), 2) AS avg_purchase_cost
       FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
       WHERE ti.product_id = ? AND t.status = 'completed'`,
      [product.id]
    );

    const marginValues = withMargin.filter((d) => Number(d.revenue) > 0).map((d) => d.margin_pct);
    const historicalMargin = Number(totals?.revenue) > 0
      ? round2((Number(totals.profit) / Number(totals.revenue)) * 100)
      : 0;

    res.json({
      product_id: product.id,
      product_name: product.name,
      cards: {
        avg_selling_price: totals?.avg_selling_price != null ? round2(totals.avg_selling_price) : 0,
        avg_purchase_cost: totals?.avg_purchase_cost != null ? round2(totals.avg_purchase_cost) : 0,
        current_margin: marginPct(product.price, product.cost),
        historical_margin: historicalMargin,
        highest_margin: marginValues.length ? Math.max(...marginValues) : 0,
        lowest_margin: marginValues.length ? Math.min(...marginValues) : 0,
        total_revenue: round2(totals?.revenue),
        total_profit: round2(totals?.profit),
      },
      series: withMargin,
    });
  });

  router.get("/:id/batches", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const rows = await db.all(
      `SELECT b.id, b.batch_no, b.expiry_date, b.quantity, b.cost, b.notes, b.created_at,
              CAST(julianday(b.expiry_date) - julianday('now') AS INTEGER) AS days_remaining
       FROM product_batches b
       WHERE b.product_id = ?
       ORDER BY b.expiry_date IS NULL, b.expiry_date ASC, b.id DESC`,
      [product.id]
    );
    res.json({ product_id: product.id, product_name: product.name, rows });
  });

  router.get("/:id/audit-log", requireAuth, requireAdmin, async (req, res) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });
    const { limit, offset } = parsePagination(req.query, 100, 500);
    const rows = await db.all(
      `SELECT id, user_id, username, role, action, old_value, new_value, created_at
       FROM audit_logs
       WHERE entity_type = 'products' AND entity_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [product.id, limit, offset]
    );
    res.json({ product_id: product.id, product_name: product.name, rows });
  });

  router.post("/:id/change-price", requireAuth, requireAdmin, async (req, res, next) => {
    const product = await loadProductById(req.params.id);
    if (!product) return res.status(404).json({ error: "المنتج غير موجود", code: "NOT_FOUND" });

    const b = req.body || {};
    const newPrice = Number(b.new_price);
    if (!Number.isFinite(newPrice) || newPrice < 0) {
      return res.status(400).json({ error: "السعر الجديد غير صالح", code: "VALIDATION_ERROR" });
    }
    const reason = b.reason != null && String(b.reason).trim() !== "" ? String(b.reason).trim() : null;
    if (!reason) {
      return res.status(400).json({ error: "سبب تغيير السعر مطلوب", code: "VALIDATION_ERROR" });
    }
    if (product.min_price != null && newPrice < Number(product.min_price)) {
      return res.status(400).json({ error: `السعر أقل من الحد الأدنى (${product.min_price})`, code: "PRICE_BELOW_MIN" });
    }
    if (product.max_price != null && newPrice > Number(product.max_price)) {
      return res.status(400).json({ error: `السعر أعلى من الحد الأقصى (${product.max_price})`, code: "PRICE_ABOVE_MAX" });
    }

    const oldPrice = round2(product.price);
    if (round2(newPrice) === oldPrice) {
      return res.status(400).json({ error: "السعر الجديد مطابق للسعر الحالي", code: "NO_CHANGE" });
    }

    try {
      await db.run("BEGIN IMMEDIATE");
      await db.run("UPDATE products SET price = ? WHERE id = ?", [round2(newPrice), product.id]);
      await recordPriceChange(db, req, {
        productId: product.id,
        oldPrice,
        newPrice: round2(newPrice),
        reason,
      });
      await db.run("COMMIT");
    } catch (e) {
      try { await db.run("ROLLBACK"); } catch (_) {}
      return next(e);
    }

    const updated = await db.get("SELECT * FROM products WHERE id = ?", [product.id]);
    const history = await db.get(
      "SELECT * FROM product_price_history WHERE product_id = ? ORDER BY id DESC LIMIT 1",
      [product.id]
    );
    res.json({ success: true, product: updated, history });
  });

  return router;
}
