import { requireAuth, requireReportsPermission } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createSafeRouter } from "../utils/asyncHandler.js";
import {
  employeeCreateSchema,
  employeeCompensationSchema,
  employeeWageBasisSchema,
  employeeOpeningBalanceSchema,
  employeePatchSchema,
  employeeStatementQuerySchema,
  employeeHoursPreviewQuerySchema,
  employeeEntitlementCreateSchema,
  employeeEntitlementReverseSchema,
  employeeEntitlementReplaceSchema,
  employeePaymentCreateSchema,
  employeePaymentCorrectSchema,
  employeeFromCashierUserSchema,
  employeeLinkCashierUserSchema,
  employeeLinkCustomerSchema,
  employeePayrollPreviewQuerySchema,
  employeePayrollPayoutSchema,
  employeeDebtPaymentSchema,
} from "../middleware/schemas.js";
import {
  addCompensation,
  setEmployeeWageBasis,
  addOpeningBalance,
  createEmployee,
  createEmployeeDebtAccount,
  createEmployeeFromCashierUser,
  getEmployee,
  linkEmployeeToCashierUser,
  linkEmployeeToCustomer,
  listCashierAccounts,
  listDebtCustomers,
  listEmployees,
  listLinkableUsers,
  listStaffAccounts,
  updateEmployee,
} from "../services/employeeService.js";
import { getEmployeeStatement } from "../services/employeeStatementService.js";
import { getEmployeeHistoryStatement } from "../services/employeeHistoryStatementService.js";
import { confirmPayrollPayout, getPayrollPreview } from "../services/employeePayrollService.js";
import { getEmployeeInvoiceReceipt, postEmployeeDebtRepayment } from "../services/employeeDebtService.js";
import {
  postSalaryEntitlement,
  previewCashierHours,
  reverseAndReplaceSalaryEntitlement,
  reverseSalaryEntitlement,
} from "../services/employeeEntitlementService.js";
import {
  correctOfficeEmployeePayment,
  postOfficeEmployeePayment,
} from "../services/employeePaymentService.js";

