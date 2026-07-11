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
});
