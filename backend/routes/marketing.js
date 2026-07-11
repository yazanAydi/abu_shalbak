import { Router } from "express";
import { requireAuth, requireAdmin, requirePosAccess } from "../middleware/auth.js";
import { getActivePromotions, computeCartDiscount } from "../utils/promotions.js";
import { round2 } from "../utils/money.js";

const OFFER_TYPES = ["percentage", "fixed", "bundle", "buy_x_get_y", "multi_price"];

async function deactivateConflictingPromos(db, productId, productUnitId, excludeId) {
  if (!productId || !productUnitId) return 0;
  const result = await db.run(
    `UPDATE promotions SET active = 0
     WHERE product_id = ? AND product_unit_id = ? AND id != ? AND active = 1`,
    [productId, productUnitId, excludeId ?? 0]
  );
  return result.changes ?? 0;
}

function normalizePromoBody(b, ex = null) {
  const offer_type = b.offer_type !== undefined ? b.offer_type : ex?.offer_type;
  if (!OFFER_TYPES.includes(offer_type)) {
    return { error: "نوع العرض غير صالح", code: "VALIDATION_ERROR" };
  }

  const product_id =
    b.product_id !== undefined
      ? b.product_id
        ? Number(b.product_id)
        : null
      : ex?.product_id ?? null;
  const stop_when_out_of_stock =
    b.stop_when_out_of_stock !== undefined
      ? b.stop_when_out_of_stock
        ? 1
        : 0
      : ex?.stop_when_out_of_stock ?? 0;

  if (stop_when_out_of_stock && !product_id) {
    return { error: "نفاد المخزون يتطلب تحديد منتج", code: "VALIDATION_ERROR" };
  }

  const product_unit_id =
    b.product_unit_id !== undefined
      ? b.product_unit_id
        ? Number(b.product_unit_id)
        : null
      : ex?.product_unit_id ?? null;

  const limit_qty =
    b.limit_qty !== undefined ? Number(b.limit_qty) || 0 : Number(ex?.limit_qty) || 0;

  if (product_id && !product_unit_id) {
    return { error: "حدّد وحدة المنتج", code: "VALIDATION_ERROR" };
  }

  return {
    campaign_id:
      b.campaign_id !== undefined
        ? b.campaign_id
          ? Number(b.campaign_id)
          : null
        : ex?.campaign_id ?? null,
    name: b.name !== undefined ? String(b.name).trim() : ex?.name,
    offer_type,
    product_id,
    category: b.category !== undefined ? b.category || null : ex?.category ?? null,
    product_unit_id: product_id ? product_unit_id : null,
    discount_value:
      b.discount_value !== undefined
        ? round2(Number(b.discount_value) || 0)
        : round2(Number(ex?.discount_value) || 0),
    buy_qty: b.buy_qty !== undefined ? Number(b.buy_qty) || 0 : Number(ex?.buy_qty) || 0,
    get_qty: b.get_qty !== undefined ? Number(b.get_qty) || 0 : Number(ex?.get_qty) || 0,
    min_amount:
      b.min_amount !== undefined ? Number(b.min_amount) || 0 : Number(ex?.min_amount) || 0,
    limit_qty,
    stop_when_out_of_stock,
    start_date: b.start_date !== undefined ? b.start_date || null : ex?.start_date ?? null,
    end_date: b.end_date !== undefined ? b.end_date || null : ex?.end_date ?? null,
    active: b.active !== undefined ? (b.active ? 1 : 0) : ex?.active ?? 1,
    reset_used_qty:
      b.limit_qty !== undefined &&
      ex &&
      Number(b.limit_qty) !== Number(ex.limit_qty),
  };
}

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
      `SELECT pr.*, c.name AS campaign_name, p.name AS product_name, pu.unit_name
       FROM promotions pr
       LEFT JOIN campaigns c ON c.id = pr.campaign_id
       LEFT JOIN products p ON p.id = pr.product_id
       LEFT JOIN product_units pu ON pu.id = pr.product_unit_id
       ORDER BY pr.active DESC, pr.created_at DESC`
    );
    res.json(rows);
  });

  router.post("/promotions", requireAuth, requireAdmin, async (req, res) => {
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: "اسم العرض مطلوب", code: "VALIDATION_ERROR" });
    if (!b.product_id && !b.category) return res.status(400).json({ error: "حدّد منتجاً أو فئة", code: "VALIDATION_ERROR" });

    const normalized = normalizePromoBody(b);
    if (normalized.error) return res.status(400).json({ error: normalized.error, code: normalized.code });

    let deactivatedCount = 0;
    if (normalized.active && normalized.product_id && normalized.product_unit_id) {
      deactivatedCount = await deactivateConflictingPromos(
        db,
        normalized.product_id,
        normalized.product_unit_id,
        0
      );
    }

    const ins = await db.run(
      `INSERT INTO promotions
         (campaign_id, name, offer_type, product_id, category, product_unit_id, discount_value, buy_qty, get_qty,
          min_amount, limit_qty, used_qty, stop_when_out_of_stock, start_date, end_date, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [
        normalized.campaign_id,
        normalized.name,
        normalized.offer_type,
        normalized.product_id,
        normalized.category,
        normalized.product_unit_id,
        normalized.discount_value,
        normalized.buy_qty,
        normalized.get_qty,
        normalized.min_amount,
        normalized.limit_qty,
        normalized.stop_when_out_of_stock,
        normalized.start_date,
        normalized.end_date,
        normalized.active,
      ]
    );
    res.status(201).json({
      ...(await db.get(
        `SELECT pr.*, p.name AS product_name, pu.unit_name
         FROM promotions pr
         LEFT JOIN products p ON p.id = pr.product_id
         LEFT JOIN product_units pu ON pu.id = pr.product_unit_id
         WHERE pr.id = ?`,
        [ins.lastID]
      )),
      deactivated_sibling_count: deactivatedCount,
    });
  });

  router.put("/promotions/:id", requireAuth, requireAdmin, async (req, res) => {
    const ex = await db.get("SELECT * FROM promotions WHERE id = ?", [req.params.id]);
    if (!ex) return res.status(404).json({ error: "غير موجود", code: "NOT_FOUND" });

    const normalized = normalizePromoBody(req.body || {}, ex);
    if (normalized.error) return res.status(400).json({ error: normalized.error, code: normalized.code });

    const usedQty = normalized.reset_used_qty ? 0 : ex.used_qty;

    let deactivatedCount = 0;
    if (normalized.active && normalized.product_id && normalized.product_unit_id) {
      deactivatedCount = await deactivateConflictingPromos(
        db,
        normalized.product_id,
        normalized.product_unit_id,
        Number(req.params.id)
      );
    }

    await db.run(
      `UPDATE promotions SET campaign_id=?, name=?, offer_type=?, product_id=?, category=?, product_unit_id=?,
         discount_value=?, buy_qty=?, get_qty=?, min_amount=?, limit_qty=?, used_qty=?, stop_when_out_of_stock=?,
         start_date=?, end_date=?, active=? WHERE id=?`,
      [
        normalized.campaign_id,
        normalized.name,
        normalized.offer_type,
        normalized.product_id,
        normalized.category,
        normalized.product_unit_id,
        normalized.discount_value,
        normalized.buy_qty,
        normalized.get_qty,
        normalized.min_amount,
        normalized.limit_qty,
        usedQty,
        normalized.stop_when_out_of_stock,
        normalized.start_date,
        normalized.end_date,
        normalized.active,
        req.params.id,
      ]
    );
    res.json({
      ...(await db.get(
        `SELECT pr.*, p.name AS product_name, pu.unit_name
         FROM promotions pr
         LEFT JOIN products p ON p.id = pr.product_id
         LEFT JOIN product_units pu ON pu.id = pr.product_unit_id
         WHERE pr.id = ?`,
        [req.params.id]
      )),
      deactivated_sibling_count: deactivatedCount,
    });
  });

  router.delete("/promotions/:id", requireAuth, requireAdmin, async (req, res) => {
    await db.run("DELETE FROM promotions WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  // ════════════ POS consumption ════════════

  router.get("/active", requireAuth, requirePosAccess, async (_req, res) => {
    res.json(await getActivePromotions(db));
  });

  router.post("/quote", requireAuth, requirePosAccess, async (req, res) => {
    const { items } = req.body || {};
    if (!Array.isArray(items)) return res.status(400).json({ error: "items مطلوبة", code: "VALIDATION_ERROR" });
    const promos = await getActivePromotions(db);
    const lines = [];
    for (const it of items) {
      const p = await db.get("SELECT id, category, price FROM products WHERE id = ?", [Number(it.product_id)]);
      if (!p) continue;

      const unitId =
        it.product_unit_id != null
          ? Number(it.product_unit_id)
          : it.unit_id != null
            ? Number(it.unit_id)
            : null;
      let unitPrice = Number(p.price) || 0;
      if (unitId) {
        const unit = await db.get(
          "SELECT id, price FROM product_units WHERE id = ? AND product_id = ?",
          [unitId, p.id]
        );
        if (unit) unitPrice = Number(unit.price) || unitPrice;
      }

      lines.push({
        product_id: p.id,
        product_unit_id: unitId,
        category: p.category,
        quantity: Number(it.quantity) || 0,
        unitPrice,
      });
    }
    res.json(computeCartDiscount(promos, lines));
  });

  return router;
}
