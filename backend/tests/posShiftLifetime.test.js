/**
 * Cashier shifts are not closed by elapsed time. The eight-hour interruption
 * is the access token. Renewal rotates that token and leaves the shift open.
 * Disposable database only.
 */
import { jest } from "@jest/globals";
import request from "supertest";
import {
  authHeader,
  createTestContext,
  destroyTestContext,
  login,
  withCheckoutKey,
} from "./helpers.js";
import { shopBusinessDayYmd } from "../utils/businessDay.js";
import { shopLocalParts, SHOP_TZ } from "../utils/shopTime.js";
import { updateAppSettings } from "../utils/settings.js";
import { bumpSessionVersion } from "../utils/sessions.js";

function unwrap(body) {
  return body?.data ?? body;
}

function tokenClaims(token) {
  const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString());
  return payload;
}

function instantAt(ymd, hour, minute = 0) {
  const [y, m, d] = ymd.split("-").map(Number);
  const start = Date.UTC(y, m - 1, d - 1, 0, 0, 0);
  const end = Date.UTC(y, m - 1, d + 1, 23, 59, 0);
  for (let ms = start; ms <= end; ms += 60_000) {
    const parts = shopLocalParts(ms);
    if (parts && parts.ymd === ymd && parts.hour === hour && parts.minute === minute) {
      return ms;
    }
  }
  throw new Error(`No ${SHOP_TZ} instant for ${ymd} ${hour}:${String(minute).padStart(2, "0")}`);
}

async function openCount(db, cashierId) {
  return Number(
    (await db.get(
      "SELECT COUNT(*) AS n FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'",
      [cashierId]
    )).n
  );
}

