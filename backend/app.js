import express from "express";
import compression from "compression";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createAuthRouter } from "./routes/auth.js";
import { createProductsRouter } from "./routes/products.js";
import { createCheckoutRouter } from "./routes/checkout.js";
import { createReportsRouter } from "./routes/reports.js";
import { createPrintRouter } from "./routes/print.js";
import { createAdminRouter } from "./routes/admin.js";
import { createFinanceRouter } from "./routes/finance.js";
import { createRefundsRouter } from "./routes/refunds.js";
import { createRefundRequestsRouter } from "./routes/refundRequests.js";
import { createAdvanceRequestsRouter } from "./routes/advanceRequests.js";
import { createOnAccountRequestsRouter } from "./routes/onAccountRequests.js";
import { createTelegramRouter } from "./routes/telegram.js";
import { createShiftsRouter } from "./routes/shifts.js";
import { createSettingsRouter } from "./routes/settings.js";
import { createInventoryRouter } from "./routes/inventory.js";
import { createInventoryDocumentsRouter, createInventoryDocumentPrintRouter } from "./routes/inventoryDocuments.js";
import { createCustomersRouter } from "./routes/customers.js";
import { createBanksRouter } from "./routes/banks.js";
import { createVouchersRouter } from "./routes/vouchers.js";
import { createPosRouter } from "./routes/pos.js";
import { createSuppliersRouter } from "./routes/suppliers.js";
import { createPurchasesRouter } from "./routes/purchases.js";
import { createSalesRouter } from "./routes/sales.js";
import { createExpensesRouter } from "./routes/expenses.js";
import { createDeliveriesRouter } from "./routes/deliveries.js";
import { createMarketingRouter } from "./routes/marketing.js";
import { createWarehousesRouter } from "./routes/warehouses.js";
import { createSuspendedSalesRouter } from "./routes/suspendedSales.js";
import { createCurrenciesRouter } from "./routes/currencies.js";
import { createDebugRouter } from "./routes/debug.js";
import { createOfficeRouter } from "./routes/office.js";
import { createPayrollRouter } from "./routes/payroll.js";
import { createAttendanceRouter } from "./routes/attendance.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { responseEnvelope } from "./middleware/responseEnvelope.js";
import { apiLimiter } from "./middleware/rateLimit.js";
import { requireAuth, enforceMustChangePassword } from "./middleware/auth.js";
import { HttpError } from "./utils/httpError.js";
import { queryCountMiddleware } from "./utils/queryStats.js";
import { isOriginAllowed, parseAllowedOrigins } from "./utils/corsOrigins.js";
import { isPosPublicPath, withPosPrintHelperConnectSrc } from "./utils/posContentSecurityPolicy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function mountApiRoutes(router, db, dbPath, useEnvelope = false) {
  if (useEnvelope) router.use(responseEnvelope);
  router.get("/health", (_req, res) => {
    res.json({
      ok: true,
      serverTime: new Date().toISOString(),
      timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });
  router.use("/auth", createAuthRouter(db));
  router.use("/telegram", createTelegramRouter(db));
  router.use((req, res, next) => {
    if (req.path.startsWith("/attendance/kiosk")) return next();
    requireAuth(req, res, next);
  });
  router.use(enforceMustChangePassword(db));
  router.use("/products", createProductsRouter(db));
  router.use("/checkout", createCheckoutRouter(db));
  router.use("/reports", createReportsRouter(db));
  router.use("/admin", createAdminRouter(db, dbPath));
  router.use("/finance", createFinanceRouter(db));
  router.use("/refunds", createRefundsRouter(db));
  router.use("/refund-requests", createRefundRequestsRouter(db));
  router.use("/advance-requests", createAdvanceRequestsRouter(db));
  router.use("/on-account-requests", createOnAccountRequestsRouter(db));
  router.use("/shifts", createShiftsRouter(db));
  router.use("/settings", createSettingsRouter(db));
  router.use("/inventory", createInventoryRouter(db));
  router.use("/inventory-receipts", createInventoryDocumentsRouter(db, "receipt"));
  router.use("/inventory-issues", createInventoryDocumentsRouter(db, "issue"));
  router.use("/inventory-documents", createInventoryDocumentPrintRouter(db));
  router.use("/customers", createCustomersRouter(db));
  router.use("/banks", createBanksRouter(db));
  router.use("/vouchers", createVouchersRouter(db));
  router.use("/pos", createPosRouter(db));
  router.use("/suppliers", createSuppliersRouter(db));
  router.use("/purchases", createPurchasesRouter(db));
  router.use("/sales", createSalesRouter(db));
  router.use("/expenses", createExpensesRouter(db));
  router.use("/deliveries", createDeliveriesRouter(db));
  router.use("/marketing", createMarketingRouter(db));
  router.use("/warehouses", createWarehousesRouter(db));
  router.use("/suspended-sales", createSuspendedSalesRouter(db));
  router.use("/currencies", createCurrenciesRouter(db));
  router.use("/office", createOfficeRouter(db));
  router.use("/payroll", createPayrollRouter(db));
  router.use("/attendance", createAttendanceRouter(db));
  router.use("/debug", createDebugRouter(db));
  router.use("/", createPrintRouter(db));
}

export function createApp(db, dbPath, options = {}) {
  const { enableStatic = false } = options;
  const allowedOrigins = parseAllowedOrigins();
  if (process.env.NODE_ENV === "production" && allowedOrigins.length === 0) {
    console.warn(
      "[cors] ALLOWED_ORIGINS is empty — same-origin /pos and /admin are allowed; extra hosts (Tailscale) will be denied."
    );
  }
  const app = express();
  app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : false);

  // The app is served over plain HTTP on the store LAN. Helmet's default CSP
  // includes `upgrade-insecure-requests`, which makes browsers rewrite all
  // resource URLs to https:// — the JS bundle then fails to load on any
  // non-localhost client (blank white page). Drop that directive and HSTS.
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
      hsts: false,
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "upgrade-insecure-requests": null,
        },
      },
    })
  );
  // POS fetch() to the cashier helper is blocked by default-src 'self' unless
  // connect-src lists the loopback origin. Patch /pos documents only; do not
  // add a second CSP header (browsers AND multiple policies).
  app.use((req, res, next) => {
    if (!isPosPublicPath(req.path)) return next();
    const current = res.getHeader("Content-Security-Policy");
    if (!current) return next();
    if (Array.isArray(current)) {
      res.setHeader("Content-Security-Policy", current.map((h) => withPosPrintHelperConnectSrc(h)));
    } else {
      res.setHeader("Content-Security-Policy", withPosPrintHelperConnectSrc(current));
    }
    next();
  });
  app.use(compression());
  app.use(requestIdMiddleware);
  app.use(queryCountMiddleware);
  app.use((req, res, next) => {
    cors({
      origin(origin, callback) {
        if (isOriginAllowed(origin, allowedOrigins, req)) {
          callback(null, true);
        } else {
          // Do not next(err): that 500s same-origin LAN POS (Origin is sent,
          // but the page and /api share the shop server). False = no ACAO.
          callback(null, false);
        }
      },
      credentials: true,
      methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "Accept",
        "X-Requested-With",
        "X-Request-Id",
        "X-Kiosk-Key",
        "X-Confirm-Password",
      ],
    })(req, res, next);
  });
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", apiLimiter);

  const v1Router = express.Router();
  mountApiRoutes(v1Router, db, dbPath, true);
  app.use("/api/v1", v1Router);

  const legacyRouter = express.Router();
  mountApiRoutes(legacyRouter, db, dbPath, false);
  app.use("/api", legacyRouter);

  const immutableHandler = (_req, res) => {
    res.status(405).json({
      success: false,
      error: "لا يمكن تعديل أو حذف فاتورة مكتملة — استخدم الاسترجاع",
      code: "IMMUTABLE_TRANSACTION",
    });
  };
  app.use("/api/transactions", immutableHandler);
  app.use("/api/v1/transactions", immutableHandler);

  if (enableStatic) {
    const adminDist = process.env.ADMIN_DIST
      ? path.resolve(process.env.ADMIN_DIST)
      : path.join(__dirname, "public", "admin");
    const posDist = process.env.POS_DIST
      ? path.resolve(process.env.POS_DIST)
      : path.join(__dirname, "public", "pos");

    const staticOptions = {
      maxAge: "1y",
      immutable: true,
      setHeaders(res, filePath) {
        const name = path.basename(filePath);
        if (name === "index.html" || name === "sw.js" || name === "manifest.json") {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        }
      },
    };

    if (fs.existsSync(adminDist)) {
      app.use("/admin", express.static(adminDist, staticOptions));
    }
    if (fs.existsSync(posDist)) {
      app.use("/pos", express.static(posDist, staticOptions));
    }

    app.get("/", (_req, res) => res.redirect("/admin"));

    app.get("/admin/*", (req, res, next) => {
      if (req.path.startsWith("/api")) return next();
      if (!fs.existsSync(path.join(adminDist, "index.html"))) return next();
      res.set("Cache-Control", "no-cache, no-store, must-revalidate");
      res.sendFile(path.join(adminDist, "index.html"));
    });

    app.get("/pos/*", (req, res, next) => {
      if (req.path.startsWith("/api")) return next();
      if (!fs.existsSync(path.join(posDist, "index.html"))) return next();
      res.set("Cache-Control", "no-cache, no-store, must-revalidate");
      res.sendFile(path.join(posDist, "index.html"));
    });
  }

  app.use((err, req, res, _next) => {
    console.error(`[${req.requestId || "no-id"}]`, err);
    const status = err.status || err.statusCode || 500;
    const code = err.code || "INTERNAL_ERROR";
    const message =
      err instanceof HttpError
        ? err.message || "خطأ في الخادم"
        : "خطأ في الخادم";
    res.status(status).json({
      success: false,
      error: message,
      code,
      requestId: req.requestId,
    });
  });

  return app;
}
