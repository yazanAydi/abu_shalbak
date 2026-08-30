import request from "supertest";
import { authHeader } from "../helpers.js";
import {
  setupLoadContext,
  teardownLoadContext,
  captureBaseline,
  runAndCheckInvariants,
  checkout,
  checkoutBody,
  unwrap,
  uniqueKey,
  envelopeCode,
  diagnoseHttp,
} from "./harness.js";

function putProduct(app, token, product, patch) {
  return request(app)
    .put(`/api/v1/products/${product.id}`)
    .set(authHeader(token))
    .send(patch);
}

function putProductStaleFull(app, token, snapshot, patch = {}) {
  return request(app)
    .put(`/api/v1/products/${snapshot.id}`)
    .set(authHeader(token))
    .send({
      barcode: snapshot.barcode,
      name: snapshot.name,
      price: Number(snapshot.price),
      cost: Number(snapshot.cost) || 5,
      stock: Number(snapshot.stock),
      category: snapshot.category || "Test",
      ...patch,
    });
}

describe("C5/C6/C15d product and party edits", () => {
  let h;

  beforeEach(async () => {
    h = await setupLoadContext({ extraProducts: 1 });
  });

  afterEach(async () => {
    await teardownLoadContext(h);
  });

  test("C5: concurrent metadata PUTs of different fields all survive", async () => {
    const product = await h.db.get("SELECT * FROM products WHERE id = ?", [h.productId]);
    const wanted = {
      name: "NameFromEditorA",
      price: 99.5,
      min_stock: 7,
      category: "CatFromEditorD",
    };

    const results = await Promise.all([
      putProduct(h.app, h.adminToken, product, { name: wanted.name }),
      putProduct(h.app, h.adminToken, product, { price: wanted.price, reason: "load C5" }),
      putProduct(h.app, h.adminToken, product, { min_stock: wanted.min_stock }),
      putProduct(h.app, h.adminToken, product, { category: wanted.category }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);

    const row = await h.db.get("SELECT name, price, min_stock, category, stock FROM products WHERE id = ?", [
      h.productId,
    ]);
    expect(row.name).toBe(wanted.name);
    expect(Number(row.price)).toBe(wanted.price);
    expect(Number(row.min_stock)).toBe(wanted.min_stock);
    expect(row.category).toBe(wanted.category);
    expect(Number(row.stock)).toBe(Number(product.stock));
  }, 20000);

  test("C5 stock: stale full-row PUT cannot clobber a concurrent checkout decrement", async () => {
    await h.db.run("UPDATE products SET stock = 100 WHERE id = ?", [h.productId]);
    const snapshot = await h.db.get("SELECT * FROM products WHERE id = ?", [h.productId]);
    const baseline = await captureBaseline(h.db);
    const price = Number(snapshot.price);

    const [sale, edit] = await Promise.all([
      checkout(
        h.app,
        h.cashierToken,
        checkoutBody({
          productId: h.productId,
          price,
          extra: { idempotency_key: uniqueKey("c5-stock-sale") },
        })
      ),
      putProductStaleFull(h.app, h.adminToken, snapshot, { name: "Edited After Sale", reason: "C5 stock" }),
    ]);

    expect(sale.status).toBe(201);
    expect(edit.status).toBe(200);

    const row = await h.db.get("SELECT name, stock FROM products WHERE id = ?", [h.productId]);
    expect(row.name).toBe("Edited After Sale");
    expect(Number(row.stock)).toBe(99);

    await runAndCheckInvariants(h.db, baseline, {
      receiptsFromResponses: [unwrap(sale).receipt_number],
      successfulCheckouts: 1,
    });
  }, 20000);

  test("C5 stock: PUT body stock is ignored even when it is the only write", async () => {
    await h.db.run("UPDATE products SET stock = 40 WHERE id = ?", [h.productId]);
    const before = await h.db.get("SELECT * FROM products WHERE id = ?", [h.productId]);

    const res = await putProductStaleFull(h.app, h.adminToken, { ...before, stock: 999 }, { name: before.name });
    expect(res.status).toBe(200);

    const after = await h.db.get("SELECT stock, name FROM products WHERE id = ?", [h.productId]);
    expect(Number(after.stock)).toBe(40);
    expect(after.name).toBe(before.name);
  }, 20000);

  test("C6: price edit during checkout yields 201 or PRICE_MISMATCH, never 5xx", async () => {
    const product = await h.db.get("SELECT * FROM products WHERE id = ?", [h.productId]);
    const baseline = await captureBaseline(h.db);

    const checkouts = Array.from({ length: 12 }, (_, i) =>
      checkout(
        h.app,
        h.cashierToken,
        checkoutBody({
          productId: h.productId,
          price: Number(product.price),
          extra: { idempotency_key: uniqueKey(`c6-${i}`) },
        })
      )
    );
    const edits = Array.from({ length: 6 }, (_, i) =>
      request(h.app)
        .post(`/api/v1/products/${h.productId}/change-price`)
        .set(authHeader(h.adminToken))
        .send({ new_price: Number(product.price) + 1 + i * 0.1, reason: `C6 price ${i}` })
    );

    const results = await Promise.all([...checkouts, ...edits]);
    const checkoutRes = results.slice(0, 12);
    const editRes = results.slice(12);

    const badCheckout = checkoutRes.filter((r) => r.status !== 201 && r.status !== 409);
    expect(badCheckout.map((r) => diagnoseHttp("checkout", r))).toEqual([]);
    expect(checkoutRes.every((r) => r.status < 500)).toBe(true);
    expect(editRes.every((r) => r.status < 500)).toBe(true);

    const mismatches = checkoutRes.filter((r) => r.status === 409);
    expect(mismatches.every((r) => envelopeCode(r) === "PRICE_MISMATCH")).toBe(true);

    const ok = checkoutRes.filter((r) => r.status === 201);
    for (const r of ok) {
      const tx = await h.db.get("SELECT id FROM transactions WHERE receipt_number = ?", [
        unwrap(r).receipt_number,
      ]);
      expect(tx).toBeTruthy();
    }

    await runAndCheckInvariants(h.db, baseline, {
      receiptsFromResponses: ok.map((r) => unwrap(r).receipt_number),
      successfulCheckouts: ok.length,
    });
  }, 30000);

  test(
    "C15d: concurrent customer field edits all survive",
    async () => {
      const custRes = await request(h.app)
        .post("/api/v1/customers")
        .set(authHeader(h.adminToken))
        .send({ name: "Edit Me", phone: "0591111111", credit_limit: 100 });
      expect(custRes.status).toBe(201);
      const id = unwrap(custRes).id;

      const results = await Promise.all([
        request(h.app).put(`/api/v1/customers/${id}`).set(authHeader(h.adminToken)).send({ name: "NameA" }),
        request(h.app).put(`/api/v1/customers/${id}`).set(authHeader(h.adminToken)).send({ phone: "0592222222" }),
        request(h.app).put(`/api/v1/customers/${id}`).set(authHeader(h.adminToken)).send({ credit_limit: 250 }),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);

      const row = await h.db.get("SELECT name, phone, credit_limit FROM customers WHERE id = ?", [id]);
      expect(row.name).toBe("NameA");
      expect(row.phone).toBe("0592222222");
      expect(Number(row.credit_limit)).toBe(250);
    },
    20000
  );

  test("C15d: stale full-row PUT cannot overwrite current balance", async () => {
    const created = await request(h.app)
      .post("/api/v1/customers")
      .set(authHeader(h.adminToken))
      .send({ name: "Bal Cust", phone: "0590000001", credit_limit: 500, opening_balance: 100 });
    expect(created.status).toBe(201);
    const id = unwrap(created).id;
    const snapshot = await h.db.get("SELECT * FROM customers WHERE id = ?", [id]);
    expect(Number(snapshot.balance)).toBe(100);

    await h.db.run("UPDATE customers SET balance = balance + 40 WHERE id = ?", [id]);

    const res = await request(h.app)
      .put(`/api/v1/customers/${id}`)
      .set(authHeader(h.adminToken))
      .send({
        name: snapshot.name,
        phone: snapshot.phone,
        phone2: snapshot.phone2,
        address: snapshot.address,
        city: snapshot.city,
        price_category: snapshot.price_category,
        credit_limit: snapshot.credit_limit,
        no_credit: snapshot.no_credit,
        notes: snapshot.notes,
        customer_code: snapshot.customer_code,
        payment_terms: snapshot.payment_terms,
        opening_balance: snapshot.opening_balance,
        balance: snapshot.balance,
        balance_group_id: snapshot.balance_group_id,
      });
    expect(res.status).toBe(200);

    const after = await h.db.get("SELECT balance, opening_balance, name FROM customers WHERE id = ?", [id]);
    expect(Number(after.balance)).toBe(140);
    expect(Number(after.opening_balance)).toBe(100);
    expect(after.name).toBe("Bal Cust");
  }, 20000);

  test("C15d: metadata PUT concurrent with payment cannot lose the balance update", async () => {
    const created = await request(h.app)
      .post("/api/v1/customers")
      .set(authHeader(h.adminToken))
      .send({ name: "Pay Race", credit_limit: 500, opening_balance: 80 });
    expect(created.status).toBe(201);
    const id = unwrap(created).id;
    const snapshot = await h.db.get("SELECT * FROM customers WHERE id = ?", [id]);

    const [edit, pay] = await Promise.all([
      request(h.app)
        .put(`/api/v1/customers/${id}`)
        .set(authHeader(h.adminToken))
        .send({
          name: "Pay Race Edited",
          phone: snapshot.phone,
          credit_limit: snapshot.credit_limit,
          opening_balance: snapshot.opening_balance,
          balance: snapshot.balance,
        }),
      request(h.app)
        .post(`/api/v1/customers/${id}/payment`)
        .set(authHeader(h.adminToken))
        .send({ amount: 30 }),
    ]);
    expect(edit.status).toBe(200);
    expect(pay.status).toBe(200);

    const after = await h.db.get("SELECT name, balance FROM customers WHERE id = ?", [id]);
    expect(after.name).toBe("Pay Race Edited");
    expect(Number(after.balance)).toBe(50);
  }, 20000);

  test("C15d: PUT without credit_limit or no_credit leaves those settings intact", async () => {
    const created = await request(h.app)
      .post("/api/v1/customers")
      .set(authHeader(h.adminToken))
      .send({ name: "Flags", credit_limit: 100 });
    const id = unwrap(created).id;

    const flag = await request(h.app)
      .put(`/api/v1/customers/${id}`)
      .set(authHeader(h.adminToken))
      .send({ no_credit: true, credit_limit: 175 });
    expect(flag.status).toBe(200);

    const rename = await request(h.app)
      .put(`/api/v1/customers/${id}`)
      .set(authHeader(h.adminToken))
      .send({ name: "Flags Renamed", notes: "office note" });
    expect(rename.status).toBe(200);

    const row = await h.db.get("SELECT name, notes, credit_limit, no_credit, balance FROM customers WHERE id = ?", [
      id,
    ]);
    expect(row.name).toBe("Flags Renamed");
    expect(row.notes).toBe("office note");
    expect(Number(row.credit_limit)).toBe(175);
    expect(Number(row.no_credit)).toBe(1);
    expect(Number(row.balance)).toBe(0);

    const clear = await request(h.app)
      .put(`/api/v1/customers/${id}`)
      .set(authHeader(h.adminToken))
      .send({ no_credit: false });
    expect(clear.status).toBe(200);
    const after = await h.db.get("SELECT no_credit, credit_limit FROM customers WHERE id = ?", [id]);
    expect(Number(after.no_credit)).toBe(0);
    expect(Number(after.credit_limit)).toBe(175);
  }, 20000);

  test("C15d: different customers can update concurrently", async () => {
    const a = await request(h.app)
      .post("/api/v1/customers")
      .set(authHeader(h.adminToken))
      .send({ name: "CustA", phone: "0591000001", credit_limit: 10 });
    const b = await request(h.app)
      .post("/api/v1/customers")
      .set(authHeader(h.adminToken))
      .send({ name: "CustB", phone: "0591000002", credit_limit: 20 });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const idA = unwrap(a).id;
    const idB = unwrap(b).id;

    const results = await Promise.all([
      request(h.app).put(`/api/v1/customers/${idA}`).set(authHeader(h.adminToken)).send({ name: "CustA2" }),
      request(h.app).put(`/api/v1/customers/${idB}`).set(authHeader(h.adminToken)).send({ name: "CustB2" }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);

    const rowA = await h.db.get("SELECT name, phone, credit_limit FROM customers WHERE id = ?", [idA]);
    const rowB = await h.db.get("SELECT name, phone, credit_limit FROM customers WHERE id = ?", [idB]);
    expect(rowA.name).toBe("CustA2");
    expect(rowA.phone).toBe("0591000001");
    expect(Number(rowA.credit_limit)).toBe(10);
    expect(rowB.name).toBe("CustB2");
    expect(rowB.phone).toBe("0591000002");
    expect(Number(rowB.credit_limit)).toBe(20);
  }, 20000);
});