describe("POS shift lifetime", () => {
  let ctx;
  let cashierToken;
  let cashierId;
  let product;

  beforeAll(async () => {
    ctx = await createTestContext();
    if (!/abo-shalbak-test-/.test(ctx.dbPath)) throw new Error(ctx.dbPath);
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    cashierId = (await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'")).id;
    product = await ctx.db.get("SELECT id, price FROM products WHERE id = ?", [ctx.productId]);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function sell(token, key) {
    return request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(token))
      .send(withCheckoutKey({
        items: [{ product_id: product.id, quantity: 1, price: product.price }],
        payment_method: "cash",
      }, key));
  }

  test("elapsed time alone leaves the same shift open and sales keep its business day", async () => {
    const started = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({});
    expect(started.status).toBe(201);
    const shiftId = unwrap(started.body).shift_id;
    const original = await ctx.db.get("SELECT * FROM cashier_shifts WHERE id = ?", [shiftId]);

    for (const minutes of [7 * 60 + 59, 8 * 60, 8 * 60 + 1]) {
      await ctx.db.run("UPDATE cashier_shifts SET start_time = ? WHERE id = ?", [
        new Date(Date.now() - minutes * 60_000).toISOString(),
        shiftId,
      ]);
      const current = await request(ctx.app).get("/api/v1/shifts/current").set(authHeader(cashierToken));
      expect(current.status).toBe(200);
      expect(unwrap(current.body).shift.id).toBe(shiftId);
      expect(unwrap(current.body).shift.status).toBe("open");
      expect(unwrap(current.body).shift.business_day).toBe(original.business_day);
      const sale = await sell(cashierToken);
      expect(sale.status).toBe(201);
      const row = await ctx.db.get(
        `SELECT t.shift_id, t.business_day, cs.business_day AS shift_business_day, cs.start_time, t.created_at
           FROM transactions t JOIN cashier_shifts cs ON cs.id = t.shift_id
          WHERE t.id = ?`,
        [unwrap(sale.body).transaction_id]
      );
      expect(Number(row.shift_id)).toBe(shiftId);
      expect(shopBusinessDayYmd(row)).toBe(original.business_day);
      const ledger = await ctx.db.get(
        "SELECT business_day FROM inventory_ledger WHERE reference_type = 'transaction' AND reference_id = ?",
        [unwrap(sale.body).transaction_id]
      );
      expect(ledger.business_day).toBe(original.business_day);
    }

    expect(await openCount(ctx.db, cashierId)).toBe(1);
    const again = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    expect(again.status).toBe(409);
    expect(await openCount(ctx.db, cashierId)).toBe(1);

    const ended = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/end`)
      .set(authHeader(cashierToken))
      .send({});
    expect(ended.status).toBe(200);
    expect(unwrap(ended.body).status).toBe("pending_count");
    const blocked = await sell(cashierToken);
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe("NO_OPEN_SHIFT");
    const counted = await ctx.db.get("SELECT status FROM cashier_shifts WHERE id = ?", [shiftId]);
    expect(counted.status).toBe("pending_count");

    await ctx.db.run("UPDATE cashier_shifts SET status = 'closed' WHERE id = ?", [shiftId]);
    const closedSale = await sell(cashierToken);
    expect(closedSale.status).toBe(400);
    expect((await ctx.db.get("SELECT status FROM cashier_shifts WHERE id = ?", [shiftId])).status).toBe("closed");
    const current = await request(ctx.app).get("/api/v1/shifts/current").set(authHeader(cashierToken));
    expect(unwrap(current.body).shift).toBeNull();
  });
});

describe("access-token renewal is separate from the shift", () => {
  const timer = {
    doNotFake: ["nextTick", "setImmediate", "setTimeout", "setInterval", "queueMicrotask"],
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  test("a refreshed token still uses the same shift at 7:59, 8:00, and 8:01 hours", async () => {
    const start = Date.parse("2026-10-13T06:00:00.000Z");
    jest.useFakeTimers({ ...timer, now: start });
    const ctx = await createTestContext();
    try {
      const cashier = await login(ctx.app, "testcashier", "cashpass123", "pos");
      const token = cashier.body.token;
      const claims = tokenClaims(token);
      const lifetimeMs = (claims.exp - claims.iat) * 1000;
      expect(Number.isFinite(lifetimeMs)).toBe(true);
      expect(lifetimeMs).toBeGreaterThan(60_000);
      if (!process.env.JWT_EXPIRES_IN) expect(lifetimeMs).toBe(8 * 60 * 60 * 1000);

      const started = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(token)).send({});
      expect(started.status).toBe(201);
      const shiftId = unwrap(started.body).shift_id;
      const cashierId = (await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'")).id;
      const product = await ctx.db.get("SELECT id, price FROM products WHERE id = ?", [ctx.productId]);
      const shiftsBefore = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM cashier_shifts")).n);

      jest.setSystemTime(start + lifetimeMs - 60_000);
      const early = await request(ctx.app)
        .post("/api/v1/checkout")
        .set(authHeader(token))
        .send(withCheckoutKey({
          items: [{ product_id: product.id, quantity: 1, price: product.price }],
          payment_method: "cash",
        }));
      expect(early.status).toBe(201);

      const refreshed = await request(ctx.app).post("/api/v1/auth/refresh").set(authHeader(token));
      expect(refreshed.status).toBe(200);
      const next = unwrap(refreshed.body).token;
      expect(next).toBeTruthy();
      expect(next).not.toBe(token);
      const nextClaims = tokenClaims(next);
      expect(nextClaims.exp).toBeGreaterThan(claims.exp);
      expect((await request(ctx.app).get("/api/v1/auth/me").set(authHeader(token))).status).toBe(401);
      expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM cashier_shifts")).n)).toBe(shiftsBefore);

      for (const offset of [lifetimeMs, lifetimeMs + 60_000]) {
        jest.setSystemTime(start + offset);
        const sale = await request(ctx.app)
          .post("/api/v1/checkout")
          .set(authHeader(next))
          .send(withCheckoutKey({
            items: [{ product_id: product.id, quantity: 1, price: product.price }],
            payment_method: "cash",
          }));
        expect(sale.status).toBe(201);
        const current = await request(ctx.app).get("/api/v1/shifts/current").set(authHeader(next));
        expect(unwrap(current.body).shift.id).toBe(shiftId);
        expect(unwrap(current.body).shift.status).toBe("open");
      }
      expect(await openCount(ctx.db, cashierId)).toBe(1);
      const row = await ctx.db.get("SELECT status, end_time, business_day FROM cashier_shifts WHERE id = ?", [shiftId]);
      expect(row.status).toBe("open");
      expect(row.end_time).toBeNull();
    } finally {
      jest.useRealTimers();
      await destroyTestContext(ctx);
    }
  });

  test("an expired token does not close the shift, and signing in again recovers it without a duplicate sale", async () => {
    const start = Date.parse("2026-10-13T08:00:00.000Z");
    jest.useFakeTimers({ ...timer, now: start });
    const ctx = await createTestContext();
    try {
      const first = await login(ctx.app, "testcashier", "cashpass123", "pos");
      const token = first.body.token;
      const lifetimeMs = (tokenClaims(token).exp - tokenClaims(token).iat) * 1000;
      const started = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(token)).send({});
      const shiftId = unwrap(started.body).shift_id;
      const product = await ctx.db.get("SELECT id, price FROM products WHERE id = ?", [ctx.productId]);
      const key = "shift-recover-sale-01";
      const sale = await request(ctx.app)
        .post("/api/v1/checkout")
        .set(authHeader(token))
        .send(withCheckoutKey({
          items: [{ product_id: product.id, quantity: 1, price: product.price }],
          payment_method: "cash",
        }, key));
      expect(sale.status).toBe(201);
      const txCount = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM transactions")).n);

      jest.setSystemTime(start + lifetimeMs + 60_000);
      const denied = await request(ctx.app).get("/api/v1/shifts/current").set(authHeader(token));
      expect(denied.status).toBe(401);
      const refreshDenied = await request(ctx.app).post("/api/v1/auth/refresh").set(authHeader(token));
      expect(refreshDenied.status).toBe(401);
      const still = await ctx.db.get("SELECT status, end_time FROM cashier_shifts WHERE id = ?", [shiftId]);
      expect(still.status).toBe("open");
      expect(still.end_time).toBeNull();
      expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM cashier_shifts WHERE status = 'open'")).n)).toBe(1);

      const again = await login(ctx.app, "testcashier", "cashpass123", "pos");
      const current = await request(ctx.app)
        .get("/api/v1/shifts/current")
        .set(authHeader(again.body.token));
      expect(unwrap(current.body).shift.id).toBe(shiftId);
      const replay = await request(ctx.app)
        .post("/api/v1/checkout")
        .set(authHeader(again.body.token))
        .send(withCheckoutKey({
          items: [{ product_id: product.id, quantity: 1, price: product.price }],
          payment_method: "cash",
        }, key));
      expect(replay.status).toBe(200);
      expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM transactions")).n)).toBe(txCount);
      expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM cashier_shifts")).n)).toBe(1);
    } finally {
      jest.useRealTimers();
      await destroyTestContext(ctx);
    }
  });

  test("logout and a revoked session do not close the shift", async () => {
    const ctx = await createTestContext();
    try {
      const cashier = await login(ctx.app, "testcashier", "cashpass123", "pos");
      const token = cashier.body.token;
      const started = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(token)).send({});
      const shiftId = unwrap(started.body).shift_id;
      const userId = (await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'")).id;
      await bumpSessionVersion(ctx.db, userId);
      const revoked = await request(ctx.app).post("/api/v1/auth/refresh").set(authHeader(token));
      expect(revoked.status).toBe(401);
      expect((await ctx.db.get("SELECT status FROM cashier_shifts WHERE id = ?", [shiftId])).status).toBe("open");

      const fresh = await login(ctx.app, "testcashier", "cashpass123", "pos");
      const out = await request(ctx.app).post("/api/v1/auth/logout").set(authHeader(fresh.body.token));
      expect(out.status).toBe(200);
      const after = await request(ctx.app).post("/api/v1/auth/refresh").set(authHeader(fresh.body.token));
      expect(after.status).toBe(401);
      expect((await ctx.db.get("SELECT status, end_time FROM cashier_shifts WHERE id = ?", [shiftId])).status).toBe(
        "open"
      );
    } finally {
      await destroyTestContext(ctx);
    }
  });
});

describe("an open shift survives midnight and the business-day cutoff", () => {
  const timer = {
    doNotFake: ["nextTick", "setImmediate", "setTimeout", "setInterval", "queueMicrotask"],
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  test("sales and refunds keep the shift business day and no second shift is opened", async () => {
    const evening = instantAt("2026-10-13", 22);
    jest.useFakeTimers({ ...timer, now: evening });
    const ctx = await createTestContext();
    try {
      await updateAppSettings(ctx.db, { business_day_cutoff_hour: 4 });
      const cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
      const adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
      const product = await ctx.db.get("SELECT id, price FROM products WHERE id = ?", [ctx.productId]);
      const started = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
      expect(started.status).toBe(201);
      const shiftId = unwrap(started.body).shift_id;
      const opened = await ctx.db.get("SELECT business_day FROM cashier_shifts WHERE id = ?", [shiftId]);
      expect(opened.business_day).toBe("2026-10-13");

      jest.setSystemTime(instantAt("2026-10-14", 2));
      let current = await request(ctx.app).get("/api/v1/shifts/current").set(authHeader(cashierToken));
      expect(unwrap(current.body).shift.id).toBe(shiftId);
      expect(unwrap(current.body).shift.business_day).toBe("2026-10-13");

      jest.setSystemTime(instantAt("2026-10-14", 5));
      const sale = await request(ctx.app)
        .post("/api/v1/checkout")
        .set(authHeader(cashierToken))
        .send(withCheckoutKey({
          items: [{ product_id: product.id, quantity: 1, price: product.price }],
          payment_method: "cash",
        }));
      expect(sale.status).toBe(201);
      const txId = unwrap(sale.body).transaction_id;
      const ledger = await ctx.db.get(
        "SELECT business_day FROM inventory_ledger WHERE reference_type = 'transaction' AND reference_id = ?",
        [txId]
      );
      expect(ledger.business_day).toBe("2026-10-13");
      const second = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
      expect(second.status).toBe(409);
      expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM cashier_shifts WHERE status = 'open'")).n)).toBe(1);
      expect((await ctx.db.get("SELECT business_day, status FROM cashier_shifts WHERE id = ?", [shiftId])).business_day).toBe(
        "2026-10-13"
      );

      const refundReq = await request(ctx.app)
        .post("/api/v1/refund-requests")
        .set(authHeader(cashierToken))
        .send({
          original_transaction_id: txId,
          lines: [{ product_id: product.id, quantity: 1 }],
          payment_method: "cash",
          reason: "بعد منتصف الليل",
          idempotency_key: "shift-night-refund-1",
        });
      expect(refundReq.status).toBe(201);
      const approved = await request(ctx.app)
        .put(`/api/v1/refund-requests/${unwrap(refundReq.body).request_id}`)
        .set(authHeader(adminToken))
        .send({ status: "approved" });
      expect(approved.status).toBe(200);
      const refund = await ctx.db.get(
        "SELECT business_day, shift_id FROM refunds WHERE original_transaction_id = ?",
        [txId]
      );
      expect(Number(refund.shift_id)).toBe(shiftId);
      expect(refund.business_day).toBe("2026-10-13");
      current = await request(ctx.app).get("/api/v1/shifts/current").set(authHeader(cashierToken));
      expect(unwrap(current.body).shift.id).toBe(shiftId);
      expect(unwrap(current.body).shift.status).toBe("open");
    } finally {
      jest.useRealTimers();
      await destroyTestContext(ctx);
    }
  });
});
