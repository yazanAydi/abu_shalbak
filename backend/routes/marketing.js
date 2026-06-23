import { Router } from "express";
import { requireAuth, requireAdmin, requirePosAccess } from "../middleware/auth.js";
import { getActivePromotions, computeCartDiscount } from "../utils/promotions.js";

const OFFER_TYPES = ["percentage", "fixed", "bundle", "buy_x_get_y"];

export function createMarketingRouter(db) {
  const router = Router();

  // ════════════ Campaigns ════════════

  router.get("/campaigns", requireAuth, async (_req, res) => {
    const rows = await db.all(
      `SELECT c.*, (SELECT COUNT(*) FROM promotions p WHERE p.campaign_id = c.id) AS promotion_count
       FROM campaigns c ORDER BY c.created_at DESC`
    );
    res.json(rows);
  });

  router.post("/campaigns", requireAuth, requireAdmin, async (req, res) => {
    const { name, description, start_date, end_date, active } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "اسم الحملة مطلوب", code: "VALIDATION_ERROR" });
    const ins = await db.run(
      `INSERT INTO campaigns (name, description, start_date, end_date, active, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [String(name).trim(), description || null, start_date || null, end_date || null, active === false ? 0 : 1, req.user.id]
    );
    res.status(201).json(await db.get("SELECT * FROM campaigns WHERE id = ?", [ins.lastID]));
  });

  router.put("/campaigns/:id", requireAuth, requireAdmin, async (req, res) => {
    const ex = await db.get("SELECT * FROM campaigns WHERE id = ?", [req.params.id]);
    if (!ex) return res.status(404).json({ error: "غير موجودة", code: "NOT_FOUND" });
    const b = req.body || {};
    await db.run(
      `UPDATE campaigns SET name=?, description=?, start_date=?, end_date=?, active=? WHERE id=?`,
      [
        b.name !== undefined ? String(b.name).trim() : ex.name,
        b.description !== undefined ? (b.description || null) : ex.description,
        b.start_date !== undefined ? (b.start_date || null) : ex.start_date,
        b.end_date !== undefined ? (b.end_date || null) : ex.end_date,
        b.active !== undefined ? (b.active ? 1 : 0) : ex.active,
        req.params.id,
      ]
    );
    res.json(await db.get("SELECT * FROM campaigns WHERE id = ?", [req.params.id]));
  });

  router.delete("/campaigns/:id", requireAuth, requireAdmin, async (req, res) => {
    await db.run("DELETE FROM campaigns WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  // ════════════ Promotions ════════════

  router.get("/promotions", requireAuth, async (_req, res) => {
    const rows = await db.all(
      `SELECT pr.*, c.name AS campaign_name, p.name AS product_name
       FROM promotions pr
       LEFT JOIN campaigns c ON c.id = pr.campaign_id
       LEFT JOIN products p ON p.id = pr.product_id
       ORDER BY pr.active DESC, pr.created_at DESC`
    );
    res.json(rows);
  });

  router.post("/promotions", requireAuth, requireAdmin, async (req, res) => {
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: "اسم العرض مطلوب", code: "VALIDATION_ERROR" });
    if (!OFFER_TYPES.includes(b.offer_type)) return res.status(400).json({ error: "نوع العرض غير صالح", code: "VALIDATION_ERROR" });
    if (!b.product_id && !b.category) return res.status(400).json({ error: "حدّد منتجاً أو فئة", code: "VALIDATION_ERROR" });
    const ins = await db.run(
      `INSERT INTO promotions
         (campaign_id, name, offer_type, product_id, category, discount_value, buy_qty, get_qty, min_amount, start_date, end_date, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        b.campaign_id ? Number(b.campaign_id) : null,
        String(b.name).trim(), b.offer_type,
        b.product_id ? Number(b.product_id) : null,
        b.category || null,
        Number(b.discount_value) || 0,
        Number(b.buy_qty) || 0,
        Number(b.get_qty) || 0,
        Number(b.min_amount) || 0,
        b.start_date || null, b.end_date || null,
        b.active === false ? 0 : 1,
      ]
    );
    res.status(201).json(await db.get("SELECT * FROM promotions WHERE id = ?", [ins.lastID]));
  });

  router.put("/promotions/:id", requireAuth, requireAdmin, async (req, res) => {
    const ex = await db.get("SELECT * FROM promotions WHERE id = ?", [req.params.id]);
    if (!ex) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });
    const b = req.body || {};
    const offer_type = b.offer_type !== undefined ? b.offer_type : ex.offer_type;
    if (!OFFER_TYPES.includes(offer_type)) return res.status(400).json({ error: "نوع العرض غير صالح", code: "VALIDATION_ERROR" });
    await db.run(
      `UPDATE promotions SET campaign_id=?, name=?, offer_type=?, product_id=?, category=?,
         discount_value=?, buy_qty=?, get_qty=?, min_amount=?, start_date=?, end_date=?, active=? WHERE id=?`,
      [
        b.campaign_id !== undefined ? (b.campaign_id ? Number(b.campaign_id) : null) : ex.campaign_id,
        b.name !== undefined ? String(b.name).trim() : ex.name,
        offer_type,
        b.product_id !== undefined ? (b.product_id ? Number(b.product_id) : null) : ex.product_id,
        b.category !== undefined ? (b.category || null) : ex.category,
        b.discount_value !== undefined ? Number(b.discount_value) || 0 : ex.discount_value,
        b.buy_qty !== undefined ? Number(b.buy_qty) || 0 : ex.buy_qty,
        b.get_qty !== undefined ? Number(b.get_qty) || 0 : ex.get_qty,
        b.min_amount !== undefined ? Number(b.min_amount) || 0 : ex.min_amount,
        b.start_date !== undefined ? (b.start_date || null) : ex.start_date,
        b.end_date !== undefined ? (b.end_date || null) : ex.end_date,
        b.active !== undefined ? (b.active ? 1 : 0) : ex.active,
        req.params.id,
      ]
    );
    res.json(await db.get("SELECT * FROM promotions WHERE id = ?", [req.params.id]));
  });

  router.delete("/promotions/:id", requireAuth, requireAdmin, async (req, res) => {
    await db.run("DELETE FROM promotions WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  // ════════════ POS consumption ════════════

  // Active promotions the POS can fetch to show offers / compute discounts locally.
  router.get("/active", requireAuth, requirePosAccess, async (_req, res) => {
    res.json(await getActivePromotions(db));
  });

  // Authoritative discount quote for a cart (POS sends lines, gets discount back).
  router.post("/quote", requireAuth, requirePosAccess, async (req, res) => {
    const { items } = req.body || {};
    if (!Array.isArray(items)) return res.status(400).json({ error: "items مطلوبة", code: "VALIDATION_ERROR" });
    const promos = await getActivePromotions(db);
    const lines = [];
    for (const it of items) {
      const p = await db.get("SELECT id, category, price FROM products WHERE id = ?", [Number(it.product_id)]);
      if (!p) continue;
      lines.push({ product_id: p.id, category: p.category, quantity: Number(it.quantity) || 0, unitPrice: Number(p.price) || 0 });
    }
    res.json(computeCartDiscount(promos, lines));
  });

  return router;
}
