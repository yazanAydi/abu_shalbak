/**
 * Permissions audit against disposable databases created by createTestContext.
 * Does not open ./data/supermarket.db and does not change application code.
 *
 * "control" tests assert a protection that holds today.
 * "actual" tests record observed behavior, including gaps. They fail if that
 * behavior changes, so a fix should update the assertion and the audit report.
 */
import { jest } from "@jest/globals";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import request from "supertest";
import { createApp } from "../app.js";
import {
  authHeader,
  createAccountantUser,
  createTestContext,
  createTestEmployee,
  destroyTestContext,
  login,
  withCheckoutKey,
} from "./helpers.js";
import { invalidateUserCache, JWT_OPTIONS, JWT_SECRET } from "../middleware/auth.js";
import { cacheInvalidate } from "../utils/cache.js";
import { purgeExpiredRevocations } from "../utils/sessions.js";
import { setSilentPrintTestAdapter } from "../services/windowsSilentPrint.js";
import {
  allAccountantPermissionsDisabled,
  allAccountantPermissionsEnabled,
  defaultAccountantPermissions,
} from "../utils/accountantPermissions.js";
import { SETTING_KEYS, updateAppSettings } from "../utils/settings.js";

jest.setTimeout(60000);

const TELEGRAM_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_REFUND_BOT_TOKEN",
  "TELEGRAM_ZIMMA_BOT_TOKEN",
  "TELEGRAM_SULAF_BOT_TOKEN",
  "TELEGRAM_EXPIRY_BOT_TOKEN",
  "TELEGRAM_APPROVALS_BOT_TOKEN",
  "TELEGRAM_APPROVALS_CHAT_ID",
  "TELEGRAM_APPROVALS_WEBHOOK_SECRET",
  "TELEGRAM_APPROVALS_USER_IDS",
  "TELEGRAM_MANAGER_CHAT_ID",
  "TELEGRAM_REFUND_CHAT_ID",
  "TELEGRAM_ZIMMA_CHAT_ID",
  "TELEGRAM_SULAF_CHAT_ID",
  "TELEGRAM_EXPIRY_CHAT_ID",
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_REFUND_WEBHOOK_SECRET",
  "TELEGRAM_MANAGER_USER_IDS",
];

function silenceExternalSideEffects() {
  for (const key of TELEGRAM_ENV) process.env[key] = "";
  process.env.RECEIPT_PRINT_AGENT_URL = "";
  process.env.KIOSK_API_KEY = "";
}

function dataOf(body) {
  return body?.data !== undefined ? body.data : body;
}

function assertDenied(res, label) {
  if (![401, 403].includes(res.status)) {
    throw new Error(
      `${label}: expected 401 or 403, got ${res.status} ${JSON.stringify(res.body).slice(0, 500)}`
    );
  }
  if (res.body?.success === true) {
    throw new Error(`${label}: denial claims success ${JSON.stringify(res.body).slice(0, 400)}`);
  }
  if (res.body?.data != null) {
    throw new Error(`${label}: denial included data ${JSON.stringify(res.body.data).slice(0, 400)}`);
  }
}

function financeOverview(app, token) {
  return request(app)
    .get("/api/v1/finance/overview")
    .query({ from: "2026-09-01", to: "2026-09-22" })
    .set(authHeader(token));
}

function only(...keys) {
  const out = allAccountantPermissionsDisabled();
  for (const key of keys) out[key] = true;
  return out;
}

async function insertUser(db, { username, password, role, permissions = null, mustChange = 0 }) {
  const hash = await bcrypt.hash(password, 4);
  const ins = await db.run(
    "INSERT INTO users (username, password, role, must_change_password, permissions_json) VALUES (?, ?, ?, ?, ?)",
    [username, hash, role, mustChange, permissions == null ? null : JSON.stringify(permissions)]
  );
  return { id: ins.lastID, username, password, role };
}

async function countOf(db, sql, params = []) {
  const row = await db.get(sql, params);
  return Number(row?.c) || 0;
}

async function stockOf(db, productId) {
  const row = await db.get("SELECT stock FROM products WHERE id = ?", [productId]);
  return Number(row?.stock);
}

