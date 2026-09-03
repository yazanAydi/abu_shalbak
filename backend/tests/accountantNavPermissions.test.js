import request from "supertest";
import bcrypt from "bcrypt";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { updateAppSettings, getAppSettings, SETTING_KEYS } from "../utils/settings.js";
import {
  allAccountantPermissionsDisabled,
  allAccountantPermissionsEnabled,
  defaultAccountantPermissions,
  normalizeAccountantPermissions,
} from "../utils/accountantPermissions.js";

/**
 * Navigation-level accountant permissions: every grantable nav item must be
 * enforced by the API, not only hidden in the sidebar.
 */
describe("nav-level accountant permissions", () => {
  let ctx;
  let adminToken;
  let accountantToken;
  let cashierToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    const hash = await bcrypt.hash("acctpass123", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'accountant', 0)",
      ["testaccountant", hash]
    );
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    accountantToken = (await login(ctx.app, "testaccountant", "acctpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function setPermissions(overrides) {
    await updateAppSettings(ctx.db, {
      [SETTING_KEYS.accountant_permissions]: {
        ...allAccountantPermissionsDisabled(),
        ...overrides,
      },
    });
  }

  /** Office-only reads that each page cannot work without. */
  const NAV_READS = [
    { key: "products", path: "/api/v1/products/next-sku" },
    { key: "units", path: "/api/v1/products/units/catalog" },
    { key: "stock_count", path: "/api/v1/inventory/counts" },
    { key: "warehouses", path: "/api/v1/warehouses/stock" },
    { key: "purchases", path: "/api/v1/purchases/invoices" },
    { key: "sales_invoices", path: "/api/v1/sales/invoices" },
    { key: "inventory_receipts", path: "/api/v1/inventory-receipts" },
    { key: "inventory_issues", path: "/api/v1/inventory-issues" },
    { key: "marketing", path: "/api/v1/marketing/campaigns" },
    { key: "currencies", path: "/api/v1/currencies/all" },
    { key: "user_accounts", path: "/api/v1/admin/users" },
  ];

  /** Writes for pages whose plain list read is shared with the POS. */
  const NAV_WRITES = [
    { key: "customers", path: "/api/v1/customers", body: { name: "عميل صلاحيات" } },
    { key: "suppliers", path: "/api/v1/suppliers", body: { name: "مورد صلاحيات" } },
    { key: "categories", path: "/api/v1/products/categories", body: { name: "تصنيف صلاحيات" } },
  ];

  test.each(NAV_READS)("accountant without $key is refused by $path", async ({ key, path }) => {
    await setPermissions({ [key]: false });
    const res = await request(ctx.app).get(path).set(authHeader(accountantToken));
    expect(res.status).toBe(403);
  });

  test.each(NAV_READS)("accountant with $key may call $path", async ({ key, path }) => {
    await setPermissions({ [key]: true });
    const res = await request(ctx.app).get(path).set(authHeader(accountantToken));
    expect(res.status).toBe(200);
  });

  test.each(NAV_READS)("admin keeps access to $path with every permission off", async ({ path }) => {
    await setPermissions({});
    const res = await request(ctx.app).get(path).set(authHeader(adminToken));
    expect(res.status).toBe(200);
  });

  test.each(NAV_READS)("cashier never reaches $path", async ({ path }) => {
    await setPermissions(allAccountantPermissionsEnabled());
    const res = await request(ctx.app).get(path).set(authHeader(cashierToken));
    expect(res.status).toBe(403);
  });

  test.each(NAV_WRITES)("$path is writable only with the $key permission", async ({ key, path, body }) => {
    await setPermissions({ [key]: false });
    const denied = await request(ctx.app)
      .post(path)
      .set(authHeader(accountantToken))
      .send(body);
    expect(denied.status).toBe(403);

    const cashier = await request(ctx.app).post(path).set(authHeader(cashierToken)).send(body);
    expect(cashier.status).toBe(403);

    await setPermissions({ [key]: true });
    const allowed = await request(ctx.app)
      .post(path)
      .set(authHeader(accountantToken))
      .send(body);
    expect(allowed.status).toBe(201);
  });

  test("legacy saved maps keep granting the pages accountants already had", async () => {
    // A store saved before nav permissions existed.
    await updateAppSettings(ctx.db, {
      [SETTING_KEYS.accountant_permissions]: {
        dashboard: true,
        finance: true,
        expenses: true,
      },
    });

    const finance = await request(ctx.app)
      .get("/api/v1/finance/overview?from=2026-01-01&to=2026-01-31")
      .set(authHeader(accountantToken));
    expect(finance.status).toBe(200);

    // …but the newly introduced pages stay closed until an admin grants them.
    const products = await request(ctx.app)
      .get("/api/v1/products/next-sku")
      .set(authHeader(accountantToken));
    expect(products.status).toBe(403);
  });

  test("unknown keys in the saved map never become grants", async () => {
    await updateAppSettings(ctx.db, {
      [SETTING_KEYS.accountant_permissions]: {
        ...allAccountantPermissionsDisabled(),
        "*": true,
        admin: true,
        products_all: true,
      },
    });
    const settings = await getAppSettings(ctx.db);
    const saved = normalizeAccountantPermissions(settings.accountant_permissions);
    expect(saved["*"]).toBeUndefined();
    expect(saved.products_all).toBeUndefined();

    const res = await request(ctx.app)
      .get("/api/v1/products/next-sku")
      .set(authHeader(accountantToken));
    expect(res.status).toBe(403);
  });
});

