import request from "supertest";
import bcrypt from "bcrypt";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import {
  getAppSettings,
  getZeroAllStockPasswordHash,
  clearZeroAllStockPassword,
} from "../utils/settings.js";

function settingsBody(res) {
  return res.body.data ?? res.body;
}

describe("Zero-all-stock password", () => {
  let ctx;
  let adminToken;
  let cashierToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  afterEach(async () => {
    await clearZeroAllStockPassword(ctx.db);
    await ctx.db.run("UPDATE products SET stock = 100 WHERE id = ?", [ctx.productId]);
  });

  test("GET settings exposes a boolean and never the hash", async () => {
    const empty = await request(ctx.app).get("/api/v1/settings").set(authHeader(adminToken));
    expect(empty.status).toBe(200);
    const emptyBody = settingsBody(empty);
    expect(emptyBody.zero_all_stock_password_set).toBe(false);
    expect(emptyBody.zero_all_stock_password).toBeUndefined();

    const put = await request(ctx.app)
      .put("/api/v1/admin/zero-all-stock-password")
      .set(authHeader(adminToken))
      .send({ password: "zeropass" });
    expect(put.status).toBe(200);
    expect(settingsBody(put).zero_all_stock_password_set).toBe(true);

    const loaded = await request(ctx.app).get("/api/v1/settings").set(authHeader(adminToken));
    expect(loaded.status).toBe(200);
    const body = settingsBody(loaded);
    expect(body.zero_all_stock_password_set).toBe(true);
    expect(body.zero_all_stock_password).toBeUndefined();
    expect(JSON.stringify(loaded.body)).not.toMatch(/\$2[aby]\$/);

    const hash = await getZeroAllStockPasswordHash(ctx.db);
    expect(hash).toBeTruthy();
    expect(await bcrypt.compare("zeropass", hash)).toBe(true);

    const fromHelper = await getAppSettings(ctx.db);
    expect(fromHelper.zero_all_stock_password_set).toBe(true);
    expect(fromHelper.zero_all_stock_password).toBeUndefined();
  });

  test("PATCH /settings cannot write the zero-all password", async () => {
    const patch = await request(ctx.app)
      .patch("/api/v1/settings")
      .set(authHeader(adminToken))
      .send({ zero_all_stock_password: "hacked1", zero_all_stock_password_set: true });
    expect(patch.status).toBe(200);
    const body = settingsBody(patch);
    expect(body.zero_all_stock_password_set).toBe(false);
    expect(body.zero_all_stock_password).toBeUndefined();
    expect(await getZeroAllStockPasswordHash(ctx.db)).toBeNull();
  });

  test("PUT rejects short passwords and cashiers", async () => {
    const short = await request(ctx.app)
      .put("/api/v1/admin/zero-all-stock-password")
      .set(authHeader(adminToken))
      .send({ password: "12345" });
    expect(short.status).toBe(400);

    const cashier = await request(ctx.app)
      .put("/api/v1/admin/zero-all-stock-password")
      .set(authHeader(cashierToken))
      .send({ password: "zeropass" });
    expect(cashier.status).toBe(403);
  });

  test("zero-all works without a password when unset and requires the dedicated password when set", async () => {
    const unsetOk = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set(authHeader(adminToken));
    expect(unsetOk.status).toBe(200);

    await ctx.db.run("UPDATE products SET stock = 50 WHERE id = ?", [ctx.productId]);

    const setRes = await request(ctx.app)
      .put("/api/v1/admin/zero-all-stock-password")
      .set(authHeader(adminToken))
      .send({ password: "zeropass" });
    expect(setRes.status).toBe(200);

    const missing = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set(authHeader(adminToken));
    expect(missing.status).toBe(403);

    const adminRejected = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set({ ...authHeader(adminToken), "X-Confirm-Password": "adminpass123" });
    expect(adminRejected.status).toBe(403);

    const dedicatedOk = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set({ ...authHeader(adminToken), "X-Confirm-Password": "zeropass" });
    expect(dedicatedOk.status).toBe(200);
    const body = dedicatedOk.body.data ?? dedicatedOk.body;
    expect(body.products_zeroed).toBeGreaterThanOrEqual(1);
  });

  test("changing the dedicated password replaces the previous one", async () => {
    await request(ctx.app)
      .put("/api/v1/admin/zero-all-stock-password")
      .set(authHeader(adminToken))
      .send({ password: "oldpass1" });
    const changed = await request(ctx.app)
      .put("/api/v1/admin/zero-all-stock-password")
      .set(authHeader(adminToken))
      .send({ password: "newpass1" });
    expect(changed.status).toBe(200);

    const oldRejected = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set({ ...authHeader(adminToken), "X-Confirm-Password": "oldpass1" });
    expect(oldRejected.status).toBe(403);

    const newOk = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set({ ...authHeader(adminToken), "X-Confirm-Password": "newpass1" });
    expect(newOk.status).toBe(200);
  });

  test("clearing the dedicated password restores confirm-only zero-all", async () => {
    await request(ctx.app)
      .put("/api/v1/admin/zero-all-stock-password")
      .set(authHeader(adminToken))
      .send({ password: "zeropass" });

    const cleared = await request(ctx.app)
      .delete("/api/v1/admin/zero-all-stock-password")
      .set(authHeader(adminToken));
    expect(cleared.status).toBe(200);
    expect(settingsBody(cleared).zero_all_stock_password_set).toBe(false);
    expect(await getZeroAllStockPasswordHash(ctx.db)).toBeNull();

    const dedicatedRejected = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set({ ...authHeader(adminToken), "X-Confirm-Password": "zeropass" });
    expect(dedicatedRejected.status).toBe(200);

    await ctx.db.run("UPDATE products SET stock = 25 WHERE id = ?", [ctx.productId]);
    const confirmOnly = await request(ctx.app)
      .post("/api/v1/inventory/zero-all-stock")
      .set(authHeader(adminToken));
    expect(confirmOnly.status).toBe(200);
  });

  test("audit logs record set/clear without the password or hash", async () => {
    await request(ctx.app)
      .put("/api/v1/admin/zero-all-stock-password")
      .set(authHeader(adminToken))
      .send({ password: "zeropass" });
    await request(ctx.app)
      .delete("/api/v1/admin/zero-all-stock-password")
      .set(authHeader(adminToken));

    const logs = await ctx.db.all(
      `SELECT action, old_value, new_value FROM audit_logs
       WHERE action IN ('ZERO_ALL_STOCK_PASSWORD_SET', 'ZERO_ALL_STOCK_PASSWORD_CLEARED')
       ORDER BY id`
    );
    expect(logs.length).toBeGreaterThanOrEqual(2);
    const dumped = JSON.stringify(logs);
    expect(dumped).not.toContain("zeropass");
    expect(dumped).not.toMatch(/\$2[aby]\$/);
    expect(dumped).toContain("ZERO_ALL_STOCK_PASSWORD_SET");
    expect(dumped).toContain("ZERO_ALL_STOCK_PASSWORD_CLEARED");
  });
});