describe("permissions audit — office reads, writes, and defaults", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let clerk;
  let clerkToken;
  let financeOnly;
  let financeToken;
  let bakeryOnly;
  let bakeryToken;
  let productsOnly;
  let productsToken;
  let orgOnly;
  let orgToken;

  beforeAll(async () => {
    silenceExternalSideEffects();
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    clerk = await createAccountantUser(ctx.db, {
      username: "clerkacct",
      password: "clerkpass123",
      permissions: only("user_accounts"),
    });
    financeOnly = await createAccountantUser(ctx.db, {
      username: "financeacct",
      password: "financepass1",
      permissions: only("finance"),
    });
    bakeryOnly = await createAccountantUser(ctx.db, {
      username: "bakeryacct",
      password: "bakerypass1",
      permissions: only("bakery_supplies"),
    });
    productsOnly = await createAccountantUser(ctx.db, {
      username: "productsacct",
      password: "productpass1",
      permissions: only("products"),
    });
    orgOnly = await createAccountantUser(ctx.db, {
      username: "orgacct",
      password: "orgpass123",
      permissions: only("product_organization"),
    });
    clerkToken = (await login(ctx.app, clerk.username, clerk.password, "office")).body.token;
    financeToken = (await login(ctx.app, financeOnly.username, financeOnly.password, "office")).body.token;
    bakeryToken = (await login(ctx.app, bakeryOnly.username, bakeryOnly.password, "office")).body.token;
    productsToken = (await login(ctx.app, productsOnly.username, productsOnly.password, "office")).body.token;
    orgToken = (await login(ctx.app, orgOnly.username, orgOnly.password, "office")).body.token;

    const customer = await request(ctx.app)
      .post("/api/v1/customers")
      .set(authHeader(adminToken))
      .send({
        name: "عميل سري",
        phone: "0599000111",
        address: "شارع الاختبار",
        notes: "SECRET_NOTE_AUDIT",
        opening_balance: 42.5,
      });
    if (customer.status !== 201) {
      throw new Error(`customer seed failed ${customer.status} ${JSON.stringify(customer.body)}`);
    }
    await ctx.db.run("UPDATE products SET stock = 0, min_stock = 5 WHERE id = ?", [ctx.productId]);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("control: unauthenticated business calls are rejected with no payload", async () => {
    const paths = [
      "/api/v1/finance/overview",
      "/api/v1/admin/users",
      "/api/v1/products?search=Test",
      "/api/v1/customers",
      "/api/v1/checkout",
    ];
    for (const path of paths) {
      const res = await request(ctx.app).get(path);
      assertDenied(res, path);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("UNAUTHORIZED");
    }
  });

  test("control: cashier is denied office writes and reports on both API prefixes", async () => {
    const probes = [
      ["get", "/api/v1/admin/users"],
      ["get", "/api/admin/users"],
      ["get", "/api/v1/finance/overview"],
      ["get", "/api/finance/overview"],
      ["get", "/api/v1/reports/today"],
      ["get", "/api/v1/expenses"],
      ["get", "/api/v1/vouchers"],
      ["get", "/api/v1/purchases/invoices"],
      ["get", "/api/v1/sales/invoices"],
      ["get", "/api/v1/employees"],
      ["get", "/api/v1/payroll/cashiers"],
      ["get", "/api/v1/banks/accounts"],
      ["get", "/api/v1/inventory/adjustments"],
      ["get", "/api/v1/inventory-receipts"],
      ["get", "/api/v1/shifts"],
      ["get", "/api/v1/refund-requests/pending"],
      ["get", "/api/v1/on-account-requests/pending"],
      ["get", "/api/v1/advance-requests/pending"],
      ["get", "/api/v1/admin/audit-logs"],
      ["get", "/api/v1/debug/barcode/9990001"],
      ["post", "/api/v1/admin/backup"],
      ["post", "/api/v1/products"],
      ["post", "/api/v1/expenses"],
    ];
    for (const [method, path] of probes) {
      const res = await request(ctx.app)[method](path).set(authHeader(cashierToken)).send({});
      assertDenied(res, `${method} ${path}`);
    }
  });

  test("control: portals, kiosk roles, and forced password change block the wrong surface", async () => {
    const officeAsCashier = await login(ctx.app, "testcashier", "cashpass123", "office");
    expect(officeAsCashier.status).toBe(403);
    expect(officeAsCashier.body.token).toBeUndefined();
    expect(officeAsCashier.body.code).toBe("WRONG_LOGIN_PORTAL");

    const posAsAdmin = await login(ctx.app, "testadmin", "adminpass123", "pos");
    expect(posAsAdmin.status).toBe(403);
    expect(posAsAdmin.body.token).toBeUndefined();

    const kiosk = await insertUser(ctx.db, {
      username: "shelfworker",
      password: "shelfpass1",
      role: "shelves_employee",
    });
    const officeKiosk = await login(ctx.app, kiosk.username, kiosk.password, "office");
    const posKiosk = await login(ctx.app, kiosk.username, kiosk.password, "pos");
    expect(officeKiosk.status).toBe(403);
    expect(posKiosk.status).toBe(403);
    expect(officeKiosk.body.token).toBeUndefined();
    expect(posKiosk.body.token).toBeUndefined();
  });

  test("control: catalog list, product price, and settings writes stay behind their keys", async () => {
    const list = await request(ctx.app).get("/api/v1/products").set(authHeader(clerkToken));
    assertDenied(list, "catalog list");

    const priceBefore = Number(
      (await ctx.db.get("SELECT price FROM products WHERE id = ?", [ctx.productId])).price
    );
    const priceAttempt = await request(ctx.app)
      .put(`/api/v1/products/${ctx.productId}`)
      .set(authHeader(orgToken))
      .send({ price: 1 });
    assertDenied(priceAttempt, "org price change");
    const priceAfter = Number(
      (await ctx.db.get("SELECT price FROM products WHERE id = ?", [ctx.productId])).price
    );
    expect(priceAfter).toBe(priceBefore);

    const category = await request(ctx.app)
      .put(`/api/v1/products/${ctx.productId}`)
      .set(authHeader(orgToken))
      .send({ category: "تنظيم" });
    expect(category.status).toBe(200);
    expect(Number((await ctx.db.get("SELECT price FROM products WHERE id = ?", [ctx.productId])).price)).toBe(
      priceBefore
    );

    const thresholdBefore = (await ctx.db.get(
      "SELECT value FROM app_settings WHERE key = ?",
      [SETTING_KEYS.shift_variance_threshold]
    ))?.value;
    const settingsWrite = await request(ctx.app)
      .patch("/api/v1/settings")
      .set(authHeader(clerkToken))
      .send({ shift_variance_threshold: 1 });
    assertDenied(settingsWrite, "settings patch");
    const thresholdAfter = (await ctx.db.get(
      "SELECT value FROM app_settings WHERE key = ?",
      [SETTING_KEYS.shift_variance_threshold]
    ))?.value;
    expect(thresholdAfter).toBe(thresholdBefore);

    const retailCreate = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(bakeryToken))
      .send({ barcode: "8811002001", name: "منتج مفرق", price: 4, cost: 1, stock: 1, inventory_scope: "retail" });
    assertDenied(retailCreate, "bakery user creating retail");
    const bakeryCreate = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(bakeryToken))
      .send({ barcode: "8811002002", name: "مادة مخبز", price: 4, cost: 1, stock: 1, inventory_scope: "bakery" });
    expect(bakeryCreate.status).toBe(201);

    const productsCreate = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(productsToken))
      .send({ barcode: "8811002003", name: "منتج صلاحية", price: 6, cost: 2, stock: 1, inventory_scope: "retail" });
    expect(productsCreate.status).toBe(201);
  });

  test("regression: product search and barcode lookup deny an unrelated office user and omit cashier cost", async () => {
    const search = await request(ctx.app)
      .get("/api/v1/products")
      .query({ search: "Test" })
      .set(authHeader(clerkToken));
    assertDenied(search, "clerk product search");

    const legacy = await request(ctx.app)
      .get("/api/products/9990001")
      .set(authHeader(clerkToken));
    assertDenied(legacy, "clerk barcode");

    const v1Barcode = await request(ctx.app)
      .get("/api/v1/products/9990001")
      .set(authHeader(clerkToken));
    assertDenied(v1Barcode, "clerk v1 barcode");

    const cashierSearch = await request(ctx.app)
      .get("/api/v1/products")
      .query({ search: "9990001" })
      .set(authHeader(cashierToken));
    expect(cashierSearch.status).toBe(200);
    const cashierRows = dataOf(cashierSearch.body);
    expect(cashierRows.length).toBeGreaterThan(0);
    expect(cashierRows.every((row) => row.cost == null)).toBe(true);

    const productsSearch = await request(ctx.app)
      .get("/api/v1/products")
      .query({ search: "9990001" })
      .set(authHeader(productsToken));
    expect(productsSearch.status).toBe(200);
    expect(dataOf(productsSearch.body).some((row) => Number(row.cost) === 5)).toBe(true);
  });

  test("regression: customer notes stay off unrelated office searches and on the cashier selling projection", async () => {
    const list = await request(ctx.app).get("/api/v1/customers").set(authHeader(clerkToken));
    assertDenied(list, "clerk customers");
    const legacy = await request(ctx.app).get("/api/customers").set(authHeader(clerkToken));
    assertDenied(legacy, "clerk legacy customers");

    const adminList = await request(ctx.app).get("/api/v1/customers").set(authHeader(adminToken));
    expect(adminList.status).toBe(200);
    const secret = dataOf(adminList.body).find((row) => row.notes === "SECRET_NOTE_AUDIT");
    expect(secret).toBeTruthy();
    const clerkDetail = await request(ctx.app)
      .get(`/api/v1/customers/${secret.id}`)
      .set(authHeader(clerkToken));
    assertDenied(clerkDetail, "clerk customer detail");

    const cashierList = await request(ctx.app).get("/api/v1/customers").set(authHeader(cashierToken));
    expect(cashierList.status).toBe(200);
    const projected = dataOf(cashierList.body).find((row) => row.id === secret.id);
    expect(projected.notes).toBeUndefined();
    expect(projected.address).toBeUndefined();
    expect(Number(projected.balance)).toBeCloseTo(42.5, 2);

    const ledger = await request(ctx.app)
      .get(`/api/v1/customers/${secret.id}/ledger`)
      .set(authHeader(clerkToken));
    assertDenied(ledger, "customer ledger without finance");
  });

  test("regression: finance permission does not write suppliers, payments, or expenses", async () => {
    const suppliersBefore = await countOf(ctx.db, "SELECT COUNT(*) AS c FROM suppliers");
    const paymentsBefore = await countOf(ctx.db, "SELECT COUNT(*) AS c FROM supplier_payments");
    const expensesBefore = await countOf(ctx.db, "SELECT COUNT(*) AS c FROM operating_expenses");

    const direct = await request(ctx.app)
      .post("/api/v1/suppliers")
      .set(authHeader(financeToken))
      .send({ name: "مورد مباشر" });
    assertDenied(direct, "POST /suppliers");
    expect(await countOf(ctx.db, "SELECT COUNT(*) AS c FROM suppliers")).toBe(suppliersBefore);

    const viaFinance = await request(ctx.app)
      .post("/api/v1/finance/suppliers")
      .set(authHeader(financeToken))
      .send({ name: "مورد عبر المالية" });
    assertDenied(viaFinance, "finance supplier alias");
    const legacyFinance = await request(ctx.app)
      .post("/api/finance/suppliers")
      .set(authHeader(financeToken))
      .send({ name: "مورد عبر المالية" });
    assertDenied(legacyFinance, "legacy finance supplier alias");
    expect(await countOf(ctx.db, "SELECT COUNT(*) AS c FROM suppliers")).toBe(suppliersBefore);

    const seeded = await request(ctx.app)
      .post("/api/v1/suppliers")
      .set(authHeader(adminToken))
      .send({ name: "مورد مصرح" });
    expect(seeded.status).toBe(201);
    const supplierId = dataOf(seeded.body).id;

    const payment = await request(ctx.app)
      .post("/api/v1/finance/payments")
      .set(authHeader(financeToken))
      .send({ supplier_id: supplierId, amount: 25, paid_on: "2026-09-22", payment_method: "cash" });
    assertDenied(payment, "finance payment alias");
    expect(await countOf(ctx.db, "SELECT COUNT(*) AS c FROM supplier_payments")).toBe(paymentsBefore);

    const expense = await request(ctx.app)
      .post("/api/v1/finance/operating-expenses")
      .set(authHeader(financeToken))
      .send({ category: "rent", amount: 15, paid_on: "2026-09-22", payment_method: "cash" });
    assertDenied(expense, "finance expense alias");
    const legacyExpense = await request(ctx.app)
      .post("/api/finance/operating-expenses")
      .set(authHeader(financeToken))
      .send({ category: "rent", amount: 15, paid_on: "2026-09-22", payment_method: "cash" });
    assertDenied(legacyExpense, "legacy finance expense");
    expect(await countOf(ctx.db, "SELECT COUNT(*) AS c FROM operating_expenses")).toBe(expensesBefore);

    const overview = await financeOverview(ctx.app, financeToken);
    expect(overview.status).toBe(200);
    const adminPay = await request(ctx.app)
      .post("/api/v1/finance/payments")
      .set(authHeader(adminToken))
      .send({ supplier_id: supplierId, amount: 25, paid_on: "2026-09-22", payment_method: "cash" });
    expect(adminPay.status).toBe(201);
    const adminExpense = await request(ctx.app)
      .post("/api/v1/finance/operating-expenses")
      .set(authHeader(adminToken))
      .send({ category: "rent", amount: 15, paid_on: "2026-09-22", payment_method: "cash" });
    expect(adminExpense.status).toBe(201);

    const purchase = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(financeToken))
      .send({ supplier_id: supplierId, items: [] });
    assertDenied(purchase, "purchase invoice");

    const cashierPay = await request(ctx.app)
      .post("/api/v1/finance/payments")
      .set(authHeader(cashierToken))
      .send({ supplier_id: supplierId, amount: 10, paid_on: "2026-09-22" });
    assertDenied(cashierPay, "cashier supplier payment");
    expect(await countOf(ctx.db, "SELECT COUNT(*) AS c FROM supplier_payments")).toBe(paymentsBefore);
    const paid = await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId]);
    expect(Number(paid.balance)).toBe(-25);
  });

  test("regression: nav badges and settings omit sections the caller cannot open", async () => {
    const badges = await request(ctx.app).get("/api/v1/office/nav-badges").set(authHeader(clerkToken));
    expect(badges.status).toBe(200);
    const payload = dataOf(badges.body);
    expect(payload.low_stock_preview).toEqual([]);
    expect(payload.retail_low_stock).toBe(0);
    expect(payload.pending_refunds).toBe(0);
    expect(payload.by_path["/inventory"]).toBe(0);
    expect(JSON.stringify(payload)).not.toMatch(/Test Product/);

    const settings = await request(ctx.app).get("/api/v1/settings").set(authHeader(clerkToken));
    expect(settings.status).toBe(200);
    expect(dataOf(settings.body).accountant_permissions).toBeUndefined();
    expect(dataOf(settings.body).refund_telegram_manager_user_id).toBeUndefined();

    const cashierSettings = await request(ctx.app).get("/api/v1/settings").set(authHeader(cashierToken));
    expect(cashierSettings.status).toBe(200);
    expect(dataOf(cashierSettings.body).accountant_permissions).toBeUndefined();
    expect(dataOf(cashierSettings.body).refund_telegram_manager_user_id).toBeUndefined();

    const adminSettings = await request(ctx.app).get("/api/v1/settings").set(authHeader(adminToken));
    expect(adminSettings.status).toBe(200);
    expect(dataOf(adminSettings.body).accountant_permissions).toBeTruthy();
    expect(dataOf(adminSettings.body).refund_telegram_manager_user_id).toBeDefined();

    const warehouses = await request(ctx.app).get("/api/v1/warehouses").set(authHeader(cashierToken));
    assertDenied(warehouses, "cashier warehouses");
    const officeWarehouses = await request(ctx.app).get("/api/v1/warehouses").set(authHeader(adminToken));
    expect(officeWarehouses.status).toBe(200);
    expect(dataOf(officeWarehouses.body).length).toBeGreaterThan(0);
  });

  test("regression: a partial permission map stores omitted keys off", async () => {
    await updateAppSettings(ctx.db, {
      [SETTING_KEYS.accountant_permissions]: allAccountantPermissionsDisabled(),
    });
    const narrow = await createAccountantUser(ctx.db, {
      username: "partialacct",
      password: "partialpass1",
      permissions: null,
    });
    const saved = await request(ctx.app)
      .put(`/api/v1/admin/users/${narrow.id}/permissions`)
      .set(authHeader(adminToken))
      .send({ permissions: { dashboard: true } });
    expect(saved.status).toBe(200);
    const stored = dataOf(saved.body).permissions;
    expect(stored.dashboard).toBe(true);
    expect(stored.finance).toBe(false);
    expect(stored.refund_approvals).toBe(false);
    expect(stored.suppliers).toBe(false);

    const token = (await login(ctx.app, narrow.username, narrow.password, "office")).body.token;
    const finance = await financeOverview(ctx.app, token);
    assertDenied(finance, "omitted finance");
    const products = await request(ctx.app).get("/api/v1/products").set(authHeader(token));
    assertDenied(products, "products stays off");
    const suppliers = await request(ctx.app).get("/api/v1/suppliers").set(authHeader(token));
    assertDenied(suppliers, "omitted suppliers");
    const dashboard = await request(ctx.app).get("/api/v1/reports/today").set(authHeader(token));
    expect(dashboard.status).toBe(200);
  });

  test("regression: corrupt permissions_json denies protected access", async () => {
    await updateAppSettings(ctx.db, {
      [SETTING_KEYS.accountant_permissions]: defaultAccountantPermissions(),
    });
    const locked = await createAccountantUser(ctx.db, {
      username: "corruptacct",
      password: "corruptpass1",
      permissions: allAccountantPermissionsDisabled(),
    });
    const before = await login(ctx.app, locked.username, locked.password, "office");
    const denied = await request(ctx.app)
      .get("/api/v1/finance/overview")
      .set(authHeader(before.body.token));
    assertDenied(denied, "custom all-off finance");

    await ctx.db.run("UPDATE users SET permissions_json = ? WHERE id = ?", ["%%%", locked.id]);
    invalidateUserCache(locked.id);
    const after = await financeOverview(ctx.app, before.body.token);
    expect(after.status).toBe(403);
    expect(after.body.code).toBe("PERMISSIONS_CORRUPT");
    expect(after.body.success).not.toBe(true);
  });

  test("regression: unknown permission keys and non-booleans are rejected without saving", async () => {
    const user = await createAccountantUser(ctx.db, {
      username: "unknownkeyacct",
      password: "unknownpass1",
      permissions: null,
    });
    const saved = await request(ctx.app)
      .put(`/api/v1/admin/users/${user.id}/permissions`)
      .set(authHeader(adminToken))
      .send({
        permissions: {
          ...allAccountantPermissionsDisabled(),
          finance: "false",
          not_a_real_permission: true,
        },
      });
    expect(saved.status).toBe(400);
    expect(saved.body.code).toBe("INVALID_PERMISSIONS");
    const row = await ctx.db.get("SELECT permissions_json FROM users WHERE id = ?", [user.id]);
    expect(row.permissions_json).toBeNull();
    await updateAppSettings(ctx.db, {
      [SETTING_KEYS.accountant_permissions]: allAccountantPermissionsDisabled(),
    });
    const token = (await login(ctx.app, user.username, user.password, "office")).body.token;
    const finance = await financeOverview(ctx.app, token);
    assertDenied(finance, "unchanged null map");
  });

  test("control: kiosk punch and telegram webhook do not run without their secrets", async () => {
    const punchesBefore = await countOf(ctx.db, "SELECT COUNT(*) AS c FROM attendance_punches");
    const punch = await request(ctx.app).post("/api/v1/attendance/kiosk/punch").send({ user_id: 1 });
    expect([401, 503]).toContain(punch.status);
    expect(punch.body.success).not.toBe(true);
    expect(await countOf(ctx.db, "SELECT COUNT(*) AS c FROM attendance_punches")).toBe(punchesBefore);

    const refundsBefore = await countOf(ctx.db, "SELECT COUNT(*) AS c FROM refund_requests");
    const hook = await request(ctx.app)
      .post("/api/v1/telegram/webhook/not-the-secret")
      .send({ callback_query: { id: "1", data: "refund:approve:1", from: { id: 1 } } });
    expect(hook.status).toBe(403);
    expect(await countOf(ctx.db, "SELECT COUNT(*) AS c FROM refund_requests")).toBe(refundsBefore);
  });
});

