import { Router } from "express";
import { requireAuth, requirePosAccess } from "../middleware/auth.js";
import { getAppSettings } from "../utils/settings.js";
import { productSkuLookupValues } from "../utils/entityCodes.js";
import { listUnreadRefundDecisions } from "../services/refundRequestService.js";

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
       WHERE p.id IN (${placeholders}) AND COALESCE(p.is_active, 1) = 1
         AND COALESCE(p.inventory_scope, 'retail') = 'retail'`,
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
    const skuValues = productSkuLookupValues(q);
    const skuClause = skuValues.length ? ` OR p.sku IN (${skuValues.map(() => "?").join(", ")})` : "";
    const params = skuValues.length
      ? [like, like, like, like, ...skuValues]
      : [like, like, like, like];
    const rows = await db.all(
      `SELECT DISTINCT p.id, p.barcode, p.name, p.price, p.stock, p.tax_rate,
              pu.id AS unit_id, pu.unit_name, pu.price AS unit_price, pu.conversion_to_base
       FROM products p
       LEFT JOIN product_units pu ON pu.product_id = p.id AND pu.is_default = 1
       LEFT JOIN product_barcodes pb ON pb.product_id = p.id
       LEFT JOIN product_units pu2 ON pu2.product_id = p.id
       WHERE COALESCE(p.is_active, 1) = 1
         AND COALESCE(p.inventory_scope, 'retail') = 'retail'
         AND (p.name LIKE ? OR p.barcode LIKE ? OR pb.barcode LIKE ? OR pu2.barcode LIKE ?${skuClause})
       ORDER BY p.name
       LIMIT 20`,
      params
    );
    res.json(
      rows.map((r) => ({
        ...r,
        price: r.unit_price ?? r.price,
      }))
    );
  });

  router.get("/events", requireAuth, requirePosAccess, async (req, res) => {
    req.headers["x-no-compression"] = "1";
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    let closed = false;
    const send = async () => {
      if (closed) return;
      try {
        const unread = await listUnreadRefundDecisions(db, req.user.id);
        res.write(`event: refunds\ndata: ${JSON.stringify(unread)}\n\n`);
      } catch {
        /* keep the stream alive */
      }
    };
    await send();
    const timer = setInterval(send, 3000);
    req.on("close", () => {
      closed = true;
      clearInterval(timer);
    });
  });

  return router;
}