export function createEmployeesRouter(db) {
  const router = createSafeRouter();
  const requirePayroll = requireReportsPermission(db, "employee_payroll");

  router.get("/", requireAuth, requirePayroll, async (req, res) => {
    const rows = await listEmployees(db, { active: String(req.query.active || "all") });
    res.json(rows);
  });

  router.get("/linkable-users", requireAuth, requirePayroll, async (req, res) => {
    const includeUserId = req.query.include_user_id ? Number(req.query.include_user_id) : null;
    res.json(await listLinkableUsers(db, { includeUserId }));
  });

  router.get("/cashier-accounts", requireAuth, requirePayroll, async (_req, res) => {
    res.json(await listCashierAccounts(db));
  });

  router.get("/staff-accounts", requireAuth, requirePayroll, async (_req, res) => {
    res.json(await listStaffAccounts(db));
  });

  router.get("/debt-customers", requireAuth, requirePayroll, async (_req, res) => {
    res.json(await listDebtCustomers(db));
  });

  router.post(
    "/from-cashier-user",
    requireAuth,
    requirePayroll,
    validate(employeeFromCashierUserSchema),
    async (req, res) => {
      const { employee, created } = await createEmployeeFromCashierUser(db, req.body, req);
      res.status(created ? 201 : 200).json(employee);
    }
  );

  router.get(
    "/:id/history",
    requireAuth,
    requirePayroll,
    validate(employeeStatementQuerySchema, "query"),
    async (req, res) => {
      res.json(await getEmployeeHistoryStatement(db, req.params.id, req.query));
    }
  );

  router.get(
    "/:id/invoices/:sourceType/:sourceId/receipt",
    requireAuth,
    requirePayroll,
    async (req, res) => {
      res.json(
        await getEmployeeInvoiceReceipt(
          db,
          req.params.id,
          req.params.sourceType,
          req.params.sourceId
        )
      );
    }
  );

  router.get(
    "/:id/statement",
    requireAuth,
    requirePayroll,
    validate(employeeStatementQuerySchema, "query"),
    async (req, res) => {
      res.json(await getEmployeeStatement(db, req.params.id, req.query));
    }
  );

  router.get(
    "/:id/payroll-preview",
    requireAuth,
    requirePayroll,
    validate(employeePayrollPreviewQuerySchema, "query"),
    async (req, res) => {
      res.json(await getPayrollPreview(db, req.params.id, req.query));
    }
  );

  router.post(
    "/:id/payroll-payouts",
    requireAuth,
    requirePayroll,
    validate(employeePayrollPayoutSchema),
    async (req, res) => {
      const row = await confirmPayrollPayout(db, req.params.id, req.body, req);
      res.status(201).json(row);
    }
  );

  router.post(
    "/:id/debt-payments",
    requireAuth,
    requirePayroll,
    validate(employeeDebtPaymentSchema),
    async (req, res) => {
      const row = await postEmployeeDebtRepayment(db, req.params.id, req.body, req);
      res.status(row.replay ? 200 : 201).json(row);
    }
  );

  router.post(
    "/:id/link-customer",
    requireAuth,
    requirePayroll,
    validate(employeeLinkCustomerSchema),
    async (req, res) => {
      res.json(await linkEmployeeToCustomer(db, req.params.id, req.body, req));
    }
  );

  router.post("/:id/debt-account", requireAuth, requirePayroll, async (req, res) => {
    const { employee, created } = await createEmployeeDebtAccount(db, req.params.id, req);
    res.status(created ? 201 : 200).json(employee);
  });

  router.get(
    "/:id/hours-preview",
    requireAuth,
    requirePayroll,
    validate(employeeHoursPreviewQuerySchema, "query"),
    async (req, res) => {
      res.json(await previewCashierHours(db, req.params.id, req.query.from, req.query.to));
    }
  );

  router.get("/:id", requireAuth, requirePayroll, async (req, res) => {
    res.json(await getEmployee(db, req.params.id));
  });

  router.post("/", requireAuth, requirePayroll, validate(employeeCreateSchema), async (req, res) => {
    const row = await createEmployee(db, req.body, req);
    res.status(201).json(row);
  });

  router.patch("/:id", requireAuth, requirePayroll, validate(employeePatchSchema), async (req, res) => {
    res.json(await updateEmployee(db, req.params.id, req.body, req));
  });

  router.post(
    "/:id/link-user",
    requireAuth,
    requirePayroll,
    validate(employeeLinkCashierUserSchema),
    async (req, res) => {
      const { employee } = await linkEmployeeToCashierUser(db, req.params.id, req.body, req);
      res.json(employee);
    }
  );

  router.post(
    "/:id/wage-basis",
    requireAuth,
    requirePayroll,
    validate(employeeWageBasisSchema),
    async (req, res) => {
      res.json(await setEmployeeWageBasis(db, req.params.id, req.body, req));
    }
  );

  router.post(
    "/:id/compensation",
    requireAuth,
    requirePayroll,
    validate(employeeCompensationSchema),
    async (req, res) => {
      const row = await addCompensation(db, req.params.id, req.body, req);
      res.status(201).json(row);
    }
  );

  router.post(
    "/:id/opening-balances",
    requireAuth,
    requirePayroll,
    validate(employeeOpeningBalanceSchema),
    async (req, res) => {
      const row = await addOpeningBalance(db, req.params.id, req.body, req);
      res.status(201).json(row);
    }
  );

  router.post(
    "/:id/entitlements",
    requireAuth,
    requirePayroll,
    validate(employeeEntitlementCreateSchema),
    async (req, res) => {
      const row = await postSalaryEntitlement(db, req.params.id, req.body, req);
      res.status(201).json(row);
    }
  );

  router.post(
    "/:id/entitlements/:entitlementId/reverse-and-replace",
    requireAuth,
    requirePayroll,
    validate(employeeEntitlementReplaceSchema),
    async (req, res) => {
      const row = await reverseAndReplaceSalaryEntitlement(
        db,
        req.params.id,
        req.params.entitlementId,
        req.body,
        req
      );
      res.json(row);
    }
  );

  router.post(
    "/:id/entitlements/:entitlementId/reverse",
    requireAuth,
    requirePayroll,
    validate(employeeEntitlementReverseSchema),
    async (req, res) => {
      const row = await reverseSalaryEntitlement(
        db,
        req.params.id,
        req.params.entitlementId,
        req.body,
        req
      );
      res.json(row);
    }
  );

  router.post(
    "/:id/payments/:paymentId/correct",
    requireAuth,
    requirePayroll,
    validate(employeePaymentCorrectSchema),
    async (req, res) => {
      const row = await correctOfficeEmployeePayment(
        db,
        req.params.id,
        req.params.paymentId,
        req.body,
        req
      );
      res.json(row);
    }
  );

  router.post(
    "/:id/payments",
    requireAuth,
    requirePayroll,
    validate(employeePaymentCreateSchema),
    async (req, res) => {
      const row = await postOfficeEmployeePayment(db, req.params.id, req.body, req);
      res.status(201).json(row);
    }
  );

  return router;
}