describe("permissions audit — account authority and live sessions", () => {
  let ctx;
  let adminToken;
  let adminId;

  beforeAll(async () => {
    silenceExternalSideEffects();
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    adminId = (await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testadmin"])).id;
    await updateAppSettings(ctx.db, {
      [SETTING_KEYS.accountant_permissions]: defaultAccountantPermissions(),
    });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("regression: user_accounts cannot mint an accountant beyond the actor's permissions", async () => {
    const clerk = await createAccountantUser(ctx.db, {
      username: "usermgr",
      password: "usermgrpass1",
      permissions: only("user_accounts"),
    });
    const clerkToken = (await login(ctx.app, clerk.username, clerk.password, "office")).body.token;
    const usersBefore = await countOf(ctx.db, "SELECT COUNT(*) AS c FROM users");

    const spawned = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(clerkToken))
      .send({ username: "spawnedacct", password: "spawned123", role: "accountant" });
    expect(spawned.status).toBe(403);
    expect(await countOf(ctx.db, "SELECT COUNT(*) AS c FROM users")).toBe(usersBefore);
    expect(await login(ctx.app, "spawnedacct", "spawned123", "office")).toMatchObject({ status: 401 });

    const cashier = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(clerkToken))
      .send({ username: "spawnedcashier", password: "spawned123", role: "cashier" });
    expect(cashier.status).toBe(201);
    const clerkFinance = await financeOverview(ctx.app, clerkToken);
    assertDenied(clerkFinance, "creator finance");

    const makeAdmin = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(clerkToken))
      .send({ username: "fakeadmin", password: "fakeadmin1", role: "admin" });
    assertDenied(makeAdmin, "create admin");
    expect(await countOf(ctx.db, "SELECT COUNT(*) AS c FROM users WHERE role = 'admin'")).toBe(1);

    const selfPromote = await request(ctx.app)
      .patch(`/api/v1/admin/users/${clerk.id}`)
      .set(authHeader(clerkToken))
      .send({ role: "admin" });
    assertDenied(selfPromote, "self promote");
    expect((await ctx.db.get("SELECT role FROM users WHERE id = ?", [clerk.id])).role).toBe("accountant");

    const touchAdmin = await request(ctx.app)
      .patch(`/api/v1/admin/users/${adminId}`)
      .set(authHeader(clerkToken))
      .send({ password: "hackedadmin1" });
    assertDenied(touchAdmin, "reset admin password");
    const adminStill = await login(ctx.app, "testadmin", "adminpass123", "office");
    expect(adminStill.status).toBe(200);
  });

  test("regression: user_accounts cannot reset a more privileged accountant", async () => {
    const privileged = await createAccountantUser(ctx.db, {
      username: "privilegedacct",
      password: "privileged1",
      permissions: allAccountantPermissionsEnabled(),
    });
    const clerk = await createAccountantUser(ctx.db, {
      username: "usermgr2",
      password: "usermgrpass2",
      permissions: only("user_accounts"),
    });
    const clerkToken = (await login(ctx.app, clerk.username, clerk.password, "office")).body.token;
    const reset = await request(ctx.app)
      .patch(`/api/v1/admin/users/${privileged.id}`)
      .set(authHeader(clerkToken))
      .send({ password: "takenover1" });
    expect(reset.status).toBe(403);
    expect(JSON.stringify(reset.body)).not.toMatch(/\$2[aby]\$/);

    const oldLogin = await login(ctx.app, privileged.username, privileged.password, "office");
    expect(oldLogin.status).toBe(200);
    const taken = await login(ctx.app, privileged.username, "takenover1", "office");
    expect(taken.status).toBe(401);
    const finance = await request(ctx.app)
      .get("/api/v1/refund-requests/pending")
      .set(authHeader(oldLogin.body.token));
    expect(finance.status).toBe(200);
    const clerkApprovals = await request(ctx.app)
      .get("/api/v1/refund-requests/pending")
      .set(authHeader(clerkToken));
    assertDenied(clerkApprovals, "clerk approvals");

    const assign = await request(ctx.app)
      .put(`/api/v1/admin/users/${clerk.id}/permissions`)
      .set(authHeader(clerkToken))
      .send({ permissions: allAccountantPermissionsEnabled() });
    assertDenied(assign, "clerk assigns permissions");
  });

  test("regression: logout, password change, and role change revoke the old token", async () => {
    const user = await createAccountantUser(ctx.db, {
      username: "sessionacct",
      password: "sessionpass1",
      permissions: only("finance"),
    });
    const first = await login(ctx.app, user.username, user.password, "office");
    const second = await login(ctx.app, user.username, user.password, "office");
    const token = first.body.token;
    const other = second.body.token;

    const logout = await request(ctx.app).post("/api/v1/auth/logout").set(authHeader(token));
    expect(logout.status).toBe(200);
    const afterLogout = await financeOverview(ctx.app, token);
    expect(afterLogout.status).toBe(401);
    expect(afterLogout.body.code).toBe("SESSION_REVOKED");
    const otherStill = await financeOverview(ctx.app, other);
    expect(otherStill.status).toBe(200);

    const changed = await request(ctx.app)
      .post("/api/v1/auth/change-password")
      .set(authHeader(other))
      .send({ current_password: user.password, new_password: "sessionpass2" });
    expect(changed.status).toBe(200);
    const nextToken = dataOf(changed.body).token;
    expect(nextToken).toBeTruthy();
    expect(nextToken).not.toBe(other);
    const oldPassword = await login(ctx.app, user.username, user.password, "office");
    expect(oldPassword.status).toBe(401);
    expect((await financeOverview(ctx.app, other)).status).toBe(401);
    expect((await financeOverview(ctx.app, nextToken)).status).toBe(200);

    const demote = await request(ctx.app)
      .patch(`/api/v1/admin/users/${user.id}`)
      .set(authHeader(adminToken))
      .send({ role: "cashier" });
    expect(demote.status).toBe(200);
    const me = await request(ctx.app).get("/api/v1/auth/me").set(authHeader(nextToken));
    expect(me.status).toBe(401);
    const financeAfterDemotion = await financeOverview(ctx.app, nextToken);
    expect(financeAfterDemotion.status).toBe(401);
    const posLogin = await login(ctx.app, user.username, "sessionpass2", "pos");
    expect(posLogin.status).toBe(200);
    const officeAfter = await login(ctx.app, user.username, "sessionpass2", "office");
    expect(officeAfter.status).toBe(403);
  });

  test("regression: deleting a user revokes that user's token", async () => {
    const doomed = await createAccountantUser(ctx.db, {
      username: "doomedacct",
      password: "doomedpass1",
      permissions: only("finance"),
    });
    const token = (await login(ctx.app, doomed.username, doomed.password, "office")).body.token;
    const removed = await request(ctx.app)
      .delete(`/api/v1/admin/users/${doomed.id}`)
      .set(authHeader(adminToken));
    expect(removed.status).toBe(204);
    expect(await ctx.db.get("SELECT id FROM users WHERE id = ?", [doomed.id])).toBeUndefined();

    const me = await request(ctx.app).get("/api/v1/auth/me").set(authHeader(token));
    expect(me.status).toBe(401);
    const finance = await financeOverview(ctx.app, token);
    expect(finance.status).toBe(401);
    expect(finance.body.code).toBe("SESSION_REVOKED");
  });

  test("control: must_change_password blocks business APIs immediately and allows the password route", async () => {
    const user = await createAccountantUser(ctx.db, {
      username: "mustchangeacct",
      password: "mustchangep1",
      permissions: only("finance"),
    });
    const token = (await login(ctx.app, user.username, user.password, "office")).body.token;
    await ctx.db.run("UPDATE users SET must_change_password = 1 WHERE id = ?", [user.id]);

    const blocked = await financeOverview(ctx.app, token);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("PASSWORD_CHANGE_REQUIRED");
    expect(blocked.body.data).toBeUndefined();

    const me = await request(ctx.app).get("/api/v1/auth/me").set(authHeader(token));
    expect(me.status).toBe(200);
    expect(dataOf(me.body).user.must_change_password).toBe(true);

    const changed = await request(ctx.app)
      .post("/api/v1/auth/change-password")
      .set(authHeader(token))
      .send({ current_password: user.password, new_password: "mustchangep2" });
    expect(changed.status).toBe(200);
    const nextToken = dataOf(changed.body).token;
    expect(nextToken).toBeTruthy();
    expect((await financeOverview(ctx.app, token)).status).toBe(401);
    const open = await financeOverview(ctx.app, nextToken);
    expect(open.status).toBe(200);
  });

  test("control: removing a permission key takes effect on the next request", async () => {
    const user = await createAccountantUser(ctx.db, {
      username: "revokekeyacct",
      password: "revokepass1",
      permissions: only("finance"),
    });
    const token = (await login(ctx.app, user.username, user.password, "office")).body.token;
    const before = await financeOverview(ctx.app, token);
    expect(before.status).toBe(200);
    const saved = await request(ctx.app)
      .put(`/api/v1/admin/users/${user.id}/permissions`)
      .set(authHeader(adminToken))
      .send({ permissions: allAccountantPermissionsDisabled() });
    expect(saved.status).toBe(200);
    const after = await financeOverview(ctx.app, token);
    assertDenied(after, "finance after revoke");
  });

  test("regression: a legacy token without session metadata is rejected", async () => {
    const user = await createAccountantUser(ctx.db, {
      username: "legacyacct",
      password: "legacypass1",
      permissions: only("finance"),
    });
    const legacy = jwt.sign(
      { id: user.id, username: user.username, role: "admin" },
      JWT_SECRET,
      JWT_OPTIONS
    );
    const replay = await financeOverview(ctx.app, legacy);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe("SESSION_REVOKED");
    const fresh = await login(ctx.app, user.username, user.password, "office");
    expect(fresh.status).toBe(200);
    expect((await financeOverview(ctx.app, fresh.body.token)).status).toBe(200);
  });

  test("regression: logout revocation survives a new app instance and expired rows are purged", async () => {
    const user = await createAccountantUser(ctx.db, {
      username: "persistacct",
      password: "persistpass1",
      permissions: only("finance"),
    });
    const token = (await login(ctx.app, user.username, user.password, "office")).body.token;
    expect((await request(ctx.app).post("/api/v1/auth/logout").set(authHeader(token))).status).toBe(200);
    await ctx.db.run(
      "INSERT OR REPLACE INTO revoked_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)",
      ["expired-jti", user.id, Date.now() - 1000]
    );
    await purgeExpiredRevocations(ctx.db, { force: true });
    expect(await ctx.db.get("SELECT jti FROM revoked_tokens WHERE jti = ?", ["expired-jti"])).toBeUndefined();

    cacheInvalidate();
    const restarted = createApp(ctx.db, ctx.dbPath);
    const replay = await financeOverview(restarted, token);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe("SESSION_REVOKED");
    const again = await login(restarted, user.username, user.password, "office");
    expect((await financeOverview(restarted, again.body.token)).status).toBe(200);
  });

  test("regression: username admin does not accept admin123 unless that is the stored password", async () => {
    const recovery = await insertUser(ctx.db, {
      username: "admin",
      password: "changed-admin-pass",
      role: "admin",
    });
    const withRecovery = await login(ctx.app, "admin", "admin123", "office");
    expect(withRecovery.status).toBe(401);
    expect(withRecovery.body.token).toBeUndefined();

    const real = await login(ctx.app, "admin", "changed-admin-pass", "office");
    expect(real.status).toBe(200);
    const changed = await request(ctx.app)
      .post("/api/v1/auth/change-password")
      .set(authHeader(real.body.token))
      .send({ current_password: "changed-admin-pass", new_password: "another-admin-pass" });
    expect(changed.status).toBe(200);
    expect((await login(ctx.app, "admin", "admin123", "office")).status).toBe(401);
    expect((await login(ctx.app, "admin", "changed-admin-pass", "office")).status).toBe(401);
    expect((await login(ctx.app, "admin", "another-admin-pass", "office")).status).toBe(200);
    const otherUser = await login(ctx.app, "testadmin", "admin123", "office");
    expect(otherUser.status).toBe(401);
    expect(recovery.id).toBeTruthy();
  });
});

