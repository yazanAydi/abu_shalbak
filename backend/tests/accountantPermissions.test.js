import request from "supertest";
import bcrypt from "bcrypt";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { updateAppSettings } from "../utils/settings.js";
import { SETTING_KEYS } from "../utils/settings.js";
import {
  defaultAccountantPermissions,
  normalizeAccountantPermissions,
} from "../utils/accountantPermissions.js";

describe("Accountant permissions", () => {
  let ctx;
  let adminToken;
  let accountantToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    const accountantHash = await bcrypt.hash("acctpass123", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, ?, 0)",
      ["testaccountant", accountantHash, "accountant"]
    );

    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    const accountantLogin = await login(ctx.app, "testaccountant", "acctpass123");
    adminToken = adminLogin.body.token;
    accountantToken = accountantLogin.body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("settings round-trip for accountant_permissions", async () => {
    const patch = {
      ...defaultAccountantPermissions(),
      finance: false,
      dashboard: true,
    };

    const saveRes = await request(ctx.app)
      .patch("/api/v1/settings")
      .set(authHeader(adminToken))
      .send({ [SETTING_KEYS.accountant_permissions]: patch });
    expect(saveRes.status).toBe(200);
    const saved = saveRes.body.data ?? saveRes.body;
    expect(normalizeAccountantPermissions(saved.accountant_permissions).finance).toBe(false);
    expect(normalizeAccountantPermissions(saved.accountant_permissions).dashboard).toBe(true);

    const getRes = await request(ctx.app)
      .get("/api/v1/settings")
      .set(authHeader(adminToken));
    expect(getRes.status).toBe(200);
    const loaded = getRes.body.data ?? getRes.body;
    expect(normalizeAccountantPermissions(loaded.accountant_permissions).finance).toBe(false);
  });

  test("accountant without finance permission gets 403 on finance API", async () => {
    await updateAppSettings(ctx.db, {
      [SETTING_KEYS.accountant_permissions]: {
        ...defaultAccountantPermissions(),
        finance: false,
      },
    });

    const res = await request(ctx.app)
      .get("/api/v1/finance/overview?from=2026-01-01&to=2026-01-31")
      .set(authHeader(accountantToken));
    expect(res.status).toBe(403);
  });

  test("admin still accesses finance API when accountant finance is disabled", async () => {
    await updateAppSettings(ctx.db, {
      [SETTING_KEYS.accountant_permissions]: {
        ...defaultAccountantPermissions(),
        finance: false,
      },
    });

    const res = await request(ctx.app)
      .get("/api/v1/finance/overview?from=2026-01-01&to=2026-01-31")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
  });

  test("accountant with finance permission still accesses finance API", async () => {
    await updateAppSettings(ctx.db, {
      [SETTING_KEYS.accountant_permissions]: {
        ...defaultAccountantPermissions(),
        finance: true,
      },
    });

    const res = await request(ctx.app)
      .get("/api/v1/finance/overview?from=2026-01-01&to=2026-01-31")
      .set(authHeader(accountantToken));
    expect(res.status).toBe(200);
  });

  test("/auth/me returns effective permissions for accountant", async () => {
    await updateAppSettings(ctx.db, {
      [SETTING_KEYS.accountant_permissions]: {
        ...defaultAccountantPermissions(),
        expenses: false,
      },
    });

    const res = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set(authHeader(accountantToken));
    expect(res.status).toBe(200);
    const user = res.body.data?.user ?? res.body.user;
    expect(user.permissions.expenses).toBe(false);
    expect(user.permissions.finance).toBe(true);
  });

  test("custom permissions override the global set for that accountant only", async () => {
    const otherHash = await bcrypt.hash("acctpass456", 4);
    const otherIns = await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, ?, 0)",
      ["testaccountant2", otherHash, "accountant"]
    );
    const otherLogin = await login(ctx.app, "testaccountant2", "acctpass456");
    const otherToken = otherLogin.body.token;

    await updateAppSettings(ctx.db, {
      [SETTING_KEYS.accountant_permissions]: {
        ...defaultAccountantPermissions(),
        finance: false,
      },
    });

    const accountant = await ctx.db.get("SELECT id FROM users WHERE username = ?", [
      "testaccountant",
    ]);

    const putRes = await request(ctx.app)
      .put(`/api/v1/admin/users/${accountant.id}/permissions`)
      .set(authHeader(adminToken))
      .send({
        permissions: {
          ...defaultAccountantPermissions(),
          finance: true,
        },
      });
    expect(putRes.status).toBe(200);
    const putBody = putRes.body.data ?? putRes.body;
    expect(putBody.custom).toBe(true);
    expect(putBody.permissions.finance).toBe(true);

    const listRes = await request(ctx.app)
      .get("/api/v1/admin/users")
      .set(authHeader(adminToken));
    expect(listRes.status).toBe(200);
    const users = listRes.body.data ?? listRes.body;
    const rows = Array.isArray(users) ? users : users.users || [];
    const listed = rows.find((u) => u.id === accountant.id);
    expect(listed.has_custom_permissions).toBe(true);
    expect(rows.find((u) => u.id === otherIns.lastID)?.has_custom_permissions).toBe(false);

    const allowed = await request(ctx.app)
      .get("/api/v1/finance/overview?from=2026-01-01&to=2026-01-31")
      .set(authHeader(accountantToken));
    expect(allowed.status).toBe(200);

    const blocked = await request(ctx.app)
      .get("/api/v1/finance/overview?from=2026-01-01&to=2026-01-31")
      .set(authHeader(otherToken));
    expect(blocked.status).toBe(403);

    const meRes = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set(authHeader(accountantToken));
    expect(meRes.status).toBe(200);
    const me = meRes.body.data?.user ?? meRes.body.user;
    expect(me.permissions.finance).toBe(true);

    const otherMe = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set(authHeader(otherToken));
    expect(otherMe.status).toBe(200);
    const otherUser = otherMe.body.data?.user ?? otherMe.body.user;
    expect(otherUser.permissions.finance).toBe(false);

    const resetRes = await request(ctx.app)
      .put(`/api/v1/admin/users/${accountant.id}/permissions`)
      .set(authHeader(adminToken))
      .send({ permissions: null });
    expect(resetRes.status).toBe(200);
    const resetBody = resetRes.body.data ?? resetRes.body;
    expect(resetBody.custom).toBe(false);
    expect(resetBody.permissions.finance).toBe(false);

    const afterReset = await request(ctx.app)
      .get("/api/v1/finance/overview?from=2026-01-01&to=2026-01-31")
      .set(authHeader(accountantToken));
    expect(afterReset.status).toBe(403);

    const getRes = await request(ctx.app)
      .get(`/api/v1/admin/users/${accountant.id}/permissions`)
      .set(authHeader(adminToken));
    expect(getRes.status).toBe(200);
    const loaded = getRes.body.data ?? getRes.body;
    expect(loaded.custom).toBe(false);
    expect(loaded.permissions.finance).toBe(false);
  });

  test("PUT user permissions is admin-only and rejects non-office ids", async () => {
    const accountant = await ctx.db.get("SELECT id FROM users WHERE username = ?", [
      "testaccountant",
    ]);
    const cashier = await ctx.db.get("SELECT id FROM users WHERE username = ?", [
      "testcashier",
    ]);

    const asAccountant = await request(ctx.app)
      .put(`/api/v1/admin/users/${accountant.id}/permissions`)
      .set(authHeader(accountantToken))
      .send({ permissions: defaultAccountantPermissions() });
    expect(asAccountant.status).toBe(403);

    const onCashier = await request(ctx.app)
      .put(`/api/v1/admin/users/${cashier.id}/permissions`)
      .set(authHeader(adminToken))
      .send({ permissions: defaultAccountantPermissions() });
    expect(onCashier.status).toBe(400);

    const missing = await request(ctx.app)
      .put("/api/v1/admin/users/999999/permissions")
      .set(authHeader(adminToken))
      .send({ permissions: defaultAccountantPermissions() });
    expect(missing.status).toBe(404);

    const adminUser = await ctx.db.get("SELECT id FROM users WHERE username = ?", [
      "testadmin",
    ]);
    const onAdmin = await request(ctx.app)
      .put(`/api/v1/admin/users/${adminUser.id}/permissions`)
      .set(authHeader(adminToken))
      .send({
        permissions: {
          ...defaultAccountantPermissions(),
          finance: false,
        },
      });
    expect(onAdmin.status).toBe(200);
    const adminBody = onAdmin.body.data ?? onAdmin.body;
    expect(adminBody.custom).toBe(true);
    expect(adminBody.permissions.permissions).toBe(true);
    expect(adminBody.permissions.user_accounts).toBe(true);

    const resetAdmin = await request(ctx.app)
      .put(`/api/v1/admin/users/${adminUser.id}/permissions`)
      .set(authHeader(adminToken))
      .send({ permissions: null });
    expect(resetAdmin.status).toBe(200);
    expect((resetAdmin.body.data ?? resetAdmin.body).custom).toBe(false);
  });
});
