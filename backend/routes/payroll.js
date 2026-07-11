import { Router } from "express";
import { requireAuth, requireReportsPermission } from "../middleware/auth.js";
import {
  buildPayrollReport,
  listCashiers,
  updateCashierHourlyRate,
} from "../services/cashierPayrollService.js";

export function createPayrollRouter(db) {
  const router = Router();
  const requirePayroll = requireReportsPermission(db, "employee_payroll");

  router.get("/cashiers", requireAuth, requirePayroll, async (_req, res, next) => {
    try {
      const rows = await listCashiers(db);
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  router.patch("/cashiers/:id", requireAuth, requirePayroll, async (req, res, next) => {
    try {
      const { hourly_rate } = req.body || {};
      if (hourly_rate === undefined || hourly_rate === null || hourly_rate === "") {
        return res.status(400).json({ error: "أجر الساعة مطلوب" });
      }
      const row = await updateCashierHourlyRate(db, req.params.id, hourly_rate);
      res.json(row);
    } catch (e) {
      next(e);
    }
  });

  router.get("/report", requireAuth, requirePayroll, async (req, res, next) => {
    try {
      const report = await buildPayrollReport(db, {
        dateFrom: req.query.date_from,
        dateTo: req.query.date_to,
        cashierId: req.query.cashier_id,
      });
      res.json(report);
    } catch (e) {
      next(e);
    }
  });

  return router;
}
