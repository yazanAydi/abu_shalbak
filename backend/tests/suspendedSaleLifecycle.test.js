import request from "supertest";
import bcrypt from "bcrypt";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";

describe("Suspended sale identity lifecycle", () => {
  let ctx;
  let cashierToken;
  let otherToken;
  let cashierId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const hash = await bcrypt.hash("cashpass123", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'cashier', 0)",
      ["othercashier", hash]
    );
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    otherToken = (await login(ctx.app, "othercashier", "cashpass123", "pos")).body.token;
    cashierId = (await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'")).id;
    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({ opening_cash: 100 });
    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(otherToken)).send({ opening_cash: 50 });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  function postSuspend(token, items, extra = {}) {
    return request(ctx.app)
      .post("/api/v1/suspended-sales")
      .set(authHeader(token))
      .send({ items, ...extra });
  }

  function putSuspend(token, id, items, extra = {}) {
    return request(ctx.app)
      .put(`/api/v1/suspended-sales/${id}`)
      .set(authHeader(token))
      .send({ items, ...extra });
  }

  const line = (quantity, price = 10, productId = null) => ({
    product_id: productId || ctx.productId,
    quantity,
    price,
  });

  async function suspendedCount() {
    const row = await ctx.db.get("SELECT COUNT(*) AS c FROM suspended_sales");
    return Number(row.c);
  }

  async function activeCount() {
    const row = await ctx.db.get("SELECT COUNT(*) AS c FROM suspended_sales WHERE status = 'suspended'");
    return Number(row.c);
  }

  test("reopen, edit, and suspend again keeps one id and the latest lines", async () => {
    const txBefore = await ctx.db.get("SELECT COUNT(*) AS c FROM transactions");
    const ledgerBefore = await ctx.db.get("SELECT COUNT(*) AS c FROM inventory_ledger");
    const before = await suspendedCount();

    const created = await postSuspend(cashierToken, [line(1)], {
      note: "زبون رجع",
      idempotency_key: "suspend-cycle-key-0001",
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    const version = created.body.data.version;
    expect(version).toBe(1);
    await ctx.db.run("UPDATE suspended_sales SET created_at = ? WHERE id = ?", ["2020-01-01 00:00:00", id]);

    const extra = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock)
       VALUES ('9994411', 'Second Hold', 4, 1, 'Test', 20)`
    );
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', '9994411', 4, 1, 1, 1)`,
      [extra.lastID]
    );

    let currentVersion = version;
    const edits = [
      [line(3), line(1, 4, extra.lastID)],
      [line(2), line(2, 4, extra.lastID)],
      [line(5)],
    ];
    for (const items of edits) {
      const updated = await putSuspend(cashierToken, id, items, { version: currentVersion, note: "زبون رجع" });
      expect(updated.status).toBe(200);
      expect(updated.body.data.id).toBe(id);
      expect(updated.body.data.replayed).toBe(false);
      currentVersion = updated.body.data.version;
    }

    expect(await suspendedCount()).toBe(before + 1);
    expect(await activeCount()).toBe(1);
    const row = await ctx.db.get("SELECT * FROM suspended_sales WHERE id = ?", [id]);
    expect(row.created_at).toBe("2020-01-01 00:00:00");
    expect(row.updated_at).not.toBe("2020-01-01 00:00:00");
    expect(Number(row.version)).toBe(4);
    expect(row.status).toBe("suspended");
    const items = await ctx.db.all(
      "SELECT product_id, quantity FROM suspended_sale_items WHERE suspended_sale_id = ? ORDER BY id",
      [id]
    );
    expect(items).toEqual([{ product_id: ctx.productId, quantity: 5 }]);
    const txAfter = await ctx.db.get("SELECT COUNT(*) AS c FROM transactions");
    const ledgerAfter = await ctx.db.get("SELECT COUNT(*) AS c FROM inventory_ledger");
    expect(Number(txAfter.c)).toBe(Number(txBefore.c));
    expect(Number(ledgerAfter.c)).toBe(Number(ledgerBefore.c));

    const second = await postSuspend(cashierToken, [line(1)], {
      idempotency_key: "suspend-cycle-key-0002",
    });
    expect(second.status).toBe(201);
    expect(second.body.data.id).not.toBe(id);
    expect(await activeCount()).toBe(2);
    const firstStill = await ctx.db.get("SELECT quantity FROM suspended_sale_items WHERE suspended_sale_id = ?", [id]);
    expect(firstStill.quantity).toBe(5);
  });

  test("same idempotency key does not create a second suspended sale", async () => {
    const before = await suspendedCount();
    const key = "suspend-idem-same-key-01";
    const [a, b] = await Promise.all([
      postSuspend(cashierToken, [line(1)], { idempotency_key: key }),
      postSuspend(cashierToken, [line(1)], { idempotency_key: key }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.data.id).toBe(b.body.data.id);
    expect(await suspendedCount()).toBe(before + 1);

    const changed = await postSuspend(cashierToken, [line(4)], { idempotency_key: key });
    expect(changed.status).toBe(409);
    expect(changed.body.code || changed.body.data?.code).toBe("IDEMPOTENCY_KEY_REUSE");
    expect(await suspendedCount()).toBe(before + 1);
    const qty = await ctx.db.get(
      "SELECT quantity FROM suspended_sale_items WHERE suspended_sale_id = ?",
      [a.body.data.id]
    );
    expect(qty.quantity).toBe(1);
  });

  test("two identical carts with different keys stay separate", async () => {
    const before = await activeCount();
    const a = await postSuspend(cashierToken, [line(1)], { idempotency_key: "suspend-twin-key-aaaa" });
    const b = await postSuspend(cashierToken, [line(1)], { idempotency_key: "suspend-twin-key-bbbb" });
    expect(a.body.data.id).not.toBe(b.body.data.id);
    expect(await activeCount()).toBe(before + 2);
  });

  test("stale version does not overwrite a newer save, and an identical retry replays", async () => {
    const created = await postSuspend(cashierToken, [line(1)], { idempotency_key: "suspend-version-key-01" });
    const id = created.body.data.id;
    const first = await putSuspend(cashierToken, id, [line(2)], { version: 1 });
    expect(first.status).toBe(200);
    expect(first.body.data.version).toBe(2);

    const conflict = await putSuspend(cashierToken, id, [line(9)], { version: 1 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code || conflict.body.data?.code).toBe("SUSPENDED_VERSION_CONFLICT");
    const kept = await ctx.db.get(
      "SELECT quantity FROM suspended_sale_items WHERE suspended_sale_id = ?",
      [id]
    );
    expect(kept.quantity).toBe(2);
    expect(Number((await ctx.db.get("SELECT version FROM suspended_sales WHERE id = ?", [id])).version)).toBe(2);

    const replay = await putSuspend(cashierToken, id, [line(2)], { version: 1 });
    expect(replay.status).toBe(200);
    expect(replay.body.data.replayed).toBe(true);
    expect(replay.body.data.version).toBe(2);
    expect(
      Number((await ctx.db.get("SELECT COUNT(*) AS c FROM suspended_sales WHERE id = ?", [id])).c)
    ).toBe(1);
  });

  test("a rejected price update leaves the saved lines in place", async () => {
    const created = await postSuspend(cashierToken, [line(2)], { idempotency_key: "suspend-bad-price-key" });
    const id = created.body.data.id;
    const beforeItems = await ctx.db.all(
      "SELECT product_id, quantity, unit_price_snapshot FROM suspended_sale_items WHERE suspended_sale_id = ?",
      [id]
    );
    const bad = await putSuspend(cashierToken, id, [line(2, 99)], { version: 1 });
    expect(bad.status).toBe(409);
    const afterItems = await ctx.db.all(
      "SELECT product_id, quantity, unit_price_snapshot FROM suspended_sale_items WHERE suspended_sale_id = ?",
      [id]
    );
    expect(afterItems).toEqual(beforeItems);
  });

  test("deleted and completed holds are not recreated", async () => {
    const deleted = await postSuspend(cashierToken, [line(1)], { idempotency_key: "suspend-delete-key-001" });
    const deletedId = deleted.body.data.id;
    const del = await request(ctx.app).delete(`/api/v1/suspended-sales/${deletedId}`).set(authHeader(cashierToken));
    expect(del.status).toBe(200);
    const before = await suspendedCount();
    const again = await putSuspend(cashierToken, deletedId, [line(3)], { version: 1 });
    expect(again.status).toBe(409);
    expect(again.body.code || again.body.data?.code).toBe("SUSPENDED_DELETED");
    expect(await suspendedCount()).toBe(before);

    const done = await postSuspend(cashierToken, [line(1)], { idempotency_key: "suspend-complete-key01" });
    const doneId = done.body.data.id;
    const stockBefore = (await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock;
    const txBefore = Number((await ctx.db.get("SELECT COUNT(*) AS c FROM transactions")).c);
    const payBefore = Number((await ctx.db.get("SELECT COUNT(*) AS c FROM sale_payments")).c);
    const checkout = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({ items: [line(1)], payment_method: "cash", suspended_sale_id: doneId }));
    expect(checkout.status).toBe(201);
    expect((await ctx.db.get("SELECT status FROM suspended_sales WHERE id = ?", [doneId])).status).toBe("completed");
    const list = await request(ctx.app).get("/api/v1/suspended-sales").set(authHeader(cashierToken));
    expect(list.body.data.sales.some((row) => row.id === doneId)).toBe(false);

    const secondPay = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [line(1)],
          payment_method: "cash",
          suspended_sale_id: doneId,
        })
      );
    expect(secondPay.status).toBe(409);
    expect(secondPay.body.code || secondPay.body.data?.code).toBe("SUSPENDED_ALREADY_COMPLETED");
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS c FROM transactions")).c)).toBe(txBefore + 1);
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS c FROM sale_payments")).c)).toBe(payBefore + 1);
    expect((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock).toBe(stockBefore - 1);

    const rewrite = await putSuspend(cashierToken, doneId, [line(4)], { version: 1 });
    expect(rewrite.status).toBe(409);
    expect(rewrite.body.code || rewrite.body.data?.code).toBe("SUSPENDED_ALREADY_COMPLETED");
    expect(await suspendedCount()).toBe(before + 1);
  });

  test("another cashier cannot update the hold", async () => {
    const created = await postSuspend(cashierToken, [line(1)], { idempotency_key: "suspend-owner-key-0001" });
    const res = await putSuspend(otherToken, created.body.data.id, [line(2)], { version: 1 });
    expect(res.status).toBe(403);
    expect(res.body.code || res.body.data?.code).toBe("SUSPENDED_NOT_OWNER");
    const qty = await ctx.db.get(
      "SELECT quantity FROM suspended_sale_items WHERE suspended_sale_id = ?",
      [created.body.data.id]
    );
    expect(qty.quantity).toBe(1);
  });

  test("customer and note round-trip on the same suspended id", async () => {
    const customer = await ctx.db.run("INSERT INTO customers (name) VALUES ('زبون التعليق')");
    const created = await postSuspend(cashierToken, [line(1)], {
      idempotency_key: "suspend-customer-key01",
      customer_id: customer.lastID,
      note: "ملاحظة أولى",
    });
    const id = created.body.data.id;
    const detail = await request(ctx.app).get(`/api/v1/suspended-sales/${id}`).set(authHeader(cashierToken));
    expect(detail.body.data.customer_id).toBe(customer.lastID);
    expect(detail.body.data.note).toBe("ملاحظة أولى");
    expect(detail.body.data.version).toBe(1);

    const kept = await putSuspend(cashierToken, id, [line(2)], { version: 1 });
    expect(kept.status).toBe(200);
    const row = await ctx.db.get("SELECT customer_id, note, version FROM suspended_sales WHERE id = ?", [id]);
    expect(row.customer_id).toBe(customer.lastID);
    expect(row.note).toBe("ملاحظة أولى");
    expect(Number(row.version)).toBe(2);
  });

  test("concurrent edits of one hold keep a single row and the winning lines", async () => {
    const created = await postSuspend(cashierToken, [line(1)], { idempotency_key: "suspend-race-key-00001" });
    const id = created.body.data.id;
    const [a, b] = await Promise.all([
      putSuspend(cashierToken, id, [line(3)], { version: 1 }),
      putSuspend(cashierToken, id, [line(4)], { version: 1 }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const rows = await ctx.db.all("SELECT id, status FROM suspended_sales WHERE id = ?", [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("suspended");
    const qty = (await ctx.db.get("SELECT quantity FROM suspended_sale_items WHERE suspended_sale_id = ?", [id]))
      .quantity;
    const winner = a.status === 200 ? a : b;
    expect(qty).toBe(winner.body.data.total / 10);
    expect(Number((await ctx.db.get("SELECT version FROM suspended_sales WHERE id = ?", [id])).version)).toBe(2);
  });
});
