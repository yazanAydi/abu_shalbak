import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";
import { shopTodayYmd } from "../utils/shopTime.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("POS shortage sales and historical reprint", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let otherToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) SELECT 'othercashier', password, 'cashier', 0 FROM users WHERE username = 'testcashier'"
    );
    otherToken = (await login(ctx.app, "othercashier", "cashpass123", "pos")).body.token;
    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function zeroProduct(productId) {
    await ctx.db.run("UPDATE products SET stock = 0 WHERE id = ?", [productId]);
    await ctx.db.run("DELETE FROM warehouse_batch_stock WHERE product_id = ?", [productId]);
    await ctx.db.run("DELETE FROM stock_source_lots WHERE product_id = ?", [productId]);
    await ctx.db.run("DELETE FROM product_batches WHERE product_id = ?", [productId]);
  }

  async function sell(productId, quantity, method, extra = {}) {
    return request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: productId, quantity, price: extra.price ?? 10, unit_id: extra.unit_id }],
        payment_method: method,
        payments: extra.payments,
      }, extra.key));
  }

  test("zero stock sells 2 and records a shortage of 2", async () => {
    const productId = ctx.productId;
    await zeroProduct(productId);
    const sale = await sell(productId, 2, "visa", { key: "short-zero-2" });
    expect(sale.status).toBe(201);
    const txId = unwrap(sale.body).transaction_id;
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [productId])).stock)).toBe(-2);
    const lot = await ctx.db.get(
      `SELECT quantity, supplier_id, purchase_invoice_id, provenance, expiry_date
         FROM stock_source_lots WHERE product_id = ? AND quantity < 0`,
      [productId]
    );
    expect(Number(lot.quantity)).toBe(-2);
    expect(lot.supplier_id).toBeNull();
    expect(lot.purchase_invoice_id).toBeNull();
    expect(lot.provenance).toBe("unknown");
    expect(lot.expiry_date).toBe("");
    const ledger = await ctx.db.get(
      "SELECT SUM(quantity_delta) AS qty FROM inventory_ledger WHERE product_id = ? AND reference_type = 'transaction' AND reference_id = ?",
      [productId, txId]
    );
    expect(Number(ledger.qty)).toBe(-2);
  });

  test("eligible 1 of a sale of 3 is consumed and the other 2 are shortage", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, cost_known)
       VALUES ('9990011', 'نقص جزئي', 10, 4, 'Test', 1, 1)`
    );
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', '9990011', 10, 4, 1, 1)`,
      [ins.lastID]
    );
    const sale = await sell(ins.lastID, 3, "cash", { key: "short-partial-3" });
    expect(sale.status).toBe(201);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ins.lastID])).stock)).toBe(-2);
    const negative = await ctx.db.get(
      "SELECT quantity, supplier_id FROM stock_source_lots WHERE product_id = ? AND quantity < 0",
      [ins.lastID]
    );
    expect(Number(negative.quantity)).toBe(-2);
    expect(negative.supplier_id).toBeNull();
    const cost = await ctx.db.get(
      "SELECT unit_cost_at_sale FROM transaction_items WHERE product_id = ?",
      [ins.lastID]
    );
    expect(Number(cost.unit_cost_at_sale)).toBe(4);
  });

  test("a later purchase of 5 after selling 2 from zero leaves stock 3", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES ('9990012', 'شراء بعد نقص', 10, 2, 'Test', 0)`
    );
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', '9990012', 10, 2, 1, 1)`,
      [ins.lastID]
    );
    expect((await sell(ins.lastID, 2, "cash", { key: "short-then-buy" })).status).toBe(201);
    const supplier = await ctx.db.run(
      "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد النقص', 'S-SHORT', 0, 0)"
    );
    const created = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplier.lastID,
        invoice_date: shopTodayYmd(),
        items: [{ product_id: ins.lastID, quantity: 5, total_cost: 10 }],
      });
    expect(created.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${unwrap(created.body).id}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(posted.status).toBe(200);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ins.lastID])).stock)).toBe(3);
  });

  test("refunding 1 of a shortage sale of 2 leaves a shortage of 1", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES ('9990013', 'مرتجع نقص', 10, 2, 'Test', 0)`
    );
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', '9990013', 10, 2, 1, 1)`,
      [ins.lastID]
    );
    const sale = await sell(ins.lastID, 2, "visa", { key: "short-refund" });
    expect(sale.status).toBe(201);
    const txId = unwrap(sale.body).transaction_id;
    const created = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: txId,
        lines: [{ product_id: ins.lastID, quantity: 1 }],
        payment_method: "visa",
        reason: "shortage refund",
      });
    expect(created.status).toBe(201);
    const approved = await request(ctx.app)
      .put(`/api/v1/refund-requests/${unwrap(created.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ins.lastID])).stock)).toBe(-1);
  });

  test("a physical count of zero clears a shortage instead of adding to it", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES ('9990014', 'جرد نقص', 10, 2, 'Test', 0)`
    );
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', '9990014', 10, 2, 1, 1)`,
      [ins.lastID]
    );
    expect((await sell(ins.lastID, 2, "cash", { key: "short-count" })).status).toBe(201);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ins.lastID])).stock)).toBe(-2);
    const session = await request(ctx.app)
      .post("/api/v1/inventory/counts")
      .set(authHeader(adminToken))
      .send({ department: "retail" });
    expect(session.status).toBe(201);
    const sessionId = unwrap(session.body).id;
    const saved = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/lines`)
      .set(authHeader(adminToken))
      .send({
        product_id: ins.lastID,
        sources: [{ batch_source: "undated", expiry_date: null, counted_qty: 0 }],
      });
    expect(saved.status).toBe(200);
    const posted = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(posted.status).toBe(200);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ins.lastID])).stock)).toBe(0);
  });

  test("two lines and a double-size unit record the full shortage once", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES ('9990015', 'وحدتان', 10, 2, 'Test', 0)`
    );
    const unit = await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'علبة', '9990015', 20, 4, 2, 1)`,
      [ins.lastID]
    );
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [
          { product_id: ins.lastID, quantity: 1, price: 20, unit_id: unit.lastID },
          { product_id: ins.lastID, quantity: 1, price: 20, unit_id: unit.lastID },
        ],
        payment_method: "mixed",
        payments: [
          { method: "cash", amount: 25 },
          { method: "visa", amount: 15 },
        ],
      }, "short-units"));
    expect(sale.status).toBe(201);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ins.lastID])).stock)).toBe(-4);
    const moves = await ctx.db.get(
      "SELECT COUNT(*) AS n, SUM(quantity_delta) AS qty FROM inventory_ledger WHERE product_id = ? AND movement_type = 'sale'",
      [ins.lastID]
    );
    expect(Number(moves.n)).toBe(2);
    expect(Number(moves.qty)).toBe(-4);
  });

  test("an underpaid tender writes nothing", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES ('9990016', 'دفع ناقص', 10, 2, 'Test', 0)`
    );
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', '9990016', 10, 2, 1, 1)`,
      [ins.lastID]
    );
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: ins.lastID, quantity: 2, price: 10 }],
        payment_method: "cash",
        payments: [{ method: "cash", amount: 10 }],
      }, "short-underpay"));
    expect(sale.status).toBeGreaterThanOrEqual(400);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ins.lastID])).stock)).toBe(0);
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM transaction_items WHERE product_id = ?", [ins.lastID])).n)).toBe(0);
  });

  test("the same checkout key posts one shortage sale", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock) VALUES ('9990017', 'تكرار', 10, 2, 'Test', 0)`
    );
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', '9990017', 10, 2, 1, 1)`,
      [ins.lastID]
    );
    const body = withCheckoutKey({
      items: [{ product_id: ins.lastID, quantity: 2, price: 10 }],
      payment_method: "cash",
    }, "short-idem");
    const first = await request(ctx.app).post("/api/v1/checkout").set(authHeader(cashierToken)).send(body);
    const second = await request(ctx.app).post("/api/v1/checkout").set(authHeader(cashierToken)).send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(unwrap(second.body).transaction_id).toBe(unwrap(first.body).transaction_id);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ins.lastID])).stock)).toBe(-2);
  });

  test("a needs-reconciliation product with a negative balance still checks out", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, cost_known, location_status)
       VALUES ('9990018', 'حليب طيرة تجريبي', 8, 3, 'Test', -12, 1, 'needs_reconciliation')`
    );
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'حبة', '9990018', 8, 3, 1, 1)`,
      [ins.lastID]
    );
    const placesBefore = Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM warehouse_batch_stock WHERE product_id = ?",
      [ins.lastID]
    )).n);
    const sale = await sell(ins.lastID, 1, "cash", { price: 8, key: "recon-negative" });
    expect(sale.status).toBe(201);
    expect(unwrap(sale.body).error).toBeUndefined();
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ins.lastID])).stock)).toBe(-13);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM warehouse_batch_stock WHERE product_id = ?",
      [ins.lastID]
    )).n)).toBe(placesBefore);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM stock_source_lots WHERE product_id = ? AND supplier_id IS NOT NULL",
      [ins.lastID]
    )).n)).toBe(0);
    const buyer = await ctx.db.run(
      "INSERT INTO customers (name, customer_code, balance, opening_balance) VALUES ('مشتري مكتب', 'C-RECON', 0, 0)"
    );
    const draft = await request(ctx.app)
      .post("/api/v1/sales/invoices")
      .set(authHeader(adminToken))
      .send({
        customer_id: buyer.lastID,
        invoice_date: "2026-10-20",
        items: [{ product_id: ins.lastID, quantity: 1, total_price: 8 }],
      });
    expect(draft.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/sales/invoices/${unwrap(draft.body).id}/post`)
      .set(authHeader(adminToken))
      .send({ payment_method: "cash" });
    expect(posted.status).toBe(400);
    expect(unwrap(posted.body).error).toBe("لا توجد كمية صالحة للبيع من هذا الصنف");
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ins.lastID])).stock)).toBe(-13);
  });

  test("an unreconciled sale is one movement through retry, refund, rollback, and a later count", async () => {
    const main = await ctx.db.get("SELECT id FROM warehouses WHERE type = 'main'");
    const returnsWh = await ctx.db.get("SELECT id FROM warehouses WHERE type = 'returns'");
    let seq = 0;

    async function makeRecon(name) {
      seq += 1;
      const barcode = `999010${seq}`;
      const ins = await ctx.db.run(
        `INSERT INTO products (barcode, name, price, cost, category, stock, cost_known, location_status)
         VALUES (?, ?, 8, 3, 'Test', -12, 1, 'needs_reconciliation')`,
        [barcode, name]
      );
      await ctx.db.run(
        `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
         VALUES (?, 'حبة', ?, 8, 3, 1, 1)`,
        [ins.lastID, barcode]
      );
      await ctx.db.run(
        "INSERT INTO warehouse_stock (warehouse_id, product_id, quantity) VALUES (?, ?, 2)",
        [returnsWh.id, ins.lastID]
      );
      return ins.lastID;
    }

    async function picture(productId) {
      const product = await ctx.db.get(
        "SELECT stock, location_status FROM products WHERE id = ?",
        [productId]
      );
      const offset = await ctx.db.get(
        "SELECT quantity FROM warehouse_stock WHERE warehouse_id = ? AND product_id = ?",
        [returnsWh.id, productId]
      );
      const away = await ctx.db.get(
        "SELECT COALESCE(SUM(quantity), 0) AS qty FROM warehouse_stock WHERE product_id = ? AND warehouse_id != ?",
        [productId, main.id]
      );
      const batches = Number((await ctx.db.get(
        "SELECT COUNT(*) AS n FROM warehouse_batch_stock WHERE product_id = ?",
        [productId]
      )).n);
      const supplierLots = Number((await ctx.db.get(
        "SELECT COUNT(*) AS n FROM stock_source_lots WHERE product_id = ? AND supplier_id IS NOT NULL",
        [productId]
      )).n);
      const company = Number(product.stock);
      return {
        company,
        location_status: product.location_status,
        returnsOffset: Number(offset?.quantity) || 0,
        impliedMain: company - Number(away.qty),
        batches,
        supplierLots,
      };
    }

    const soldId = await makeRecon("بيع غير مسوّى");
    const body = withCheckoutKey({
      items: [{ product_id: soldId, quantity: 1, price: 8 }],
      payment_method: "cash",
    }, "recon-durable");
    const first = await request(ctx.app).post("/api/v1/checkout").set(authHeader(cashierToken)).send(body);
    const replay = await request(ctx.app).post("/api/v1/checkout").set(authHeader(cashierToken)).send(body);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    const sale = unwrap(first.body);
    expect(unwrap(replay.body).transaction_id).toBe(sale.transaction_id);

    let view = await picture(soldId);
    expect(view.company).toBe(-13);
    expect(view.location_status).toBe("needs_reconciliation");
    expect(view.returnsOffset).toBe(2);
    expect(view.impliedMain).toBe(-15);
    expect(view.impliedMain + view.returnsOffset).toBe(view.company);
    expect(view.batches).toBe(0);
    expect(view.supplierLots).toBe(0);

    const ledger = await ctx.db.all(
      `SELECT movement_type, quantity_delta, qty_before, qty_after, reference_type, reference_id, notes
         FROM inventory_ledger WHERE product_id = ? ORDER BY id`,
      [soldId]
    );
    expect(ledger).toEqual([
      expect.objectContaining({
        movement_type: "sale",
        quantity_delta: -1,
        qty_before: -12,
        qty_after: -13,
        reference_type: "transaction",
        reference_id: sale.transaction_id,
      }),
    ]);
    expect(String(ledger[0].notes)).toContain(sale.receipt_number);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM transactions t JOIN transaction_items ti ON ti.transaction_id = t.id WHERE ti.product_id = ?",
      [soldId]
    )).n)).toBe(1);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM sale_payments WHERE transaction_id = ?",
      [sale.transaction_id]
    )).n)).toBe(1);

    const refundReq = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: sale.transaction_id,
        lines: [{ product_id: soldId, quantity: 1 }],
        payment_method: "cash",
        reason: "إرجاع وحدة غير مسوّاة",
      });
    expect(refundReq.status).toBe(201);
    const approved = await request(ctx.app)
      .put(`/api/v1/refund-requests/${unwrap(refundReq.body).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);

    view = await picture(soldId);
    expect(view.company).toBe(-12);
    expect(view.location_status).toBe("needs_reconciliation");
    expect(view.returnsOffset).toBe(2);
    expect(view.impliedMain).toBe(-14);
    expect(view.impliedMain + view.returnsOffset).toBe(view.company);
    expect(view.batches).toBe(0);
    expect(view.supplierLots).toBe(0);
    const afterRefund = await ctx.db.all(
      `SELECT movement_type, quantity_delta, qty_before, qty_after, reference_type
         FROM inventory_ledger WHERE product_id = ? ORDER BY id`,
      [soldId]
    );
    expect(afterRefund.map((row) => row.movement_type)).toEqual(["sale", "refund"]);
    expect(afterRefund[1]).toEqual(expect.objectContaining({
      quantity_delta: 1,
      qty_before: -13,
      qty_after: -12,
      reference_type: "refund",
    }));

    const failedId = await makeRecon("بيع مرفوض");
    const failed = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: failedId, quantity: 1, price: 8 }],
        payment_method: "cash",
        payments: [{ method: "cash", amount: 1 }],
      }, "recon-rollback"));
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(await picture(failedId)).toEqual(expect.objectContaining({
      company: -12,
      location_status: "needs_reconciliation",
      returnsOffset: 2,
      impliedMain: -14,
      batches: 0,
      supplierLots: 0,
    }));
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM transaction_items WHERE product_id = ?",
      [failedId]
    )).n)).toBe(0);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM inventory_ledger WHERE product_id = ?",
      [failedId]
    )).n)).toBe(0);
    expect(Number((await ctx.db.get(
      "SELECT COUNT(*) AS n FROM sale_payments sp JOIN transaction_items ti ON ti.transaction_id = sp.transaction_id WHERE ti.product_id = ?",
      [failedId]
    )).n)).toBe(0);

    const countedId = await makeRecon("جرد بعد البيع");
    const countedSale = await sell(countedId, 1, "cash", { price: 8, key: "recon-then-count" });
    expect(countedSale.status).toBe(201);
    const countedTx = unwrap(countedSale.body).transaction_id;
    expect((await picture(countedId)).company).toBe(-13);

    const forgotten = await request(ctx.app)
      .post("/api/v1/warehouses/reconcile")
      .set(authHeader(adminToken))
      .send({
        product_id: countedId,
        lines: [
          { warehouse_id: main.id, batch_source: "undated", quantity: 0 },
          { warehouse_id: returnsWh.id, batch_source: "undated", quantity: 2 },
        ],
      });
    expect(forgotten.status).toBe(400);
    expect((await picture(countedId)).company).toBe(-13);
    expect((await picture(countedId)).location_status).toBe("needs_reconciliation");
    expect((await picture(countedId)).returnsOffset).toBe(2);
    expect((await picture(countedId)).batches).toBe(0);

    const session = await request(ctx.app)
      .post("/api/v1/inventory/counts")
      .set(authHeader(adminToken))
      .send({ notes: "جرد غير مسوّى", department: "retail" });
    expect(session.status).toBe(201);
    const sessionId = unwrap(session.body).id;
    const line = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/lines`)
      .set(authHeader(adminToken))
      .send({ product_id: countedId, counted_qty: 0 });
    expect(line.status).toBe(200);
    const saved = await ctx.db.get(
      "SELECT system_qty, counted_qty, variance FROM stock_count_lines WHERE session_id = ? AND product_id = ?",
      [sessionId, countedId]
    );
    expect(Number(saved.system_qty)).toBe(-13);
    expect(Number(saved.counted_qty)).toBe(0);
    expect(Number(saved.variance)).toBe(13);
    const postedCount = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${sessionId}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(postedCount.status).toBe(200);

    view = await picture(countedId);
    expect(view.company).toBe(0);
    expect(view.location_status).toBe("needs_reconciliation");
    expect(view.returnsOffset).toBe(2);
    expect(view.impliedMain).toBe(-2);
    expect(view.impliedMain + view.returnsOffset).toBe(view.company);
    expect(view.batches).toBe(0);
    expect(view.supplierLots).toBe(0);
    const countedLedger = await ctx.db.all(
      `SELECT movement_type, quantity_delta, qty_before, qty_after, reference_type, reference_id
         FROM inventory_ledger WHERE product_id = ? ORDER BY id`,
      [countedId]
    );
    expect(countedLedger).toEqual([
      expect.objectContaining({
        movement_type: "sale",
        quantity_delta: -1,
        qty_before: -12,
        qty_after: -13,
        reference_type: "transaction",
        reference_id: countedTx,
      }),
      expect.objectContaining({
        movement_type: "stock_count_correction",
        quantity_delta: 13,
        qty_before: -13,
        qty_after: 0,
        reference_type: "stock_count_session",
        reference_id: sessionId,
      }),
    ]);
  });

  test("reprint uses the saved invoice and rejects another cashier", async () => {
    await ctx.db.run("UPDATE products SET price = 99, cost = 80 WHERE id = ?", [ctx.productId]);
    const tx = await ctx.db.get(
      "SELECT id, receipt_number, total, created_at FROM transactions WHERE payment_method = 'visa' ORDER BY id LIMIT 1"
    );
    const beforeTx = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM transactions")).n);
    const beforeStock = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock);
    const beforePays = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM sale_payments")).n);
    const printed = await request(ctx.app)
      .post("/api/v1/print-receipt")
      .set(authHeader(cashierToken))
      .send({ transaction_id: tx.id, reprint: true });
    expect(printed.status).toBe(200);
    const html = unwrap(printed.body).receipt_html;
    expect(html).toContain("إعادة طباعة");
    expect(html).toContain(tx.receipt_number);
    expect(html).not.toContain("99.00");
    const denied = await request(ctx.app)
      .post("/api/v1/print-receipt")
      .set(authHeader(otherToken))
      .send({ transaction_id: tx.id, reprint: true });
    expect(denied.status).toBe(403);
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM transactions")).n)).toBe(beforeTx);
    expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock)).toBe(beforeStock);
    expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM sale_payments")).n)).toBe(beforePays);
    const shift = await ctx.db.get("SELECT status FROM cashier_shifts ORDER BY id DESC LIMIT 1");
    expect(shift.status).toBe("open");
  });
});
