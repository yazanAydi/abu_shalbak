import { Router } from "express";
import { requireAuth, requirePosAccess } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { suspendedSaleCreateSchema } from "../middleware/schemas.js";
import { requireOpenShiftForCashier } from "../middleware/getCurrentShift.js";
import {
  createSuspendedSale,
  updateSuspendedSale,
  listSuspendedSalesForShift,
  getSuspendedSaleDetail,
  deleteSuspendedSale,
} from "../services/suspendedSaleService.js";

export function createSuspendedSalesRouter(db) {
  const router = Router();

  router.post("/", requireAuth, requirePosAccess, validate(suspendedSaleCreateSchema), async (req, res, next) => {
    try {
      const result = await createSuspendedSale(db, {
        cashierId: req.user.id,
        note: req.body.note,
        items: req.body.items,
      });
      res.status(201).json(result);
    } catch (e) {
      if (e.status) {
        const body = { error: e.message, code: e.code };
        if (e.product_id != null) body.product_id = e.product_id;
        if (e.name != null) body.name = e.name;
        return res.status(e.status).json(body);
      }
      next(e);
    }
  });

  router.get("/", requireAuth, requirePosAccess, async (req, res, next) => {
    try {
      const { shift, error: shiftErr } = await requireOpenShiftForCashier(db, req.user.id);
      if (shiftErr || !shift) {
        return res.json({ count: 0, sales: [] });
      }
      const sales = await listSuspendedSalesForShift(db, shift.id);
      res.json({ count: sales.length, sales });
    } catch (e) {
      next(e);
    }
  });

  router.put("/:id", requireAuth, requirePosAccess, validate(suspendedSaleCreateSchema), async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    try {
      const result = await updateSuspendedSale(db, id, req.user.id, {
        items: req.body.items,
        note: req.body.note,
      });
      res.json(result);
    } catch (e) {
      if (e.status) {
        const body = { error: e.message, code: e.code };
        if (e.product_id != null) body.product_id = e.product_id;
        if (e.name != null) body.name = e.name;
        return res.status(e.status).json(body);
      }
      next(e);
    }
  });

  router.get("/:id", requireAuth, requirePosAccess, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    try {
      const detail = await getSuspendedSaleDetail(db, id);
      const { shift } = await requireOpenShiftForCashier(db, req.user.id);
      if (!shift || Number(shift.id) !== Number(detail.shift_id)) {
        return res.status(403).json({ error: "لا يمكن عرض فاتورة من وردية أخرى" });
      }
      res.json(detail);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  router.delete("/:id", requireAuth, requirePosAccess, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    try {
      const result = await deleteSuspendedSale(db, id, req.user.id);
      res.json(result);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  return router;
}
