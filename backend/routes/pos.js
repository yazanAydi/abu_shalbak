import { Router } from "express";
import { requireAuth, requirePosAccess } from "../middleware/auth.js";
import { getAppSettings } from "../utils/settings.js";

async function loadQuickButtonProducts(db, settings) {
  const { pos_quick_categories: categories, pos_quick_buttons: buttons } = settings;
  const ids = buttons.map((b) => b.product_id);
  const byId = new Map();
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const rows = await db.all(
      `SELECT p.id, p.barcode, p.name, p.price, p.stock, p.tax_rate,
              pu.id AS unit_id, pu.unit_name, pu.price AS unit_price, pu.conversion_to_base
       FROM products p
       LEFT JOIN product_units pu ON pu.product_id = p.id AND pu.is_default = 1
       WHERE p.id IN (${placeholders}) AND COALESCE(p.is_active, 1) = 1`,
      ids
    );
    for (const r of rows) {
      byId.set(r.id, { ...r, price: r.unit_price ?? r.price });
    }
  }

  const buttonsByCategory = {};
  for (const cat of categories) {
    buttonsByCategory[cat] = [];
  }
  for (const btn of buttons) {
    const product = byId.get(btn.product_id);
    if (product && buttonsByCategory[btn.category]) {
      buttonsByCategory[btn.category].push(product);
    }
  }
  return { categories, buttonsByCategory };
}

export function createPosRouter(db) {
  const router = Router();

  router.get("/quick-buttons", requireAuth, requirePosAccess, async (_req, res) => {
    const settings = await getAppSettings(db);
    const payload = await loadQuickButtonProducts(db, settings);
    res.json(payload);
  });

  router.get("/favorites", requireAuth, requirePosAccess, async (_req, res) => {
    const settings = await getAppSettings(db);
    const { buttonsByCategory } = await loadQuickButtonProducts(db, settings);
    const seen = new Set();
    const ordered = [];
    for (const cat of settings.pos_quick_categories) {
      for (const p of buttonsByCategory[cat] || []) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        ordered.push(p);
      }
    }
    res.json(ordered);
  });

  router.get("/search", requireAuth, requirePosAccess, async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) {
      return res.json([]);
    }
    const like = `%${q}%`;
    const rows = await db.all(
      `SELECT DISTINCT p.id, p.barcode, p.name, p.price, p.stock, p.tax_rate,
              pu.id AS unit_id, pu.unit_name, pu.price AS unit_price, pu.conversion_to_base
       FROM products p
       LEFT JOIN product_units pu ON pu.product_id = p.id AND pu.is_default = 1
       LEFT JOIN product_barcodes pb ON pb.product_id = p.id
       LEFT JOIN product_units pu2 ON pu2.product_id = p.id
       WHERE COALESCE(p.is_active, 1) = 1
         AND (p.name LIKE ? OR p.barcode LIKE ? OR pb.barcode LIKE ? OR pu2.barcode LIKE ?)
       ORDER BY p.name
       LIMIT 20`,
      [like, like, like, like]
    );
    res.json(
      rows.map((r) => ({
        ...r,
        price: r.unit_price ?? r.price,
      }))
    );
  });

  return router;
}