describe("permissions audit — POS ownership, checkout, and approvals", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let cashier2Token;
  let cashier2Id;
  let shiftId;
  let shift2Id;
  let transactionId;
  let printCalls;
  let approverToken;
  let readerToken;
  let noApprovalToken;
  let badgeToken;

  beforeAll(async () => {
    silenceExternalSideEffects();
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    const cashier2 = await insertUser(ctx.db, {
      username: "cashier2",
      password: "cashier2pass",
      role: "cashier",
    });
    cashier2Id = cashier2.id;
    cashier2Token = (await login(ctx.app, cashier2.username, cashier2.password, "pos")).body.token;
    const approver = await createAccountantUser(ctx.db, {
      username: "approveracct",
      password: "approverpass1",
      permissions: only("refund_approvals", "on_account_approvals", "advance_approvals", "refunds"),
    });
    const reader = await createAccountantUser(ctx.db, {
      username: "refundreader",
      password: "readerpass123",
      permissions: only("refunds"),
    });
    const noApproval = await createAccountantUser(ctx.db, {
      username: "noapproval",
      password: "noapprovalp1",
      permissions: only("dashboard"),
    });
    const badges = await createAccountantUser(ctx.db, {
      username: "badgesonly",
      password: "badgespass1",
      permissions: only("user_accounts"),
    });
    approverToken = (await login(ctx.app, approver.username, approver.password, "office")).body.token;
    readerToken = (await login(ctx.app, reader.username, reader.password, "office")).body.token;
    noApprovalToken = (await login(ctx.app, noApproval.username, noApproval.password, "office")).body.token;
    badgeToken = (await login(ctx.app, badges.username, badges.password, "office")).body.token;

    const start = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({});
    expect(start.status).toBe(201);
    shiftId = dataOf(start.body).shift_id;
    const start2 = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashier2Token))
      .send({});
    expect(start2.status).toBe(201);
    shift2Id = dataOf(start2.body).shift_id;

    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 5, price: product.price }],
          payment_method: "cash",
          cashier_id: cashier2Id,
          shift_id: shift2Id,
        })
      );
    expect(sale.status).toBe(201);
    transactionId = dataOf(sale.body).transaction_id;
    const tx = await ctx.db.get("SELECT cashier_id, shift_id FROM transactions WHERE id = ?", [transactionId]);
    expect(Number(tx.cashier_id)).not.toBe(cashier2Id);
    expect(Number(tx.shift_id)).toBe(Number(shiftId));
  });

  afterEach(() => {
    setSilentPrintTestAdapter(null);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("control: a cashier cannot close, export, or read another cashier's shift", async () => {
    const before = await ctx.db.get("SELECT status FROM cashier_shifts WHERE id = ?", [shiftId]);
    const end = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/end`)
      .set(authHeader(cashier2Token))
      .send({ closing_cash: 0 });
    assertDenied(end, "end other shift");
    const after = await ctx.db.get("SELECT status FROM cashier_shifts WHERE id = ?", [shiftId]);
    expect(after.status).toBe(before.status);

    const detail = await request(ctx.app).get(`/api/v1/shifts/${shiftId}`).set(authHeader(cashier2Token));
    assertDenied(detail, "other shift detail");
    const csv = await request(ctx.app)
      .get(`/api/v1/shifts/${shiftId}/export.csv`)
      .set(authHeader(cashier2Token));
    assertDenied(csv, "other shift csv");

    const own = await request(ctx.app).get(`/api/v1/shifts/${shiftId}`).set(authHeader(cashierToken));
    expect(own.status).toBe(200);
    const list = await request(ctx.app).get("/api/v1/shifts").set(authHeader(noApprovalToken));
    assertDenied(list, "shift list without shift_audit");
  });

  test("control: checkout ignores caller-supplied cashier and shift, and blocks a price override", async () => {
    const idle = await insertUser(ctx.db, {
      username: "noshiftcashier",
      password: "noshiftpass1",
      role: "cashier",
    });
    const idleToken = (await login(ctx.app, idle.username, idle.password, "pos")).body.token;
    const txBefore = await countOf(ctx.db, "SELECT COUNT(*) AS c FROM transactions");
    const stockBefore = await stockOf(ctx.db, ctx.productId);
    const product = await ctx.db.get("SELECT price FROM products WHERE id = ?", [ctx.productId]);

    const noShift = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(idleToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
          payment_method: "cash",
        })
      );
    expect(noShift.status).toBe(400);
    expect(noShift.body.code).toBe("NO_OPEN_SHIFT");
    expect(await countOf(ctx.db, "SELECT COUNT(*) AS c FROM transactions")).toBe(txBefore);

    const mismatch = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashier2Token))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 1, price: 1 }],
          payment_method: "cash",
        })
      );
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe("PRICE_MISMATCH");
    expect(await stockOf(ctx.db, ctx.productId)).toBe(stockBefore);
    expect(await countOf(ctx.db, "SELECT COUNT(*) AS c FROM transactions")).toBe(txBefore);
  });

  test("control: another cashier cannot replay a sale key or reprint the receipt into a new sale", async () => {
    const product = await ctx.db.get("SELECT price FROM products WHERE id = ?", [ctx.productId]);
    const key = `audit-idem-${Date.now()}`;
    const txBefore = await countOf(ctx.db, "SELECT COUNT(*) AS c FROM transactions");
    const first = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey(
          {
            items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
            payment_method: "cash",
          },
          key
        )
      );
    expect(first.status).toBe(201);
    const replay = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashier2Token))
      .send(
        withCheckoutKey(
          {
            items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
            payment_method: "cash",
          },
          key
        )
      );
    expect(replay.status).toBe(403);
    expect(replay.body.code).toBe("IDEMPOTENCY_OWNER_MISMATCH");
    expect(JSON.stringify(replay.body)).not.toMatch(/receipt_html/);
    expect(await countOf(ctx.db, "SELECT COUNT(*) AS c FROM transactions")).toBe(txBefore + 1);

    const sameOwner = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey(
          {
            items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
            payment_method: "cash",
          },
          key
        )
      );
    expect(sameOwner.status).toBe(200);
    expect(dataOf(sameOwner.body).idempotent_replay).toBe(true);
    expect(await countOf(ctx.db, "SELECT COUNT(*) AS c FROM transactions")).toBe(txBefore + 1);

    printCalls = 0;
    setSilentPrintTestAdapter(async () => {
      printCalls += 1;
      return { printed: true, dryRun: true };
    });
    const txAtPrint = await countOf(ctx.db, "SELECT COUNT(*) AS c FROM transactions");
    const foreignPrint = await request(ctx.app)
      .post("/api/v1/print-receipt/silent")
      .set(authHeader(cashier2Token))
      .send({ transaction_id: transactionId });
    assertDenied(foreignPrint, "foreign reprint");
    expect(printCalls).toBe(0);
    const ownPrint = await request(ctx.app)
      .post("/api/v1/print-receipt/silent")
      .set(authHeader(cashierToken))
      .send({ transaction_id: transactionId });
    expect(ownPrint.status).toBe(200);
    expect(printCalls).toBe(1);
    expect(await countOf(ctx.db, "SELECT COUNT(*) AS c FROM transactions")).toBe(txAtPrint);
  });

  test("regression: office refund search requires the refunds permission; cashiers can still search", async () => {
    const search = await request(ctx.app)
      .get("/api/v1/refunds/search")
      .query({ date_from: "2000-01-01" })
      .set(authHeader(noApprovalToken));
    assertDenied(search, "dashboard-only refund search");
    const legacySearch = await request(ctx.app)
      .get("/api/refunds/search")
      .query({ date_from: "2000-01-01" })
      .set(authHeader(noApprovalToken));
    assertDenied(legacySearch, "legacy refund search");
    const readerSearch = await request(ctx.app)
      .get("/api/v1/refunds/search")
      .query({ date_from: "2000-01-01" })
      .set(authHeader(readerToken));
    expect(readerSearch.status).toBe(200);
    expect(
      dataOf(readerSearch.body).sales.some((row) => Number(row.transaction_id) === Number(transactionId))
    ).toBe(true);

    const cashierSearch = await request(ctx.app)
      .get("/api/v1/refunds/search")
      .query({ date_from: "2000-01-01" })
      .set(authHeader(cashier2Token));
    expect(cashierSearch.status).toBe(200);
    expect(
      dataOf(cashierSearch.body).sales.some((row) => Number(row.transaction_id) === Number(transactionId))
    ).toBe(true);

    const pending = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: transactionId,
        lines: [{ product_id: ctx.productId, quantity: 1 }],
        payment_method: "cash",
      });
    expect(pending.status).toBe(201);
    const badges = await request(ctx.app).get("/api/v1/office/nav-badges").set(authHeader(badgeToken));
    expect(badges.status).toBe(200);
    const payload = dataOf(badges.body);
    expect(payload.pending_refunds).toBe(0);
    expect(payload.by_path["/refund-approvals"]).toBe(0);
  });

  test("control: refund request does not post, and approval requires the approval key", async () => {
    const stockBefore = await stockOf(ctx.db, ctx.productId);
    const created = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: transactionId,
        lines: [{ product_id: ctx.productId, quantity: 1 }],
        payment_method: "cash",
        reason: "audit",
      });
    expect(created.status).toBe(201);
    const requestId = dataOf(created.body).request_id;
    expect(await stockOf(ctx.db, ctx.productId)).toBe(stockBefore);

    const otherView = await request(ctx.app)
      .get(`/api/v1/refund-requests/${requestId}`)
      .set(authHeader(cashier2Token));
    assertDenied(otherView, "other cashier refund request");

    const readerApprove = await request(ctx.app)
      .put(`/api/v1/refund-requests/${requestId}`)
      .set(authHeader(readerToken))
      .send({ status: "approved", total_amount: 1 });
    assertDenied(readerApprove, "refunds key is not approval");
    expect((await ctx.db.get("SELECT status, total_amount FROM refund_requests WHERE id = ?", [requestId])).status).toBe(
      "pending"
    );
    expect(await stockOf(ctx.db, ctx.productId)).toBe(stockBefore);

    const approved = await request(ctx.app)
      .put(`/api/v1/refund-requests/${requestId}`)
      .set(authHeader(approverToken))
      .send({ status: "approved", total_amount: 1, customer_id: 999 });
    expect(approved.status).toBe(200);
    const row = await ctx.db.get("SELECT status, total_amount, refund_id FROM refund_requests WHERE id = ?", [
      requestId,
    ]);
    expect(row.status).toBe("approved");
    expect(Number(row.total_amount)).toBeGreaterThan(1);
    expect(await stockOf(ctx.db, ctx.productId)).toBe(stockBefore + 1);

    const again = await request(ctx.app)
      .put(`/api/v1/refund-requests/${requestId}`)
      .set(authHeader(approverToken))
      .send({ status: "approved" });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe("NOT_PENDING");
    expect(await countOf(ctx.db, "SELECT COUNT(*) AS c FROM refunds WHERE id = ?", [row.refund_id])).toBe(1);
    expect(await stockOf(ctx.db, ctx.productId)).toBe(stockBefore + 1);
  });

  test("control: approval permission revoked before the decision does not post the refund", async () => {
    const stockBefore = await stockOf(ctx.db, ctx.productId);
    const created = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: transactionId,
        lines: [{ product_id: ctx.productId, quantity: 1 }],
        payment_method: "cash",
      });
    expect(created.status).toBe(201);
    const requestId = dataOf(created.body).request_id;
    const approver = await ctx.db.get("SELECT id FROM users WHERE username = ?", ["approveracct"]);
    const stripped = await request(ctx.app)
      .put(`/api/v1/admin/users/${approver.id}/permissions`)
      .set(authHeader(adminToken))
      .send({ permissions: only("refunds") });
    expect(stripped.status).toBe(200);
    const decide = await request(ctx.app)
      .put(`/api/v1/refund-requests/${requestId}`)
      .set(authHeader(approverToken))
      .send({ status: "approved" });
    assertDenied(decide, "revoked approver");
    expect((await ctx.db.get("SELECT status FROM refund_requests WHERE id = ?", [requestId])).status).toBe("pending");
    expect(await stockOf(ctx.db, ctx.productId)).toBe(stockBefore);

    await request(ctx.app)
      .put(`/api/v1/admin/users/${approver.id}/permissions`)
      .set(authHeader(adminToken))
      .send({
        permissions: only("refund_approvals", "on_account_approvals", "advance_approvals", "refunds"),
      });
  });

  test("control: advance and on-account requests are not approvals, and a second approval does not post again", async () => {
    const employee = await createTestEmployee(ctx.db, { name: "موظف سلف" });
    const advance = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: employee.id, amount: 20, notes: "سلفة" });
    expect(advance.status).toBe(201);
    const advanceId = dataOf(advance.body).request_id;
    const denyAdvance = await request(ctx.app)
      .put(`/api/v1/advance-requests/${advanceId}`)
      .set(authHeader(readerToken))
      .send({ status: "approved", amount: 500 });
    assertDenied(denyAdvance, "advance approval");
    expect((await ctx.db.get("SELECT status, amount FROM advance_requests WHERE id = ?", [advanceId])).status).toBe(
      "pending"
    );
    expect(
      Number((await ctx.db.get("SELECT amount FROM advance_requests WHERE id = ?", [advanceId])).amount)
    ).toBe(20);

    const customer = await request(ctx.app)
      .post("/api/v1/customers")
      .set(authHeader(adminToken))
      .send({ name: "عميل ذمة", credit_limit: 500 });
    expect(customer.status).toBe(201);
    const customerId = dataOf(customer.body).id;
    const product = await ctx.db.get("SELECT price, stock FROM products WHERE id = ?", [ctx.productId]);
    const stockBefore = Number(product.stock);
    const txBefore = await countOf(ctx.db, "SELECT COUNT(*) AS c FROM transactions");
    const pending = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
          payment_method: "on_account",
          customer_id: customerId,
        })
      );
    expect(pending.status).toBe(202);
    const requestId = dataOf(pending.body).request_id;
    expect(await countOf(ctx.db, "SELECT COUNT(*) AS c FROM transactions")).toBe(txBefore);
    expect(await stockOf(ctx.db, ctx.productId)).toBe(stockBefore);

    const denied = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${requestId}`)
      .set(authHeader(readerToken))
      .send({ status: "approved", total_amount: 1, customer_id: 999 });
    assertDenied(denied, "on-account approval");
    expect(await stockOf(ctx.db, ctx.productId)).toBe(stockBefore);

    const approved = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${requestId}`)
      .set(authHeader(approverToken))
      .send({ status: "approved", total_amount: 1, customer_id: 999 });
    expect(approved.status).toBe(200);
    expect(await countOf(ctx.db, "SELECT COUNT(*) AS c FROM transactions")).toBe(txBefore + 1);
    expect(await stockOf(ctx.db, ctx.productId)).toBe(stockBefore - 1);
    const posted = await ctx.db.get(
      "SELECT customer_id, total FROM transactions ORDER BY id DESC LIMIT 1"
    );
    expect(Number(posted.customer_id)).toBe(Number(customerId));
    expect(Number(posted.total)).toBe(Number(product.price));

    const again = await request(ctx.app)
      .put(`/api/v1/on-account-requests/${requestId}`)
      .set(authHeader(approverToken))
      .send({ status: "approved" });
    expect(again.status).toBe(400);
    expect(await countOf(ctx.db, "SELECT COUNT(*) AS c FROM transactions")).toBe(txBefore + 1);
  });

  test("policy: an admin can request and approve the same refund", async () => {
    const start = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(adminToken)).send({});
    expect(start.status).toBe(201);
    const product = await ctx.db.get("SELECT price FROM products WHERE id = ?", [ctx.productId]);
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(adminToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
          payment_method: "cash",
        })
      );
    expect(sale.status).toBe(201);
    const created = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(adminToken))
      .send({
        original_transaction_id: dataOf(sale.body).transaction_id,
        lines: [{ product_id: ctx.productId, quantity: 1 }],
        payment_method: "cash",
      });
    expect(created.status).toBe(201);
    const approved = await request(ctx.app)
      .put(`/api/v1/refund-requests/${dataOf(created.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);
  });

  test("control: a suspended sale from another shift is not readable and does not become a sale", async () => {
    const product = await ctx.db.get("SELECT price FROM products WHERE id = ?", [ctx.productId]);
    const stockBefore = await stockOf(ctx.db, ctx.productId);
    const txBefore = await countOf(ctx.db, "SELECT COUNT(*) AS c FROM transactions");
    const held = await request(ctx.app)
      .post("/api/v1/suspended-sales")
      .set(authHeader(cashierToken))
      .send({ items: [{ product_id: ctx.productId, quantity: 1, price: product.price }], note: "معلقة" });
    expect(held.status).toBe(201);
    const heldId = dataOf(held.body).id ?? dataOf(held.body).suspended_sale_id ?? dataOf(held.body).sale?.id;
    expect(heldId).toBeTruthy();
    const foreign = await request(ctx.app)
      .get(`/api/v1/suspended-sales/${heldId}`)
      .set(authHeader(cashier2Token));
    assertDenied(foreign, "other suspended sale");
    expect(await stockOf(ctx.db, ctx.productId)).toBe(stockBefore);
    expect(await countOf(ctx.db, "SELECT COUNT(*) AS c FROM transactions")).toBe(txBefore);
  });
});

