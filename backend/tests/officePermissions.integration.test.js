import request from "supertest";
import {
  authHeader,
  createAccountantUser,
  createTestContext,
  destroyTestContext,
  login,
} from "./helpers.js";
import { updateAppSettings, SETTING_KEYS } from "../utils/settings.js";
import {
  allAccountantPermissionKeys,
  allAccountantPermissionsDisabled,
  allAccountantPermissionsEnabled,
  defaultAccountantPermissions,
  normalizeAccountantPermissions,
} from "../utils/accountantPermissions.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("office permission consistency", () => {
  let ctx;
  let adminToken;
  let allOnToken;
  let templateToken;
  let templateUser;
  let adminUser;

  beforeAll(async () => {
    ctx = await createTestContext();
    expect(allAccountantPermissionKeys()).toHaveLength(35);

    adminUser = await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testadmin"]);
    const allOnUser = await createAccountantUser(ctx.db, {
      username: "allonacct",
      password: "acctpass123",
      permissions: allAccountantPermissionsEnabled(),
    });
    templateUser = await createAccountantUser(ctx.db, {
      username: "templateacct",
      password: "acctpass123",
    });

    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    allOnToken = (await login(ctx.app, allOnUser.username, allOnUser.password, "office")).body.token;
    templateToken = (await login(ctx.app, templateUser.username, templateUser.password, "office")).body
      .token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function setTemplate(overrides) {
    await updateAppSettings(ctx.db, {
      [SETTING_KEYS.accountant_permissions]: {
        ...allAccountantPermissionsDisabled(),
        ...overrides,
      },
    });
  }

  describe("all-on accountant can use every normal feature", () => {
    test("representative GET + write for each of the 35 keys", async () => {
      const hdr = authHeader(allOnToken);

      const today = await request(ctx.app).get("/api/v1/reports/today").set(hdr);
      expect(today.status).toBe(200);

      const productList = await request(ctx.app).get("/api/v1/products").set(hdr);
      expect(productList.status).toBe(200);

      const createdProduct = await request(ctx.app)
        .post("/api/v1/products")
        .set(hdr)
        .send({
          barcode: "8810001001",
          name: "منتج صلاحيات",
          price: 8,
          cost: 3,
          stock: 4,
        });
      expect(createdProduct.status).toBe(201);
      const productId = unwrap(createdProduct.body).id;
      expect(productId).toBeTruthy();

      const overview = await request(ctx.app)
        .get(`/api/v1/products/${productId}/overview`)
        .set(hdr);
      expect(overview.status).toBe(200);

      const orgPatch = await request(ctx.app)
        .put(`/api/v1/products/${ctx.productId}`)
        .set(hdr)
        .send({ unit: "حبة", category: "Test" });
      expect(orgPatch.status).toBe(200);

      const bakeryList = await request(ctx.app).get("/api/v1/products?scope=bakery").set(hdr);
      expect(bakeryList.status).toBe(200);

      const bakeryCreate = await request(ctx.app)
        .post("/api/v1/products")
        .set(hdr)
        .send({
          barcode: "8810001002",
          name: "طحين صلاحيات",
          price: 0,
          cost: 2,
          stock: 6,
          inventory_scope: "bakery",
        });
      expect(bakeryCreate.status).toBe(201);

      const customer = await request(ctx.app)
        .post("/api/v1/customers")
        .set(hdr)
        .send({ name: "عميل صلاحيات الكل" });
      expect(customer.status).toBe(201);
      const customerId = unwrap(customer.body).id;

      const supplier = await request(ctx.app)
        .post("/api/v1/suppliers")
        .set(hdr)
        .send({ name: "مورد صلاحيات الكل" });
      expect(supplier.status).toBe(201);
      const supplierId = unwrap(supplier.body).id;
      const supplierGet = await request(ctx.app).get("/api/v1/suppliers").set(hdr);
      expect(supplierGet.status).toBe(200);

      const units = await request(ctx.app).get("/api/v1/products/units/catalog").set(hdr);
      expect(units.status).toBe(200);

      const category = await request(ctx.app)
        .post("/api/v1/products/categories")
        .set(hdr)
        .send({ name: "تصنيف صلاحيات الكل" });
      expect(category.status).toBe(201);

      const counts = await request(ctx.app).get("/api/v1/inventory/counts").set(hdr);
      expect(counts.status).toBe(200);

      const warehouses = await request(ctx.app).get("/api/v1/warehouses/stock").set(hdr);
      expect(warehouses.status).toBe(200);

      const expiry = await request(ctx.app).get("/api/v1/inventory/expiry").set(hdr);
      expect(expiry.status).toBe(200);
      const lowStock = await request(ctx.app).get("/api/v1/inventory/low-stock").set(hdr);
      expect(lowStock.status).toBe(200);

      const finance = await request(ctx.app)
        .get("/api/v1/finance/overview?from=2026-01-01&to=2026-12-31")
        .set(hdr);
      expect(finance.status).toBe(200);

      const cats = await request(ctx.app).get("/api/v1/expenses/categories").set(hdr);
      expect(cats.status).toBe(200);
      const catRows = unwrap(cats.body);
      const categoryId = Array.isArray(catRows) ? catRows[0]?.id : catRows?.[0]?.id;
      expect(categoryId).toBeTruthy();
      const expense = await request(ctx.app)
        .post("/api/v1/expenses")
        .set(hdr)
        .send({
          category_id: categoryId,
          amount: 15,
          paid_on: "2026-09-08",
          payment_method: "cash",
        });
      expect(expense.status).toBe(201);

      const salesRange = await request(ctx.app)
        .get("/api/v1/reports/range?from=2026-01-01&to=2026-01-07")
        .set(hdr);
      expect(salesRange.status).toBe(200);

      const bakeryReport = await request(ctx.app)
        .get("/api/v1/reports/bakery?from=2026-01-01&to=2026-01-07")
        .set(hdr);
      expect(bakeryReport.status).toBe(200);

      const shifts = await request(ctx.app).get("/api/v1/shifts").set(hdr);
      expect(shifts.status).toBe(200);

      const salesByPrice = await request(ctx.app)
        .get(`/api/v1/reports/products/${ctx.productId}/sales-by-price`)
        .set(hdr);
      expect(salesByPrice.status).toBe(200);

      const bankAccount = await request(ctx.app)
        .post("/api/v1/banks/accounts")
        .set(hdr)
        .send({ name: "حساب صلاحيات", bank_name: "بنك", currency: "NIS" });
      expect(bankAccount.status).toBe(201);
      const bankAccountId = unwrap(bankAccount.body).id;
      const check = await request(ctx.app)
        .post("/api/v1/banks/checks")
        .set(hdr)
        .send({
          check_type: "received",
          amount: 40,
          currency: "NIS",
          due_date: "2026-09-20",
          bank_account_id: bankAccountId,
        });
      expect(check.status).toBe(201);
      const checkStatus = await request(ctx.app)
        .patch(`/api/v1/banks/checks/${unwrap(check.body).id}/status`)
        .set(hdr)
        .send({ status: "cleared" });
      expect(checkStatus.status).toBe(200);

      const statement = await request(ctx.app)
        .get(
          `/api/v1/reports/account-statement?partyType=customer&partyId=${customerId}`
        )
        .set(hdr);
      expect(statement.status).toBe(200);

      const voucher = await request(ctx.app)
        .post("/api/v1/vouchers")
        .set(hdr)
        .send({
          voucher_type: "receipt",
          voucher_date: "2026-09-08",
          lines: [
            {
              line_type: "cash",
              amount: 10,
              currency: "NIS",
              customer_id: customerId,
            },
          ],
        });
      expect(voucher.status).toBe(201);
      const posted = await request(ctx.app)
        .post(`/api/v1/vouchers/${unwrap(voucher.body).id}/post`)
        .set(hdr);
      expect(posted.status).toBe(200);

      const purchaseInvoices = await request(ctx.app).get("/api/v1/purchases/invoices").set(hdr);
      expect(purchaseInvoices.status).toBe(200);
      const purchaseOrders = await request(ctx.app).get("/api/v1/purchases/orders").set(hdr);
      expect(purchaseOrders.status).toBe(200);

      const salesInvoices = await request(ctx.app).get("/api/v1/sales/invoices").set(hdr);
      expect(salesInvoices.status).toBe(200);

      const receipts = await request(ctx.app).get("/api/v1/inventory-receipts").set(hdr);
      expect(receipts.status).toBe(200);
      const issues = await request(ctx.app).get("/api/v1/inventory-issues").set(hdr);
      expect(issues.status).toBe(200);

      const refunds = await request(ctx.app).get("/api/v1/refunds").set(hdr);
      expect(refunds.status).toBe(200);
      const refundPending = await request(ctx.app).get("/api/v1/refund-requests/pending").set(hdr);
      expect(refundPending.status).toBe(200);
      const onAccountPending = await request(ctx.app)
        .get("/api/v1/on-account-requests/pending")
        .set(hdr);
      expect(onAccountPending.status).toBe(200);
      const advancePending = await request(ctx.app)
        .get("/api/v1/advance-requests/pending")
        .set(hdr);
      expect(advancePending.status).toBe(200);

      const marketing = await request(ctx.app).get("/api/v1/marketing/campaigns").set(hdr);
      expect(marketing.status).toBe(200);

      const delivery = await request(ctx.app)
        .post("/api/v1/deliveries/sales")
        .set(hdr)
        .send({ driver: "سائق", notes: "تجربة", delivery_date: "2026-09-08" });
      expect(delivery.status).toBe(201);

      const payroll = await request(ctx.app).get("/api/v1/payroll/cashiers").set(hdr);
      expect(payroll.status).toBe(200);

      const settingsGet = await request(ctx.app).get("/api/v1/settings").set(hdr);
      expect(settingsGet.status).toBe(200);
      const settingsPatch = await request(ctx.app)
        .patch("/api/v1/settings")
        .set(hdr)
        .send({ [SETTING_KEYS.expiry_alert_days]: 11 });
      expect(settingsPatch.status).toBe(200);

      const currencies = await request(ctx.app).get("/api/v1/currencies/all").set(hdr);
      expect(currencies.status).toBe(200);

      const users = await request(ctx.app).get("/api/v1/admin/users").set(hdr);
      expect(users.status).toBe(200);

      const officeAccounts = await request(ctx.app).get("/api/v1/admin/office-accounts").set(hdr);
      expect(officeAccounts.status).toBe(200);
      const accounts = unwrap(officeAccounts.body);
      const accountRows = Array.isArray(accounts) ? accounts : accounts.users || [];
      expect(accountRows.some((row) => row.username === "allonacct")).toBe(true);

      const defaults = await request(ctx.app).get("/api/v1/admin/permission-defaults").set(hdr);
      expect(defaults.status).toBe(200);

      expect(supplierId).toBeTruthy();
    });

    test("B-list actions stay forbidden even with every key on", async () => {
      const hdr = authHeader(allOnToken);

      const del = await request(ctx.app).delete(`/api/v1/admin/products/${ctx.productId}`).set(hdr);
      expect(del.status).toBe(403);

      const zero = await request(ctx.app).post("/api/v1/inventory/zero-all-stock").set(hdr);
      expect(zero.status).toBe(403);

      const before = normalizeAccountantPermissions(
        unwrap((await request(ctx.app).get("/api/v1/admin/permission-defaults").set(hdr)).body)
          .permissions
      );
      const sneak = await request(ctx.app)
        .patch("/api/v1/settings")
        .set(hdr)
        .send({ [SETTING_KEYS.accountant_permissions]: allAccountantPermissionsDisabled() });
      expect(sneak.status).toBe(200);
      const after = normalizeAccountantPermissions(
        unwrap((await request(ctx.app).get("/api/v1/admin/permission-defaults").set(hdr)).body)
          .permissions
      );
      expect(after).toEqual(before);

      const defaultsPut = await request(ctx.app)
        .put("/api/v1/admin/permission-defaults")
        .set(hdr)
        .send({ permissions: allAccountantPermissionsEnabled() });
      expect(defaultsPut.status).toBe(403);

      const createAdmin = await request(ctx.app)
        .post("/api/v1/admin/users")
        .set(hdr)
        .send({ username: "hijackadmin", password: "adminpass456", role: "admin" });
      expect(createAdmin.status).toBe(403);

      const debug = await request(ctx.app).get("/api/v1/debug/barcode/9990001").set(hdr);
      expect(debug.status).toBe(403);

      const telegram = await request(ctx.app).post("/api/v1/telegram/send-expiry-alert").set(hdr);
      expect(telegram.status).toBe(403);
    });
  });

  describe("previously broken writes follow the matching key", () => {
    test("products catalog list", async () => {
      await setTemplate({});
      expect((await request(ctx.app).get("/api/v1/products").set(authHeader(templateToken))).status).toBe(
        403
      );

      await setTemplate({ products: true });
      expect((await request(ctx.app).get("/api/v1/products").set(authHeader(templateToken))).status).toBe(
        200
      );
      expect(
        (await request(ctx.app).get("/api/v1/products?scope=bakery").set(authHeader(templateToken)))
          .status
      ).toBe(403);
    });

    test("product_organization may list and patch unit/category only", async () => {
      await setTemplate({ product_organization: true });
      expect((await request(ctx.app).get("/api/v1/products").set(authHeader(templateToken))).status).toBe(
        200
      );
      const orgOk = await request(ctx.app)
        .put(`/api/v1/products/${ctx.productId}`)
        .set(authHeader(templateToken))
        .send({ unit: "حبة", category: "Test" });
      expect(orgOk.status).toBe(200);
      const orgDenied = await request(ctx.app)
        .put(`/api/v1/products/${ctx.productId}`)
        .set(authHeader(templateToken))
        .send({ name: "لا يسمح", price: 99 });
      expect(orgDenied.status).toBe(403);
      const createDenied = await request(ctx.app)
        .post("/api/v1/products")
        .set(authHeader(templateToken))
        .send({ barcode: "8810001999", name: "ممنوع", price: 1, cost: 1 });
      expect(createDenied.status).toBe(403);
    });

    test("bakery_supplies lists bakery products and cannot open purchase orders", async () => {
      await setTemplate({ bakery_supplies: true });
      expect(
        (await request(ctx.app).get("/api/v1/products?scope=bakery").set(authHeader(templateToken)))
          .status
      ).toBe(200);
      expect((await request(ctx.app).get("/api/v1/products").set(authHeader(templateToken))).status).toBe(
        200
      );
      expect(
        (await request(ctx.app).get("/api/v1/purchases/invoices").set(authHeader(templateToken))).status
      ).toBe(200);
      expect(
        (await request(ctx.app).get("/api/v1/purchases/orders").set(authHeader(templateToken))).status
      ).toBe(403);
      expect(
        (await request(ctx.app).get("/api/v1/purchases/returns").set(authHeader(templateToken))).status
      ).toBe(403);
      expect((await request(ctx.app).get("/api/v1/suppliers").set(authHeader(templateToken))).status).toBe(
        200
      );
      expect(
        (await request(ctx.app).get("/api/v1/inventory/low-stock").set(authHeader(templateToken))).status
      ).toBe(200);
    });

    test("bakery report is denied until the bakery permission is granted", async () => {
      await setTemplate({ bakery: false, bakery_supplies: false, sales_reports: true });
      expect(
        (
          await request(ctx.app)
            .get("/api/v1/reports/bakery?from=2026-01-01&to=2026-01-07")
            .set(authHeader(templateToken))
        ).status
      ).toBe(403);
      await setTemplate({ bakery: false, bakery_supplies: true });
      expect(
        (
          await request(ctx.app)
            .get("/api/v1/reports/bakery?from=2026-01-01&to=2026-01-07")
            .set(authHeader(templateToken))
        ).status
      ).toBe(200);
      expect(
        (
          await request(ctx.app)
            .put("/api/v1/reports/bakery/categories")
            .set(authHeader(templateToken))
            .send({ category_ids: [1] })
        ).status
      ).toBe(403);
      await setTemplate({ bakery: true });
      expect(
        (
          await request(ctx.app)
            .get("/api/v1/reports/bakery?from=2026-01-01&to=2026-01-07")
            .set(authHeader(templateToken))
        ).status
      ).toBe(200);
    });

    test("expenses POST", async () => {
      const cat = await ctx.db.get("SELECT id FROM expense_categories ORDER BY id LIMIT 1");
      const body = {
        category_id: cat.id,
        amount: 9,
        paid_on: "2026-09-08",
        payment_method: "cash",
      };
      await setTemplate({ expenses: false });
      expect(
        (await request(ctx.app).post("/api/v1/expenses").set(authHeader(templateToken)).send(body))
          .status
      ).toBe(403);
      await setTemplate({ expenses: true });
      expect(
        (await request(ctx.app).post("/api/v1/expenses").set(authHeader(templateToken)).send(body))
          .status
      ).toBe(201);
    });

    test("banks account write", async () => {
      await setTemplate({ banks: false });
      expect(
        (
          await request(ctx.app)
            .post("/api/v1/banks/accounts")
            .set(authHeader(templateToken))
            .send({ name: "مغلق" })
        ).status
      ).toBe(403);
      await setTemplate({ banks: true });
      expect(
        (
          await request(ctx.app)
            .post("/api/v1/banks/accounts")
            .set(authHeader(templateToken))
            .send({ name: "حساب مفتاح" })
        ).status
      ).toBe(201);
    });

    test("deliveries POST", async () => {
      await setTemplate({ deliveries: false });
      expect(
        (
          await request(ctx.app)
            .post("/api/v1/deliveries/sales")
            .set(authHeader(templateToken))
            .send({ driver: "سائق" })
        ).status
      ).toBe(403);
      await setTemplate({ deliveries: true });
      expect(
        (
          await request(ctx.app)
            .post("/api/v1/deliveries/sales")
            .set(authHeader(templateToken))
            .send({ driver: "سائق" })
        ).status
      ).toBe(201);
    });

    test("voucher post", async () => {
      const custIns = await ctx.db.run(
        "INSERT INTO customers (name) VALUES ('زبون ترحيل سند')"
      );
      const draft = await request(ctx.app)
        .post("/api/v1/vouchers")
        .set(authHeader(adminToken))
        .send({
          voucher_type: "receipt",
          voucher_date: "2026-09-08",
          lines: [
            {
              line_type: "cash",
              amount: 7,
              currency: "NIS",
              customer_id: custIns.lastID,
            },
          ],
        });
      expect(draft.status).toBe(201);
      const voucherId = unwrap(draft.body).id;

      await setTemplate({ vouchers: false });
      expect(
        (
          await request(ctx.app)
            .post(`/api/v1/vouchers/${voucherId}/post`)
            .set(authHeader(templateToken))
        ).status
      ).toBe(403);

      await setTemplate({ vouchers: true });
      expect(
        (
          await request(ctx.app)
            .post(`/api/v1/vouchers/${voucherId}/post`)
            .set(authHeader(templateToken))
        ).status
      ).toBe(200);
    });
  });

  describe("template / custom / reset", () => {
    test("no custom follows the global template; custom wins; reset is immediate", async () => {
      const modeUser = await createAccountantUser(ctx.db, {
        username: "modetoggle",
        password: "acctpass123",
      });
      const token = (await login(ctx.app, modeUser.username, modeUser.password, "office")).body.token;
      const hdr = authHeader(token);
      const cat = await ctx.db.get("SELECT id FROM expense_categories ORDER BY id LIMIT 1");
      const expenseBody = {
        category_id: cat.id,
        amount: 6,
        paid_on: "2026-09-08",
        payment_method: "cash",
      };

      const defaultsPut = await request(ctx.app)
        .put("/api/v1/admin/permission-defaults")
        .set(authHeader(adminToken))
        .send({
          permissions: {
            ...allAccountantPermissionsDisabled(),
            finance: true,
            expenses: false,
          },
        });
      expect(defaultsPut.status).toBe(200);

      const meTemplate = unwrap(
        (await request(ctx.app).get("/api/v1/auth/me").set(hdr)).body
      ).user;
      expect(meTemplate.permissions.finance).toBe(true);
      expect(meTemplate.permissions.expenses).toBe(false);
      expect(
        (
          await request(ctx.app)
            .get("/api/v1/finance/overview?from=2026-01-01&to=2026-01-31")
            .set(hdr)
        ).status
      ).toBe(200);
      expect(
        (await request(ctx.app).post("/api/v1/expenses").set(hdr).send(expenseBody)).status
      ).toBe(403);

      const customPut = await request(ctx.app)
        .put(`/api/v1/admin/users/${modeUser.id}/permissions`)
        .set(authHeader(adminToken))
        .send({
          permissions: {
            ...allAccountantPermissionsDisabled(),
            finance: false,
            expenses: true,
          },
        });
      expect(customPut.status).toBe(200);

      const meCustom = unwrap((await request(ctx.app).get("/api/v1/auth/me").set(hdr)).body).user;
      expect(meCustom.permissions.finance).toBe(false);
      expect(meCustom.permissions.expenses).toBe(true);
      expect(
        (
          await request(ctx.app)
            .get("/api/v1/finance/overview?from=2026-01-01&to=2026-01-31")
            .set(hdr)
        ).status
      ).toBe(403);
      expect(
        (await request(ctx.app).post("/api/v1/expenses").set(hdr).send(expenseBody)).status
      ).toBe(201);

      const reset = await request(ctx.app)
        .put(`/api/v1/admin/users/${modeUser.id}/permissions`)
        .set(authHeader(adminToken))
        .send({ permissions: null });
      expect(reset.status).toBe(200);
      expect(unwrap(reset.body).custom).toBe(false);

      const meReset = unwrap((await request(ctx.app).get("/api/v1/auth/me").set(hdr)).body).user;
      expect(meReset.permissions.finance).toBe(true);
      expect(meReset.permissions.expenses).toBe(false);
      expect(
        (
          await request(ctx.app)
            .get("/api/v1/finance/overview?from=2026-01-01&to=2026-01-31")
            .set(hdr)
        ).status
      ).toBe(200);
      expect(
        (await request(ctx.app).post("/api/v1/expenses").set(hdr).send(expenseBody)).status
      ).toBe(403);
    });
  });

  describe("admin custom map", () => {
    test("disabled finance 403s; permissions and user_accounts stay forced on", async () => {
      const put = await request(ctx.app)
        .put(`/api/v1/admin/users/${adminUser.id}/permissions`)
        .set(authHeader(adminToken))
        .send({
          permissions: {
            ...allAccountantPermissionsEnabled(),
            finance: false,
            permissions: false,
            user_accounts: false,
          },
        });
      expect(put.status).toBe(200);
      const body = unwrap(put.body);
      expect(body.custom).toBe(true);
      expect(body.permissions.finance).toBe(false);
      expect(body.permissions.permissions).toBe(true);
      expect(body.permissions.user_accounts).toBe(true);

      expect(
        (
          await request(ctx.app)
            .get("/api/v1/finance/overview?from=2026-01-01&to=2026-01-31")
            .set(authHeader(adminToken))
        ).status
      ).toBe(403);
      expect(
        (await request(ctx.app).get("/api/v1/admin/users").set(authHeader(adminToken))).status
      ).toBe(200);
      expect(
        (await request(ctx.app).get("/api/v1/admin/permission-defaults").set(authHeader(adminToken)))
          .status
      ).toBe(200);

      const reset = await request(ctx.app)
        .put(`/api/v1/admin/users/${adminUser.id}/permissions`)
        .set(authHeader(adminToken))
        .send({ permissions: null });
      expect(reset.status).toBe(200);
      expect(
        (
          await request(ctx.app)
            .get("/api/v1/finance/overview?from=2026-01-01&to=2026-01-31")
            .set(authHeader(adminToken))
        ).status
      ).toBe(200);
    });
  });
});
