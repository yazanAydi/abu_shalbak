import { jest } from "@jest/globals";
import request from "supertest";
import {
  authHeader,
  createAccountantUser,
  createTestContext,
  destroyTestContext,
  login,
} from "./helpers.js";
import { handleTelegramUpdate } from "../services/telegramUpdateService.js";

function unwrap(body) {
  return body?.data ?? body;
}

async function startShift(app, token) {
  const res = await request(app).post("/api/v1/shifts/start").set(authHeader(token)).send({});
  expect(res.status).toBe(201);
  return unwrap(res.body).shift_id;
}

describe("office supplier and shop-consumption approvals", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let supplierId;
  let expensesOnlyToken;
  let suppliersOnlyToken;
  const prev = {};

  beforeAll(async () => {
    for (const key of ["TELEGRAM_APPROVALS_BOT_TOKEN", "TELEGRAM_APPROVALS_CHAT_ID"]) {
      prev[key] = process.env[key];
      delete process.env[key];
    }
    global.fetch = jest.fn(async () => {
      throw new Error("live Telegram must not be called");
    });
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await ctx.db.run("UPDATE products SET cost = 4, cost_known = 1, stock = 30, price = 9 WHERE id = ?", [
      ctx.productId,
    ]);
    const sup = await ctx.db.run(
      "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد الصفحة', 'S-PAGE', 80, 80)"
    );
    supplierId = sup.lastID;
    const expensesOnly = await createAccountantUser(ctx.db, {
      username: "expensesonly",
      password: "acctpass123",
      permissions: { expenses: true, suppliers: false },
    });
    const suppliersOnly = await createAccountantUser(ctx.db, {
      username: "suppliersonly",
      password: "acctpass123",
      permissions: { expenses: false, suppliers: true },
    });
    expensesOnlyToken = (await login(ctx.app, expensesOnly.username, expensesOnly.password)).body.token;
    suppliersOnlyToken = (await login(ctx.app, suppliersOnly.username, suppliersOnly.password)).body.token;
  });

  afterAll(async () => {
    for (const key of Object.keys(prev)) {
      if (prev[key] == null) delete process.env[key];
      else process.env[key] = prev[key];
    }
    await destroyTestContext(ctx);
  });

  test("lists checkout and shift-count supplier requests, and gates them with the suppliers permission", async () => {
    const shiftId = await startShift(ctx.app, cashierToken);
    const checkout = await request(ctx.app)
      .post("/api/v1/pos/supplier-payments")
      .set(authHeader(cashierToken))
      .send({
        supplier_id: supplierId,
        amount: 12,
        notes: "من الصندوق",
        idempotency_key: "page-sup-pos-000001",
      });
    expect(checkout.status).toBe(201);
    const ended = await request(ctx.app).post(`/api/v1/shifts/${shiftId}/end`).set(authHeader(cashierToken)).send({});
    expect(ended.status).toBe(200);
    const counted = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftId}/supplier-payments`)
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        amount: 7,
        notes: "دُفعت أثناء الوردية",
        idempotency_key: "page-sup-count-0001",
      });
    expect(counted.status).toBe(201);

    const denied = await request(ctx.app)
      .get("/api/v1/supplier-payment-requests")
      .query({ status: "pending" })
      .set(authHeader(expensesOnlyToken));
    expect(denied.status).toBe(403);

    const list = await request(ctx.app)
      .get("/api/v1/supplier-payment-requests")
      .query({ status: "pending" })
      .set(authHeader(suppliersOnlyToken));
    expect(list.status).toBe(200);
    const rows = unwrap(list.body);
    const pos = rows.find((row) => row.id === unwrap(checkout.body).request_id);
    const shiftCount = rows.find((row) => row.id === unwrap(counted.body).request_id);
    expect(pos.origin).toBe("pos");
    expect(pos.already_paid).toBe(false);
    expect(pos.supplier_name).toBe("مورد الصفحة");
    expect(pos.amount).toBe(12);
    expect(pos.notes).toBe("من الصندوق");
    expect(pos.shift_id).toBe(shiftId);
    expect(pos.cashier_username).toBeTruthy();
    expect(shiftCount.origin).toBe("shift_count");
    expect(shiftCount.already_paid).toBe(true);
    expect(shiftCount.origin_label).toContain("دفعة سابقة");
    expect(shiftCount.amount).toBe(7);

    const badges = unwrap(
      (await request(ctx.app).get("/api/v1/office/nav-badges").set(authHeader(suppliersOnlyToken))).body
    );
    expect(badges.by_path["/supplier-payment-approvals"]).toBeGreaterThanOrEqual(2);
    expect(badges.by_path["/shop-consumption-approvals"]).toBe(0);
    expect(badges.pending_shop_consumption).toBe(0);

    const hidden = unwrap(
      (await request(ctx.app).get("/api/v1/office/nav-badges").set(authHeader(expensesOnlyToken))).body
    );
    expect(hidden.by_path["/supplier-payment-approvals"]).toBe(0);
    expect(hidden.pending_supplier_payments).toBe(0);
  });

  test("office and Telegram share one supplier request and reprint does not post again", async () => {
    process.env.TELEGRAM_APPROVALS_BOT_TOKEN = "approvals-test-token";
    process.env.TELEGRAM_APPROVALS_CHAT_ID = "-100777";
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes("getChatMember")) {
        return { json: async () => ({ ok: true, result: { status: "member" } }) };
      }
      if (String(url).includes("sendMessage")) {
        return { json: async () => ({ ok: true, result: { message_id: 91 } }) };
      }
      return { json: async () => ({ ok: true, result: true }) };
    });

    await ctx.db.run("UPDATE cashier_shifts SET status = 'closed' WHERE status IN ('open', 'pending_count')");
    await startShift(ctx.app, cashierToken);
    const created = unwrap(
      (
        await request(ctx.app).post("/api/v1/pos/supplier-payments").set(authHeader(cashierToken)).send({
          supplier_id: supplierId,
          amount: 5,
          notes: "مشترك",
          idempotency_key: "page-sup-shared-0001",
        })
      ).body
    );
    expect(created.telegram).toBe(true);
    const vouchersBefore = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM vouchers")).n);

    const click = {
      callback_query: {
        id: "cq-supplier-page",
        data: `supplier:approve:${created.request_id}`,
        from: { id: 555, username: "boss" },
        message: { message_id: 91, chat: { id: "-100777", type: "supergroup" } },
      },
    };
    const first = await handleTelegramUpdate(ctx.db, click, { sourceBot: "approvals" });
    expect(first.action).toBe("approve");
    const again = await request(ctx.app)
      .post(`/api/v1/supplier-payment-requests/${created.request_id}/approve`)
      .set(authHeader(adminToken));
    expect(again.status).toBe(409);
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM vouchers")).n)).toBe(vouchersBefore + 1);

    const approved = unwrap(
      (
        await request(ctx.app)
          .get("/api/v1/supplier-payment-requests")
          .query({ status: "approved" })
          .set(authHeader(adminToken))
      ).body
    );
    const row = approved.find((item) => item.id === created.request_id);
    expect(row.decision_source).toBe("telegram");
    expect(row.decision_actor).toBe("boss");
    expect(row.decision_at).toBeTruthy();
    expect(row.can_reprint).toBe(true);

    const printed = await request(ctx.app)
      .post(`/api/v1/supplier-payment-requests/${created.request_id}/reprint`)
      .set(authHeader(adminToken));
    expect(printed.status).toBe(200);
    expect(unwrap(printed.body).receipt_html).toContain("دفع لمورد");
    expect(unwrap(printed.body).copy).toBe(true);
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM vouchers")).n)).toBe(vouchersBefore + 1);

    const pendingReprint = await request(ctx.app)
      .post(`/api/v1/supplier-payment-requests/${created.request_id}/reprint`)
      .set(authHeader(expensesOnlyToken));
    expect(pendingReprint.status).toBe(403);
    delete process.env.TELEGRAM_APPROVALS_BOT_TOKEN;
    delete process.env.TELEGRAM_APPROVALS_CHAT_ID;
  });

  test("shop consumption queue shows products, and a repeat decision does not post twice", async () => {
    await ctx.db.run("UPDATE cashier_shifts SET status = 'closed' WHERE status IN ('open', 'pending_count')");
    const shiftId = await startShift(ctx.app, cashierToken);
    const product = await ctx.db.get("SELECT name FROM products WHERE id = ?", [ctx.productId]);
    const created = await request(ctx.app)
      .post("/api/v1/pos/shop-consumption")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, quantity: 2 }],
        reason: "تنظيف المحل",
        idempotency_key: "page-shop-00000001",
      });
    expect(created.status).toBe(201);
    const requestId = unwrap(created.body).request_id;

    const hidden = await request(ctx.app)
      .get("/api/v1/shop-consumption-requests")
      .query({ status: "pending" })
      .set(authHeader(suppliersOnlyToken));
    expect(hidden.status).toBe(403);

    const pending = unwrap(
      (
        await request(ctx.app)
          .get("/api/v1/shop-consumption-requests")
          .query({ status: "pending" })
          .set(authHeader(expensesOnlyToken))
      ).body
    );
    const row = pending.find((item) => item.id === requestId);
    expect(row.shift_id).toBe(shiftId);
    expect(row.notes).toBe("تنظيف المحل");
    expect(row.amount).toBe(8);
    expect(row.items[0].name).toBe(product.name);
    expect(Number(row.items[0].quantity)).toBe(2);

    const badges = unwrap(
      (await request(ctx.app).get("/api/v1/office/nav-badges").set(authHeader(expensesOnlyToken))).body
    );
    expect(badges.by_path["/shop-consumption-approvals"]).toBeGreaterThanOrEqual(1);

    const expensesBefore = Number(
      (await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses WHERE source = 'shop_consumption'")).n
    );
    const approved = await request(ctx.app)
      .post(`/api/v1/shop-consumption-requests/${requestId}/approve`)
      .set(authHeader(adminToken));
    expect(approved.status).toBe(200);
    const duplicate = await request(ctx.app)
      .post(`/api/v1/shop-consumption-requests/${requestId}/approve`)
      .set(authHeader(adminToken));
    expect(duplicate.status).toBe(409);
    expect(
      Number((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses WHERE source = 'shop_consumption'")).n)
    ).toBe(expensesBefore + 1);

    const detail = unwrap(
      (await request(ctx.app).get(`/api/v1/shop-consumption-requests/${requestId}`).set(authHeader(adminToken))).body
    );
    expect(detail.decision_source).toBe("admin");
    expect(detail.decision_actor).toBe("testadmin");
    expect(detail.decision_at).toBeTruthy();
    expect(detail.can_reprint).toBe(true);

    const printed = await request(ctx.app)
      .post(`/api/v1/shop-consumption-requests/${requestId}/reprint`)
      .set(authHeader(adminToken));
    expect(printed.status).toBe(200);
    expect(unwrap(printed.body).receipt_html).toContain("مصاريف محل");
    expect(
      Number((await ctx.db.get("SELECT COUNT(*) AS n FROM operating_expenses WHERE source = 'shop_consumption'")).n)
    ).toBe(expensesBefore + 1);

    const officeExpense = await request(ctx.app).post("/api/v1/expenses").set(authHeader(adminToken)).send({
      category: "other",
      amount: 3,
      paid_on: "2026-09-24",
      payment_method: "cash",
    });
    expect([200, 201, 400]).toContain(officeExpense.status);
    const stillSeparate = unwrap(
      (
        await request(ctx.app)
          .get("/api/v1/shop-consumption-requests")
          .query({ status: "approved" })
          .set(authHeader(adminToken))
      ).body
    );
    expect(stillSeparate.every((item) => item.consumption_id || item.status === "approved")).toBe(true);
    expect(stillSeparate.some((item) => item.notes === "تنظيف المحل")).toBe(true);
  });

  test("Telegram rejection of a shop request is visible in the office queue and cannot be approved afterwards", async () => {
    process.env.TELEGRAM_APPROVALS_BOT_TOKEN = "approvals-test-token";
    process.env.TELEGRAM_APPROVALS_CHAT_ID = "-100777";
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes("getChatMember")) {
        return { json: async () => ({ ok: true, result: { status: "member" } }) };
      }
      if (String(url).includes("sendMessage")) {
        return { json: async () => ({ ok: true, result: { message_id: 92 } }) };
      }
      return { json: async () => ({ ok: true, result: true }) };
    });
    await ctx.db.run("UPDATE cashier_shifts SET status = 'closed' WHERE status IN ('open', 'pending_count')");
    await startShift(ctx.app, cashierToken);
    const created = unwrap(
      (
        await request(ctx.app).post("/api/v1/pos/shop-consumption").set(authHeader(cashierToken)).send({
          items: [{ product_id: ctx.productId, quantity: 1 }],
          reason: "مرفوض من تيليجرام",
          idempotency_key: "page-shop-reject-001",
        })
      ).body
    );
    const stockBefore = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock);
    const click = {
      callback_query: {
        id: "cq-shop-reject",
        data: `consumption:reject:${created.request_id}`,
        from: { id: 777, username: "lead" },
        message: { message_id: 92, chat: { id: "-100777", type: "supergroup" } },
      },
    };
    const rejected = await handleTelegramUpdate(ctx.db, click, { sourceBot: "approvals" });
    expect(rejected.action).toBe("reject");
    const office = await request(ctx.app)
      .post(`/api/v1/shop-consumption-requests/${created.request_id}/approve`)
      .set(authHeader(adminToken));
    expect(office.status).toBe(409);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock)).toBe(stockBefore);

    const rows = unwrap(
      (
        await request(ctx.app)
          .get("/api/v1/shop-consumption-requests")
          .query({ status: "rejected" })
          .set(authHeader(adminToken))
      ).body
    );
    const row = rows.find((item) => item.id === created.request_id);
    expect(row.decision_source).toBe("telegram");
    expect(row.decision_actor).toBe("lead");
    expect(row.can_reprint).toBe(false);
    delete process.env.TELEGRAM_APPROVALS_BOT_TOKEN;
    delete process.env.TELEGRAM_APPROVALS_CHAT_ID;
  });
});