describe("permissions audit — admin role bypasses custom permission keys", () => {
  let ctx;
  let adminToken;
  let extraProductId;

  beforeAll(async () => {
    silenceExternalSideEffects();
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    const admin = await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testadmin"]);
    const saved = await request(ctx.app)
      .put(`/api/v1/admin/users/${admin.id}/permissions`)
      .set(authHeader(adminToken))
      .send({ permissions: allAccountantPermissionsDisabled() });
    expect(saved.status).toBe(200);
    expect(dataOf(saved.body).permissions.products).toBe(false);
    expect(dataOf(saved.body).permissions.stock_count).toBe(false);
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock)
       VALUES ('9990002', 'Disposable', 3, 1, 'Test', 7)`
    );
    extraProductId = ins.lastID;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("regression: an admin with products and stock_count off cannot delete a product or zero stock", async () => {
    const list = await request(ctx.app).get("/api/v1/products").set(authHeader(adminToken));
    assertDenied(list, "restricted admin catalog");

    const removed = await request(ctx.app)
      .delete(`/api/v1/admin/products/${extraProductId}`)
      .set(authHeader(adminToken))
      .set("x-confirm-password", "adminpass123");
    assertDenied(removed, "restricted product delete");
    expect(await ctx.db.get("SELECT id FROM products WHERE id = ?", [extraProductId])).toBeTruthy();
    const legacyDelete = await request(ctx.app)
      .delete(`/api/admin/products/${extraProductId}`)
      .set(authHeader(adminToken))
      .set("x-confirm-password", "adminpass123");
    assertDenied(legacyDelete, "legacy restricted product delete");

    const stockBefore = await stockOf(ctx.db, ctx.productId);
    expect(stockBefore).not.toBe(0);
    const zero = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set(authHeader(adminToken))
      .send({});
    assertDenied(zero, "restricted zero stock");
    expect(await stockOf(ctx.db, ctx.productId)).toBe(stockBefore);

    const admin = await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testadmin"]);
    const restored = await request(ctx.app)
      .put(`/api/v1/admin/users/${admin.id}/permissions`)
      .set(authHeader(adminToken))
      .send({
        permissions: {
          ...allAccountantPermissionsDisabled(),
          products: true,
          stock_count: true,
          permissions: true,
          user_accounts: true,
        },
      });
    expect(restored.status).toBe(200);
    const removedOk = await request(ctx.app)
      .delete(`/api/v1/admin/products/${extraProductId}`)
      .set(authHeader(adminToken))
      .set("x-confirm-password", "adminpass123");
    expect(removedOk.status).toBe(204);
    const zeroOk = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set(authHeader(adminToken))
      .send({});
    expect(zeroOk.status).toBe(200);
    expect(await stockOf(ctx.db, ctx.productId)).toBe(0);

    const accountant = await createAccountantUser(ctx.db, {
      username: "allonbutnotadmin",
      password: "allonpass123",
      permissions: allAccountantPermissionsEnabled(),
    });
    const accountantToken = (await login(ctx.app, accountant.username, accountant.password, "office")).body.token;
    const backup = await request(ctx.app).post("/api/v1/admin/backup").set(authHeader(accountantToken));
    assertDenied(backup, "accountant backup");
    const logs = await request(ctx.app).get("/api/v1/admin/audit-logs").set(authHeader(accountantToken));
    assertDenied(logs, "accountant audit logs");
  });
});
