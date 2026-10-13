import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";
import { computeExpectedDrawer } from "../utils/salePayments.js";

const INSUFFICIENT_DRAWER = /INSUFFICIENT_CHANGE|النقد في الدرج غير كاف/;

describe("POS checkout does not block on drawer cash", () => {
  let ctx;
  let cashierToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.db.run("UPDATE products SET price = 15, tax_rate = 0 WHERE id = ?", [ctx.productId]);
    await ctx.db.run(
      "UPDATE product_units SET price = 15 WHERE product_id = ? AND is_default = 1",
      [ctx.productId]
    );
    await ctx.db.run(
      "INSERT INTO app_settings (key, value) VALUES ('default_opening_cash', '0') ON CONFLICT(key) DO UPDATE SET value = '0'"
    );
    const loginRes = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = loginRes.body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function openShift() {
    const start = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({});
    expect(start.status).toBe(201);
    const shiftId = start.body.data?.shift_id ?? start.body.shift_id;
    const shift = await ctx.db.get("SELECT opening_cash FROM cashier_shifts WHERE id = ?", [shiftId]);
    return { shiftId, openingCash: Number(shift.opening_cash) };
  }

  async function counts() {
    const tx = await ctx.db.get("SELECT COUNT(*) AS n FROM transactions");
    const pays = await ctx.db.get("SELECT COUNT(*) AS n FROM sale_payments");
    const ledger = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE movement_type = 'sale'"
    );
    const cash = await ctx.db.get("SELECT COUNT(*) AS n FROM shift_cash_movements");
    return {
      transactions: Number(tx.n),
      payments: Number(pays.n),
      ledger: Number(ledger.n),
      cash: Number(cash.n),
    };
  }

  function tender20() {
    return withCheckoutKey({
      items: [{ product_id: ctx.productId, quantity: 1, price: 15 }],
      payment_method: "cash",
      payments: [{ method: "cash", original_amount: 20 }],
    });
  }

  test("zero drawer, total 15, tender 20, change 5 posts once", async () => {
    const { shiftId, openingCash } = await openShift();
    expect(openingCash).toBe(0);
    const beforeDrawer = await computeExpectedDrawer(ctx.db, shiftId, openingCash);
    expect(beforeDrawer.expected_cash).toBe(0);

    const before = await counts();
    const payload = tender20();
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(payload);

    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toMatch(INSUFFICIENT_DRAWER);
    const body = res.body.data ?? res.body;
    expect(body.total).toBe(15);

    const tx = await ctx.db.get(
      "SELECT total, change_amount, payment_method, status FROM transactions WHERE id = ?",
      [body.transaction_id]
    );
    expect(Number(tx.total)).toBe(15);
    expect(Number(tx.change_amount)).toBe(5);
    expect(tx.payment_method).toBe("cash");
    expect(tx.status).toBe("completed");

    const payments = await ctx.db.all(
      "SELECT payment_method, original_amount, amount FROM sale_payments WHERE transaction_id = ?",
      [body.transaction_id]
    );
    expect(payments).toHaveLength(1);
    expect(payments[0].payment_method).toBe("cash");
    expect(Number(payments[0].original_amount)).toBe(20);
    expect(Number(payments[0].amount)).toBe(20);

    const ledger = await ctx.db.all(
      "SELECT quantity_delta FROM inventory_ledger WHERE reference_type = 'transaction' AND reference_id = ? AND movement_type = 'sale'",
      [body.transaction_id]
    );
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0].quantity_delta)).toBe(-1);

    const movements = await ctx.db.all(
      "SELECT movement_type, amount, transaction_id FROM shift_cash_movements WHERE shift_id = ? ORDER BY id",
      [shiftId]
    );
    expect(movements).toHaveLength(2);
    expect(movements[0].movement_type).toBe("opening");
    expect(Number(movements[0].amount)).toBe(0);
    expect(movements[0].transaction_id).toBeNull();
    expect(movements[1].movement_type).toBe("payment");
    expect(Number(movements[1].amount)).toBe(15);
    expect(Number(movements[1].transaction_id)).toBe(Number(body.transaction_id));

    const after = await counts();
    expect(after.transactions - before.transactions).toBe(1);
    expect(after.payments - before.payments).toBe(1);
    expect(after.ledger - before.ledger).toBe(1);
    expect(after.cash - before.cash).toBe(1);

    const replay = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(payload);
    expect(replay.status).toBe(200);
    const replayBody = replay.body.data ?? replay.body;
    expect(replayBody.transaction_id).toBe(body.transaction_id);
    const afterReplay = await counts();
    expect(afterReplay).toEqual(after);

    const afterDrawer = await computeExpectedDrawer(ctx.db, shiftId, openingCash);
    expect(afterDrawer.expected_cash).toBe(15);

    await ctx.db.run("UPDATE cashier_shifts SET status = 'closed' WHERE id = ?", [shiftId]);
  });

  test("a negative recorded drawer does not block the same sale", async () => {
    const { shiftId, openingCash } = await openShift();
    expect(openingCash).toBe(0);
    await ctx.db.run(
      `INSERT INTO shift_cash_movements (shift_id, movement_type, amount, description)
       VALUES (?, 'adjustment', ?, ?)`,
      [shiftId, -20, "drawer already short"]
    );
    const beforeDrawer = await computeExpectedDrawer(ctx.db, shiftId, openingCash);
    expect(beforeDrawer.expected_cash).toBe(-20);

    const before = await counts();
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(tender20());

    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toMatch(INSUFFICIENT_DRAWER);
    const body = res.body.data ?? res.body;
    expect(body.total).toBe(15);

    const tx = await ctx.db.get("SELECT change_amount FROM transactions WHERE id = ?", [
      body.transaction_id,
    ]);
    expect(Number(tx.change_amount)).toBe(5);

    const after = await counts();
    expect(after.transactions - before.transactions).toBe(1);
    expect(after.payments - before.payments).toBe(1);
    expect(after.ledger - before.ledger).toBe(1);
    expect(after.cash - before.cash).toBe(1);

    const saleMovement = await ctx.db.get(
      "SELECT amount FROM shift_cash_movements WHERE transaction_id = ? AND movement_type = 'payment'",
      [body.transaction_id]
    );
    expect(Number(saleMovement.amount)).toBe(15);

    const afterDrawer = await computeExpectedDrawer(ctx.db, shiftId, openingCash);
    expect(afterDrawer.expected_cash).toBe(-5);
  });

  test("tender below the sale total is still rejected", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 1, price: 15 }],
        payment_method: "cash",
        payments: [{ method: "cash", original_amount: 10 }],
      }));
    expect(res.status).toBe(400);
    const message = res.body.error || res.body.data?.error || "";
    expect(message).toMatch(/أقل من إجمالي/);
    expect(message).not.toMatch(INSUFFICIENT_DRAWER);
  });
});
