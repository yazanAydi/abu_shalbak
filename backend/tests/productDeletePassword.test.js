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
  getProductDeletePasswordHash,
  clearProductDeletePassword,
} from "../utils/settings.js";

function settingsBody(res) {
  return res.body.data ?? res.body;
}

async function createProduct(app, token, barcode, name) {
  const created = await request(app)
    .post("/api/v1/products")
    .set(authHeader(token))
    .send({ barcode, name, price: 3, stock: 1 });
  expect(created.status).toBe(201);
  return created.body.data?.id ?? created.body.id;
}

describe("Product deletion password", () => {
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
    await clearProductDeletePassword(ctx.db);
  });

  test("GET settings exposes a boolean and never the hash", async () => {
    const empty = await request(ctx.app).get("/api/v1/settings").set(authHeader(adminToken));
    expect(empty.status).toBe(200);
    const emptyBody = settingsBody(empty);
    expect(emptyBody.product_delete_password_set).toBe(false);
    expect(emptyBody.product_delete_password).toBeUndefined();

    const put = await request(ctx.app)
      .put("/api/v1/admin/product-delete-password")
      .set(authHeader(adminToken))
      .send({ password: "deletepass" });
    expect(put.status).toBe(200);
    expect(settingsBody(put).product_delete_password_set).toBe(true);

    const loaded = await request(ctx.app).get("/api/v1/settings").set(authHeader(adminToken));
    expect(loaded.status).toBe(200);
    const body = settingsBody(loaded);
    expect(body.product_delete_password_set).toBe(true);
    expect(body.product_delete_password).toBeUndefined();
    expect(JSON.stringify(loaded.body)).not.toMatch(/\$2[aby]\$/);

    const hash = await getProductDeletePasswordHash(ctx.db);
    expect(hash).toBeTruthy();
    expect(await bcrypt.compare("deletepass", hash)).toBe(true);

    const fromHelper = await getAppSettings(ctx.db);
    expect(fromHelper.product_delete_password_set).toBe(true);
    expect(fromHelper.product_delete_password).toBeUndefined();
  });

  test("PATCH /settings cannot write the deletion password", async () => {
    const patch = await request(ctx.app)
      .patch("/api/v1/settings")
      .set(authHeader(adminToken))
      .send({ product_delete_password: "hacked1", product_delete_password_set: true });
    expect(patch.status).toBe(200);
    const body = settingsBody(patch);
    expect(body.product_delete_password_set).toBe(false);
    expect(body.product_delete_password).toBeUndefined();
    expect(await getProductDeletePasswordHash(ctx.db)).toBeNull();
  });

  test("PUT rejects short passwords and cashiers", async () => {
    const short = await request(ctx.app)
      .put("/api/v1/admin/product-delete-password")
      .set(authHeader(adminToken))
      .send({ password: "12345" });
    expect(short.status).toBe(400);

    const cashier = await request(ctx.app)
      .put("/api/v1/admin/product-delete-password")
      .set(authHeader(cashierToken))
      .send({ password: "deletepass" });
    expect(cashier.status).toBe(403);
  });

  test("product delete uses admin password when unset and the dedicated password when set", async () => {
    const unsetId = await createProduct(ctx.app, adminToken, "8887776665501", "Unset Gate");
    const deniedUnset = await request(ctx.app)
      .delete(`/api/v1/admin/products/${unsetId}`)
      .set(authHeader(adminToken));
    expect(deniedUnset.status).toBe(403);

    const okUnset = await request(ctx.app)
      .delete(`/api/v1/admin/products/${unsetId}`)
      .set({ ...authHeader(adminToken), "X-Confirm-Password": "adminpass123" });
    expect(okUnset.status).toBe(204);

    const setRes = await request(ctx.app)
      .put("/api/v1/admin/product-delete-password")
      .set(authHeader(adminToken))
      .send({ password: "deletepass" });
    expect(setRes.status).toBe(200);

    const setId = await createProduct(ctx.app, adminToken, "8887776665502", "Set Gate");
    const adminRejected = await request(ctx.app)
      .delete(`/api/v1/admin/products/${setId}`)
      .set({ ...authHeader(adminToken), "X-Confirm-Password": "adminpass123" });
    expect(adminRejected.status).toBe(403);

    const dedicatedOk = await request(ctx.app)
      .delete(`/api/v1/admin/products/${setId}`)
      .set({ ...authHeader(adminToken), "X-Confirm-Password": "deletepass" });
    expect(dedicatedOk.status).toBe(204);
  });

  test("changing the dedicated password replaces the previous one", async () => {
    await request(ctx.app)
      .put("/api/v1/admin/product-delete-password")
      .set(authHeader(adminToken))
      .send({ password: "oldpass1" });
    const changed = await request(ctx.app)
      .put("/api/v1/admin/product-delete-password")
      .set(authHeader(adminToken))
      .send({ password: "newpass1" });
    expect(changed.status).toBe(200);

    const id = await createProduct(ctx.app, adminToken, "8887776665504", "Changed Gate");
    const oldRejected = await request(ctx.app)
      .delete(`/api/v1/admin/products/${id}`)
      .set({ ...authHeader(adminToken), "X-Confirm-Password": "oldpass1" });
    expect(oldRejected.status).toBe(403);

    const newOk = await request(ctx.app)
      .delete(`/api/v1/admin/products/${id}`)
      .set({ ...authHeader(adminToken), "X-Confirm-Password": "newpass1" });
    expect(newOk.status).toBe(204);
  });

  test("clearing the dedicated password restores the admin login gate", async () => {
    await request(ctx.app)
      .put("/api/v1/admin/product-delete-password")
      .set(authHeader(adminToken))
      .send({ password: "deletepass" });

    const cleared = await request(ctx.app)
      .delete("/api/v1/admin/product-delete-password")
      .set(authHeader(adminToken));
    expect(cleared.status).toBe(200);
    expect(settingsBody(cleared).product_delete_password_set).toBe(false);
    expect(await getProductDeletePasswordHash(ctx.db)).toBeNull();

    const id = await createProduct(ctx.app, adminToken, "8887776665503", "Cleared Gate");
    const dedicatedRejected = await request(ctx.app)
      .delete(`/api/v1/admin/products/${id}`)
      .set({ ...authHeader(adminToken), "X-Confirm-Password": "deletepass" });
    expect(dedicatedRejected.status).toBe(403);

    const adminOk = await request(ctx.app)
      .delete(`/api/v1/admin/products/${id}`)
      .set({ ...authHeader(adminToken), "X-Confirm-Password": "adminpass123" });
    expect(adminOk.status).toBe(204);
  });

  test("audit logs record set/clear without the password or hash", async () => {
    await request(ctx.app)
      .put("/api/v1/admin/product-delete-password")
      .set(authHeader(adminToken))
      .send({ password: "deletepass" });
    await request(ctx.app)
      .delete("/api/v1/admin/product-delete-password")
      .set(authHeader(adminToken));

    const logs = await ctx.db.all(
      `SELECT action, old_value, new_value FROM audit_logs
       WHERE action IN ('PRODUCT_DELETE_PASSWORD_SET', 'PRODUCT_DELETE_PASSWORD_CLEARED')
       ORDER BY id`
    );
    expect(logs.length).toBeGreaterThanOrEqual(2);
    const dumped = JSON.stringify(logs);
    expect(dumped).not.toContain("deletepass");
    expect(dumped).not.toMatch(/\$2[aby]\$/);
    expect(dumped).toContain("PRODUCT_DELETE_PASSWORD_SET");
    expect(dumped).toContain("PRODUCT_DELETE_PASSWORD_CLEARED");
  });
});
