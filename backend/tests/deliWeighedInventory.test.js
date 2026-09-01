import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { buildBarcodeLookupResponse } from "../utils/productUnitLookup.js";

describe("deli dual-sale weighed inventory", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let supplierId;
  let productA;
  let productB;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
    const sup = await ctx.db.run("INSERT INTO suppliers (name) VALUES ('مورد ميزان')");
    supplierId = sup.lastID;
    productA = await createDeliProduct({
      barcode: "6251234567890",
      name: "مرتديلا شركة A",
      sku: "9001",
      scale_code: "2100003",
      price: 25,
      cost: 10,
      package_conversion: 2,
      package_price: 40,
    });
    productB = await createDeliProduct({
      barcode: "6259876543210",
      name: "مرتديلا شركة B",
      sku: "9002",
      scale_code: "2100004",
      price: 28,
      cost: 12,
      package_conversion: 1.5,
      package_price: 35,
    });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  function unwrap(res) {
    return res.body?.data ?? res.body;
  }

  async function createDeliProduct(body) {
    const res = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        stock: 0,
        is_weighed: true,
        ...body,
      });
    expect(res.status).toBe(201);
    const row = unwrap(res);
    const unitsRes = await request(ctx.app)
      .get(`/api/v1/products/${row.id}/units`)
      .set(authHeader(adminToken));
    const units = unwrap(unitsRes).units;
    return {
      ...row,
      kgUnit: units.find((u) => u.unit_name === "كغم"),
      packUnit: units.find((u) => u.unit_name === "حبة"),
    };
  }

  async function stockOf(productId) {
    const row = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [productId]);
    return Number(row.stock);
  }

  async function receivePackages(product, quantity, totalCost) {
    const create = await request(ctx.app)
      .post("/api/purchases/invoices")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        items: [
          {
            product_id: product.id,
            unit_id: product.packUnit.id,
            quantity,
            total_cost: totalCost,
          },
        ],
      });
    expect(create.status).toBe(201);
    const invoiceId = unwrap(create).id;
    const post = await request(ctx.app)
      .post(`/api/purchases/invoices/${invoiceId}/post`)
      .set(authHeader(adminToken))
      .send({});
    expect(post.status).toBe(200);
    return invoiceId;
  }

  async function checkoutLines(items, extra = {}) {
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        payment_method: "cash",
        items,
        ...extra,
      });
    return res;
  }

  async function approveRefund(transactionId, lines) {
    const createRes = await request(ctx.app)
      .post("/api/v1/refunds")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: transactionId,
        lines,
        reason: "deli refund test",
        payment_method: "cash",
      });
    expect(createRes.status).toBe(201);
    const requestId = unwrap(createRes).request_id;
    const approveRes = await request(ctx.app)
      .put(`/api/v1/refund-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approveRes.status).toBe(200);
    return requestId;
  }

  test("1. supplier receiving 4 حبة × 2 KG adds 8 KG", async () => {
    const invoiceId = await receivePackages(productA, 4, 80);
    expect(await stockOf(productA.id)).toBeCloseTo(8, 3);

    const line = await ctx.db.get(
      "SELECT * FROM purchase_invoice_items WHERE invoice_id = ? AND product_id = ?",
      [invoiceId, productA.id]
    );
    expect(Number(line.quantity)).toBe(4);
    expect(Number(line.conversion_used)).toBe(2);
    expect(Number(line.base_quantity)).toBeCloseTo(8, 3);

    const ledger = await ctx.db.get(
      `SELECT * FROM inventory_ledger
       WHERE product_id = ? AND movement_type = 'purchase_receive'
       ORDER BY id DESC LIMIT 1`,
      [productA.id]
    );
    expect(Number(ledger.quantity_delta)).toBeCloseTo(8, 3);
  });

  test("2. deli sale of 0.500 KG leaves 7.500", async () => {
    const before = await stockOf(productA.id);
    const res = await checkoutLines([
      {
        product_id: productA.id,
        unit_id: productA.kgUnit.id,
        quantity: 0.5,
        price: 25,
        scanned_barcode: "2100003005004",
      },
    ]);
    expect(res.status).toBe(201);
    expect(unwrap(res).total).toBe(13);
    expect(await stockOf(productA.id)).toBeCloseTo(before - 0.5, 3);
  });

  test("2b. 0.93 KG × 6 ₪ charges 6 and deducts 0.93 KG", async () => {
    const p = await createDeliProduct({
      barcode: "6250000000093",
      name: "جبنة تقريب",
      scale_code: "2100293",
      price: 6,
      package_conversion: 2,
      package_price: 12,
    });
    await ctx.db.run("UPDATE products SET stock = 8 WHERE id = ?", [p.id]);
    const res = await checkoutLines([
      {
        product_id: p.id,
        unit_id: p.kgUnit.id,
        quantity: 0.93,
        price: 6,
        scanned_barcode: "2100293009304",
      },
    ]);
    expect(res.status).toBe(201);
    const body = unwrap(res);
    expect(body.total).toBe(6);
    const item = await ctx.db.get(
      "SELECT quantity, unit_price, line_gross, unit_name FROM transaction_items WHERE transaction_id = ?",
      [body.transaction_id]
    );
    expect(item.unit_name).toBe("كغم");
    expect(Number(item.unit_price)).toBe(6);
    expect(Number(item.quantity)).toBeCloseTo(0.93, 3);
    expect(Number(item.line_gross)).toBe(6);
    expect(await stockOf(p.id)).toBeCloseTo(7.07, 3);
  });

  test("3. whole package sale of 1 حبة deducts 2 KG", async () => {
    const before = await stockOf(productA.id);
    const res = await checkoutLines([
      {
        product_id: productA.id,
        unit_id: productA.packUnit.id,
        quantity: 1,
        price: productA.packUnit.price,
        scanned_barcode: productA.barcode,
      },
    ]);
    expect(res.status).toBe(201);
    const txId = unwrap(res).transaction_id;
    const item = await ctx.db.get(
      "SELECT * FROM transaction_items WHERE transaction_id = ?",
      [txId]
    );
    expect(item.unit_name).toBe("حبة");
    expect(Number(item.quantity)).toBe(1);
    expect(Number(item.conversion_to_base)).toBe(2);
    expect(await stockOf(productA.id)).toBeCloseTo(before - 2, 3);
  });

  test("4. combined start 8 KG, sell 0.500 then 1 package → 5.500", async () => {
    const isolated = await createDeliProduct({
      barcode: "6250000000001",
      name: "مرتديلا اختبار مدمج",
      scale_code: "2100099",
      price: 25,
      cost: 10,
      package_conversion: 2,
      package_price: 40,
    });
    await receivePackages(isolated, 4, 80);
    expect(await stockOf(isolated.id)).toBeCloseTo(8, 3);

    const deli = await checkoutLines([
      {
        product_id: isolated.id,
        unit_id: isolated.kgUnit.id,
        quantity: 0.5,
        price: 25,
      },
    ]);
    expect(deli.status).toBe(201);
    const pack = await checkoutLines([
      {
        product_id: isolated.id,
        unit_id: isolated.packUnit.id,
        quantity: 1,
        price: isolated.packUnit.price,
      },
    ]);
    expect(pack.status).toBe(201);
    expect(await stockOf(isolated.id)).toBeCloseTo(5.5, 3);
  });

  test("5. different product conversions deduct independently", async () => {
    await receivePackages(productB, 2, 42);
    const beforeA = await stockOf(productA.id);
    const beforeB = await stockOf(productB.id);

    const res = await checkoutLines([
      {
        product_id: productA.id,
        unit_id: productA.packUnit.id,
        quantity: 1,
        price: productA.packUnit.price,
      },
      {
        product_id: productB.id,
        unit_id: productB.packUnit.id,
        quantity: 1,
        price: productB.packUnit.price,
      },
    ]);
    expect(res.status).toBe(201);
    expect(await stockOf(productA.id)).toBeCloseTo(beforeA - 2, 3);
    expect(await stockOf(productB.id)).toBeCloseTo(beforeB - 1.5, 3);
  });

  test("6. package and scale scans resolve to the correct product", async () => {
    const aPack = await buildBarcodeLookupResponse(ctx.db, "6251234567890");
    expect(aPack.product.id).toBe(productA.id);
    expect(aPack.weighed).toBeUndefined();
    expect(aPack.unit_name).toBe("حبة");
    expect(Number(aPack.conversion_to_base)).toBe(2);

    const bPack = await buildBarcodeLookupResponse(ctx.db, "6259876543210");
    expect(bPack.product.id).toBe(productB.id);
    expect(bPack.unit_name).toBe("حبة");
    expect(Number(bPack.conversion_to_base)).toBe(1.5);

    const aScale = await buildBarcodeLookupResponse(ctx.db, "2100003");
    expect(aScale.product.id).toBe(productA.id);
    expect(bPack.product.id).not.toBe(aScale.product.id);
  });

  test("7. scale barcode resolves product A and extracts 1.550 KG", async () => {
    const payload = await buildBarcodeLookupResponse(ctx.db, "2100003015504");
    expect(payload).not.toBeNull();
    expect(payload.weighed).toBe(true);
    expect(payload.weight).toBeCloseTo(1.55, 3);
    expect(payload.quantity).toBeCloseTo(1.55, 3);
    expect(payload.product.id).toBe(productA.id);
    expect(payload.unit_name).toBe("كغم");
    expect(Number(payload.conversion_to_base)).toBe(1);
    expect(payload.price).toBe(25);
  });

  test("8. exact 13-digit barcode starting with 21 wins over weight parsing", async () => {
    const exact = "2100003999999";
    await request(ctx.app)
      .post(`/api/v1/products/${productA.id}/barcodes`)
      .set(authHeader(adminToken))
      .send({ barcode: exact, label: "باركود كامل 21" });

    const payload = await buildBarcodeLookupResponse(ctx.db, exact);
    expect(payload).not.toBeNull();
    expect(payload.weighed).toBeUndefined();
    expect(payload.product.id).toBe(productA.id);
  });

  test("9. refund of 0.500 KG restores +0.500 KG", async () => {
    const before = await stockOf(productA.id);
    const sale = await checkoutLines([
      {
        product_id: productA.id,
        unit_id: productA.kgUnit.id,
        quantity: 0.5,
        price: 25,
      },
    ]);
    expect(sale.status).toBe(201);
    const txId = unwrap(sale).transaction_id;
    await approveRefund(txId, [
      { product_id: productA.id, unit_id: productA.kgUnit.id, quantity: 0.5 },
    ]);
    expect(await stockOf(productA.id)).toBeCloseTo(before, 3);
  });

  test("10. refund of 1 حبة restores +2 KG", async () => {
    const before = await stockOf(productA.id);
    const sale = await checkoutLines([
      {
        product_id: productA.id,
        unit_id: productA.packUnit.id,
        quantity: 1,
        price: productA.packUnit.price,
      },
    ]);
    expect(sale.status).toBe(201);
    await approveRefund(unwrap(sale).transaction_id, [
      { product_id: productA.id, unit_id: productA.packUnit.id, quantity: 1 },
    ]);
    expect(await stockOf(productA.id)).toBeCloseTo(before, 3);
  });

  test("11. SKU is not used as barcode or scale code", async () => {
    expect(productA.sku).toBe("9001");
    expect(productA.sku).not.toBe(productA.barcode);
    expect(productA.sku).not.toBe(productA.scale_code);

    const bySku = await request(ctx.app)
      .get("/api/v1/products/lookup")
      .query({ barcode: productA.sku })
      .set(authHeader(adminToken));
    expect(bySku.status).toBe(200);
    expect(unwrap(bySku).found).toBe(false);
  });

  test("12. checkout idempotency still replays the same transaction", async () => {
    const key = `deli-idemp-${Date.now()}`;
    const body = {
      product_id: productA.id,
      unit_id: productA.kgUnit.id,
      quantity: 0.25,
      price: 25,
    };
    const first = await checkoutLines([body], { idempotency_key: key });
    expect(first.status).toBe(201);
    const firstTx = unwrap(first).transaction_id;
    const second = await checkoutLines([body], { idempotency_key: key });
    expect(second.status).toBe(200);
    expect(unwrap(second).idempotent_replay).toBe(true);
    expect(unwrap(second).transaction_id).toBe(firstTx);
    const n = await ctx.db.get(
      "SELECT COUNT(*) AS c FROM transactions WHERE idempotency_key = ?",
      [key]
    );
    expect(Number(n.c)).toBe(1);
  });

  test("13. concurrent checkouts keep stock consistent", async () => {
    const isolated = await createDeliProduct({
      barcode: "6250000000002",
      name: "مرتديلا تزامن",
      scale_code: "2100088",
      price: 25,
      cost: 10,
      package_conversion: 2,
      package_price: 40,
    });
    await ctx.db.run("UPDATE products SET stock = 10 WHERE id = ?", [isolated.id]);
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        checkoutLines(
          [
            {
              product_id: isolated.id,
              unit_id: isolated.kgUnit.id,
              quantity: 0.5,
              price: 25,
            },
          ],
          { idempotency_key: `deli-conc-${Date.now()}-${i}` }
        )
      )
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await stockOf(isolated.id)).toBeCloseTo(10 - N * 0.5, 3);
  });

  test("14. package selling price is independent of KG price", async () => {
    const mortadella = await createDeliProduct({
      barcode: "6251111111111",
      name: "مرتديلا سعر مستقل",
      scale_code: "2100077",
      price: 6,
      cost: 3,
      package_conversion: 1,
      package_price: 12,
    });
    expect(Number(mortadella.price)).toBe(6);
    expect(Number(mortadella.package_price)).toBe(12);
    expect(Number(mortadella.kgUnit.price)).toBe(6);
    expect(Number(mortadella.packUnit.price)).toBe(12);
    expect(Number(mortadella.packUnit.conversion_to_base)).toBe(1);
    expect(Number(mortadella.packUnit.price)).not.toBe(
      Number(mortadella.kgUnit.price) * Number(mortadella.packUnit.conversion_to_base)
    );

    await ctx.db.run("UPDATE products SET stock = 10 WHERE id = ?", [mortadella.id]);

    const packSale = await checkoutLines([
      {
        product_id: mortadella.id,
        unit_id: mortadella.packUnit.id,
        quantity: 1,
        price: 12,
      },
    ]);
    expect(packSale.status).toBe(201);
    expect(unwrap(packSale).total).toBeCloseTo(12, 2);
    expect(await stockOf(mortadella.id)).toBeCloseTo(9, 3);

    const deliSale = await checkoutLines([
      {
        product_id: mortadella.id,
        unit_id: mortadella.kgUnit.id,
        quantity: 0.5,
        price: 6,
      },
    ]);
    expect(deliSale.status).toBe(201);
    expect(unwrap(deliSale).total).toBeCloseTo(3, 2);
    expect(await stockOf(mortadella.id)).toBeCloseTo(8.5, 3);

    const pack2 = await createDeliProduct({
      barcode: "6252222222222",
      name: "مرتديلا 2 كغم سعر مستقل",
      scale_code: "2100078",
      price: 6,
      package_conversion: 2,
      package_price: 24,
    });
    expect(Number(pack2.packUnit.price)).toBe(24);
    expect(Number(pack2.kgUnit.price)).toBe(6);
    await ctx.db.run("UPDATE products SET stock = 10 WHERE id = ?", [pack2.id]);

    const whole = await checkoutLines([
      {
        product_id: pack2.id,
        unit_id: pack2.packUnit.id,
        quantity: 1,
        price: 24,
      },
    ]);
    expect(whole.status).toBe(201);
    expect(unwrap(whole).total).toBeCloseTo(24, 2);
    expect(await stockOf(pack2.id)).toBeCloseTo(8, 3);

    const halfKg = await checkoutLines([
      {
        product_id: pack2.id,
        unit_id: pack2.kgUnit.id,
        quantity: 0.5,
        price: 6,
      },
    ]);
    expect(halfKg.status).toBe(201);
    expect(unwrap(halfKg).total).toBeCloseTo(3, 2);
    expect(await stockOf(pack2.id)).toBeCloseTo(7.5, 3);

    const putKg = await request(ctx.app)
      .put(`/api/v1/products/${mortadella.id}`)
      .set(authHeader(adminToken))
      .send({ price: 7 });
    expect(putKg.status).toBe(200);
    expect(Number(unwrap(putKg).price)).toBe(7);
    expect(Number(unwrap(putKg).package_price)).toBe(12);
    const unitsAfterKg = unwrap(
      await request(ctx.app)
        .get(`/api/v1/products/${mortadella.id}/units`)
        .set(authHeader(adminToken))
    ).units;
    expect(Number(unitsAfterKg.find((u) => u.unit_name === "كغم").price)).toBe(7);
    expect(Number(unitsAfterKg.find((u) => u.unit_name === "حبة").price)).toBe(12);

    const putPack = await request(ctx.app)
      .put(`/api/v1/products/${mortadella.id}`)
      .set(authHeader(adminToken))
      .send({ package_conversion: 1, package_price: 15 });
    expect(putPack.status).toBe(200);
    expect(Number(unwrap(putPack).package_price)).toBe(15);
    expect(Number(unwrap(putPack).price)).toBe(7);
  });

  test("15. scale lookup uses KG price, not package price", async () => {
    const mortadella = await createDeliProduct({
      barcode: "6254444444444",
      name: "مرتديلا ميزان سعر مستقل",
      scale_code: "2100076",
      price: 6,
      package_conversion: 1,
      package_price: 12,
    });
    const scale = await buildBarcodeLookupResponse(ctx.db, "2100076002554");
    expect(scale).not.toBeNull();
    expect(scale.weighed).toBe(true);
    expect(scale.weight).toBeCloseTo(0.255, 3);
    expect(scale.unit_name).toBe("كغم");
    expect(Number(scale.price)).toBe(6);
    expect(Number(scale.selectedUnit.price)).toBe(6);
    expect(scale.selectedUnit.unit_name).toBe("كغم");
    expect(Number(scale.selectedUnit.price)).not.toBe(12);

    const packLookup = await buildBarcodeLookupResponse(ctx.db, mortadella.barcode);
    expect(packLookup.weighed).toBeUndefined();
    expect(packLookup.unit_name).toBe("حبة");
    expect(Number(packLookup.price)).toBe(12);

    await ctx.db.run("UPDATE products SET stock = 10 WHERE id = ?", [mortadella.id]);
    const fracPack = await checkoutLines([
      {
        product_id: mortadella.id,
        unit_id: mortadella.packUnit.id,
        quantity: 0.255,
        price: 12,
      },
    ]);
    expect(fracPack.status).toBe(400);
    expect(fracPack.body.code || unwrap(fracPack).code).toBe("INVALID_PACKAGE_QTY");
  });

  test("16. Type A scale barcode uses KG price and a single unit", async () => {
    const cheese = await createDeliProduct({
      barcode: "6255555555555",
      name: "جبنة بيضاء ميزان",
      scale_code: "2100091",
      price: 20,
    });
    expect(cheese.packUnit).toBeUndefined();
    const units = unwrap(
      await request(ctx.app).get(`/api/v1/products/${cheese.id}/units`).set(authHeader(adminToken))
    ).units;
    expect(units.filter((u) => u.sale_enabled !== false).map((u) => u.unit_name)).toEqual(["كغم"]);

    const scale = await buildBarcodeLookupResponse(ctx.db, "2100091002554");
    expect(scale).not.toBeNull();
    expect(scale.weighed).toBe(true);
    expect(scale.weight).toBeCloseTo(0.255, 3);
    expect(scale.unit_name).toBe("كغم");
    expect(Number(scale.price)).toBe(20);
    expect(scale.availableUnits.length).toBe(1);
  });
});
