import { performance } from "node:perf_hooks";
import request from "supertest";
import bcrypt from "bcrypt";
import {
  authHeader,
  createTestContext,
  destroyTestContext,
  login,
  withCheckoutKey,
} from "./helpers.js";
import { settleTelegramDeliveries } from "../services/telegramDelivery.js";

const DELAY_MS = 800;

describe("Telegram delivery does not stall unrelated POS work", () => {
  let ctx;
  let cashierToken;
  let otherToken;
  let employeeId;
  let originalFetch;
  let releaseDelivery;
  let sendCalls;

  beforeAll(async () => {
    process.env.TELEGRAM_DELIVERY_ASYNC = "1";
    process.env.TELEGRAM_SULAF_BOT_TOKEN = "test-sulaf-token";
    process.env.TELEGRAM_SULAF_CHAT_ID = "-100999";
    process.env.TELEGRAM_USE_POLLING = "0";
    ctx = await createTestContext();
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    const hash = await bcrypt.hash("cashpass123", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES ('cashier2', ?, 'cashier', 0)",
      [hash]
    );
    otherToken = (await login(ctx.app, "cashier2", "cashpass123", "pos")).body.token;
    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({ opening_cash: 50 });
    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(otherToken)).send({ opening_cash: 40 });
    employeeId = (await ctx.db.run("INSERT INTO employees (name, active) VALUES ('موظف قياس', 1)")).lastID;
    await ctx.db.run("UPDATE products SET stock = 30, price = 10, cost = 4 WHERE id = ?", [ctx.productId]);
    originalFetch = global.fetch;
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    delete process.env.TELEGRAM_DELIVERY_ASYNC;
    delete process.env.TELEGRAM_SULAF_BOT_TOKEN;
    delete process.env.TELEGRAM_SULAF_CHAT_ID;
    delete process.env.TELEGRAM_HTTP_TIMEOUT_MS;
    await destroyTestContext(ctx);
  });

  function holdSend() {
    sendCalls = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    releaseDelivery = release;
    global.fetch = async (url) => {
      const href = String(url);
      if (!href.includes("api.telegram.org")) throw new Error(`blocked network ${href}`);
      if (!href.includes("/sendMessage")) throw new Error(`unexpected telegram ${href}`);
      sendCalls += 1;
      await gate;
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 77 } }) };
    };
  }

  test("another cashier can sell and scan while this cashier's Telegram send is still pending", async () => {
    holdSend();
    const started = performance.now();
    const submitPromise = request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: employeeId, amount: 5, notes: "قياس" });

    await new Promise((resolve) => setTimeout(resolve, 30));
    const lookupStarted = performance.now();
    const lookup = await request(ctx.app)
      .get("/api/v1/pos/lookup")
      .query({ barcode: "9990001" })
      .set(authHeader(cashierToken));
    const lookupMs = performance.now() - lookupStarted;
    const saleStarted = performance.now();
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(otherToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 1, price: 10 }],
          payment_method: "cash",
        })
      );
    const saleMs = performance.now() - saleStarted;
    const submit = await submitPromise;
    const submitMs = performance.now() - started;

    expect(lookup.status).toBe(200);
    expect(sale.status).toBe(201);
    expect(submit.status).toBe(201);
    const body = submit.body.data ?? submit.body;
    expect(body.pending_approval).not.toBe(false);
    expect(body.status === "pending" || body.pending_approval === true || body.request_id).toBeTruthy();
    expect(body.telegram).toBe(false);
    expect(body.telegram_delivery).toBe("queued");
    expect(submitMs).toBeLessThan(DELAY_MS / 2);
    expect(lookupMs).toBeLessThan(250);
    expect(saleMs).toBeLessThan(250);

    const saved = await ctx.db.get("SELECT status, telegram_message_id FROM advance_requests ORDER BY id DESC LIMIT 1");
    expect(saved.status).toBe("pending");
    expect(saved.telegram_message_id == null || saved.telegram_message_id === "").toBe(true);

    releaseDelivery();
    await settleTelegramDeliveries();
    const delivered = await ctx.db.get(
      "SELECT status, telegram_message_id FROM advance_requests ORDER BY id DESC LIMIT 1"
    );
    expect(delivered.status).toBe("pending");
    expect(delivered.telegram_message_id).toBe("77");
    expect(sendCalls).toBe(1);
  });

  test("a network failure leaves the request pending and unapproved", async () => {
    sendCalls = 0;
    global.fetch = async (url) => {
      if (!String(url).includes("sendMessage")) throw new Error("unexpected");
      sendCalls += 1;
      throw new Error("network down");
    };
    const submit = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: employeeId, amount: 6, notes: "فشل" });
    expect(submit.status).toBe(201);
    await settleTelegramDeliveries();
    const row = await ctx.db.get(
      "SELECT status, telegram_message_id, amount FROM advance_requests ORDER BY id DESC LIMIT 1"
    );
    expect(row.status).toBe("pending");
    expect(row.telegram_message_id == null || row.telegram_message_id === "").toBe(true);
    expect(Number(row.amount)).toBe(6);
    expect(sendCalls).toBe(1);
  });

  test("a 429 is not retried and does not approve the request", async () => {
    sendCalls = 0;
    global.fetch = async (url) => {
      if (!String(url).includes("sendMessage")) throw new Error("unexpected");
      sendCalls += 1;
      return {
        ok: true,
        json: async () => ({
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 30 },
        }),
      };
    };
    const submit = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: employeeId, amount: 7, notes: "حد" });
    expect(submit.status).toBe(201);
    await settleTelegramDeliveries();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const row = await ctx.db.get("SELECT status, telegram_message_id FROM advance_requests ORDER BY id DESC LIMIT 1");
    expect(row.status).toBe("pending");
    expect(row.telegram_message_id == null || row.telegram_message_id === "").toBe(true);
    expect(sendCalls).toBe(1);
  });

  test("a hung Telegram call times out without authorizing the advance", async () => {
    process.env.TELEGRAM_HTTP_TIMEOUT_MS = "1000";
    sendCalls = 0;
    global.fetch = async (url, options) => {
      if (!String(url).includes("sendMessage")) throw new Error("unexpected");
      sendCalls += 1;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        options?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 9 } }) };
    };
    const submit = await request(ctx.app)
      .post("/api/v1/advance-requests")
      .set(authHeader(cashierToken))
      .send({ employee_id: employeeId, amount: 8, notes: "مهلة" });
    expect(submit.status).toBe(201);
    await settleTelegramDeliveries();
    const row = await ctx.db.get("SELECT status, telegram_message_id FROM advance_requests ORDER BY id DESC LIMIT 1");
    expect(row.status).toBe("pending");
    expect(row.telegram_message_id == null || row.telegram_message_id === "").toBe(true);
    expect(sendCalls).toBe(1);
    delete process.env.TELEGRAM_HTTP_TIMEOUT_MS;
  });
});