describe("admin-only surfaces stay admin-only", () => {
  let ctx;
  let adminToken;
  let accountantToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    const hash = await bcrypt.hash("acctpass123", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'accountant', 0)",
      ["testaccountant", hash]
    );
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    accountantToken = (await login(ctx.app, "testaccountant", "acctpass123", "office")).body.token;
    // Worst case: the admin granted the accountant everything.
    await updateAppSettings(ctx.db, {
      [SETTING_KEYS.accountant_permissions]: allAccountantPermissionsEnabled(),
    });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  const ADMIN_ONLY = [
    { label: "product deletion", method: "delete", path: "/api/v1/admin/products/1" },
    { label: "bulk product deletion", method: "post", path: "/api/v1/admin/products/bulk-delete" },
    { label: "SKU renumbering", method: "post", path: "/api/v1/admin/renumber-entity-codes" },
    { label: "backups", method: "post", path: "/api/v1/admin/backup" },
    { label: "audit logs", method: "get", path: "/api/v1/admin/audit-logs" },
    { label: "supplier balance import", method: "post", path: "/api/v1/admin/import/supplier-balances/preview" },
    { label: "product delete password", method: "put", path: "/api/v1/admin/product-delete-password" },
  ];

  test.each(ADMIN_ONLY)("$label is refused for an accountant", async ({ method, path }) => {
    const res = await request(ctx.app)[method](path).set(authHeader(accountantToken)).send({});
    expect(res.status).toBe(403);
  });

  test("an accountant with user_accounts cannot touch admin accounts", async () => {
    const list = await request(ctx.app).get("/api/v1/admin/users").set(authHeader(accountantToken));
    expect(list.status).toBe(200);
    const users = list.body.data ?? list.body;
    const rows = Array.isArray(users) ? users : users.users || [];
    const admin = rows.find((u) => u.role === "admin");
    expect(admin).toBeTruthy();

    const created = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(accountantToken))
      .send({ username: "newadmin", password: "adminpass456", role: "admin" });
    expect(created.status).toBe(403);

    const patched = await request(ctx.app)
      .patch(`/api/v1/admin/users/${admin.id}`)
      .set(authHeader(accountantToken))
      .send({ password: "hijacked123" });
    expect(patched.status).toBe(403);

    const removed = await request(ctx.app)
      .delete(`/api/v1/admin/users/${admin.id}`)
      .set(authHeader(accountantToken));
    expect(removed.status).toBe(403);

    // A non-admin account is still manageable.
    const cashier = await request(ctx.app)
      .post("/api/v1/admin/users")
      .set(authHeader(accountantToken))
      .send({ username: "newcashier", password: "cashpass456", role: "cashier" });
    expect(cashier.status).toBe(201);
  });

  test("only an admin can rewrite the accountant permission map", async () => {
    const attempt = await request(ctx.app)
      .patch("/api/v1/settings")
      .set(authHeader(accountantToken))
      .send({
        [SETTING_KEYS.expiry_alert_days]: 12,
        [SETTING_KEYS.accountant_permissions]: allAccountantPermissionsEnabled(),
      });
    expect(attempt.status).toBe(200);

    const settings = await getAppSettings(ctx.db);
    const stored = normalizeAccountantPermissions(settings.accountant_permissions);
    // The store field the accountant may edit went through…
    expect(Number(settings.expiry_alert_days)).toBe(12);
    // …and the permission map is untouched by design (still fully granted here).
    expect(stored).toEqual(allAccountantPermissionsEnabled());

    // Now lock the map down as admin and prove the accountant cannot re-open it.
    await updateAppSettings(ctx.db, {
      [SETTING_KEYS.accountant_permissions]: {
        ...allAccountantPermissionsDisabled(),
        store_settings: true,
      },
    });
    const escalate = await request(ctx.app)
      .patch("/api/v1/settings")
      .set(authHeader(accountantToken))
      .send({ [SETTING_KEYS.accountant_permissions]: allAccountantPermissionsEnabled() });
    expect(escalate.status).toBe(200);

    const after = normalizeAccountantPermissions(
      (await getAppSettings(ctx.db)).accountant_permissions
    );
    expect(after.suppliers).toBe(false);
    expect(after.user_accounts).toBe(false);

    const stillBlocked = await request(ctx.app)
      .get("/api/v1/suppliers")
      .set(authHeader(accountantToken));
    expect(stillBlocked.status).toBe(403);
  });

  test("an accountant without store_settings cannot patch settings at all", async () => {
    await updateAppSettings(ctx.db, {
      [SETTING_KEYS.accountant_permissions]: allAccountantPermissionsDisabled(),
    });
    const res = await request(ctx.app)
      .patch("/api/v1/settings")
      .set(authHeader(accountantToken))
      .send({ [SETTING_KEYS.expiry_alert_days]: 20 });
    expect(res.status).toBe(403);

    const adminRes = await request(ctx.app)
      .patch("/api/v1/settings")
      .set(authHeader(adminToken))
      .send({ [SETTING_KEYS.expiry_alert_days]: 20 });
    expect(adminRes.status).toBe(200);
  });

  test("changing accountant permissions leaves defaults and cashier behaviour alone", async () => {
    await updateAppSettings(ctx.db, {
      [SETTING_KEYS.accountant_permissions]: allAccountantPermissionsDisabled(),
    });
    const cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;

    const pos = await request(ctx.app)
      .get("/api/v1/marketing/active")
      .set(authHeader(cashierToken));
    expect(pos.status).toBe(200);

    const lookup = await request(ctx.app)
      .get("/api/v1/products/by-barcode/9990001")
      .set(authHeader(cashierToken));
    expect(lookup.status).toBe(200);

    // Catalog defaults are unaffected by whatever is stored.
    expect(defaultAccountantPermissions().dashboard).toBe(true);
    expect(defaultAccountantPermissions().suppliers).toBe(false);
  });
});
