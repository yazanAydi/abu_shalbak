import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { upsertProductUnit } from "../utils/productUnits.js";

function unwrap(res) {
  return res.body?.data ?? res.body;
}

describe("warehouse supermarket stock and purchase returns", () => {
  let ctx;
  let adminToken;
  let productId;
  let bakeryProductId;
  let pieceId;
  let supplierId;
  let mainWarehouse;
  let returnsWarehouse;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    productId = ctx.productId;

    const bakery = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, inventory_scope, sku)
       VALUES ('8811990001', 'طحين مخبز', 8, 3, 'مواد', 40, 'bakery', '88001')`
    );
    bakeryProductId = bakery.lastID;
    await ctx.db.run("UPDATE products SET sku = ? WHERE id = ?", ["4242", productId]);

    const bakeryUnit = await upsertProductUnit(ctx.db, bakeryProductId, {
      unit_name: "كغم",
      barcode: "8811990001",
      price: 8,
      cost: 3,
      conversion_to_base: 1,
      is_default: true,
    });
    ctx.bakeryUnitId = bakeryUnit.id;

    const piece = await upsertProductUnit(ctx.db, productId, {
      unit_name: "حبة",
      barcode: "9990001",
      price: 10,
      cost: 5,
      conversion_to_base: 1,
      is_default: true,
    });
    pieceId = piece.id;

    const supplier = await ctx.db.run(
      "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد مستودعات', 'WH-1', 0, 0)"
    );
    supplierId = supplier.lastID;

    const warehouses = unwrap(
      await request(ctx.app).get("/api/v1/warehouses").set(authHeader(adminToken))
    );
    mainWarehouse = warehouses.find((w) => w.type === "main");
    returnsWarehouse = warehouses.find((w) => w.type === "returns");
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  function findWh(rows, type) {
    const warehouses = Array.isArray(rows) ? rows : rows?.warehouses || [];
    const wanted = type === "main" ? mainWarehouse : returnsWarehouse;
    return warehouses.find((r) => Number(r.warehouse_id) === Number(wanted.id));
  }

  async function retailTotals() {
    return ctx.db.get(
      `SELECT COALESCE(SUM(stock), 0) AS total_qty,
              COALESCE(SUM(stock * COALESCE(cost, 0)), 0) AS total_value
         FROM products
        WHERE COALESCE(inventory_scope, 'retail') = 'retail'`
    );
  }

  test("valuation puts supermarket stock on the main warehouse and skips bakery materials", async () => {
    const expected = await retailTotals();
    const bakery = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [bakeryProductId]);
    const res = await request(ctx.app)
      .get("/api/v1/warehouses/valuation")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const data = unwrap(res);
    const main = findWh(data, "main");
    const returnsRow = findWh(data, "returns");
    expect(data.costing_method).toBe("current_inventory_cost");
    expect(data.basis_label).toBe("القيمة الحالية حسب تكلفة المخزون");
    expect((data.lines || []).some((row) => Number(row.product_id) === Number(productId))).toBe(true);
    expect(main.total_qty).toBeCloseTo(Number(expected.total_qty), 3);
    expect(Number(bakery.stock)).toBe(40);
    expect(main.total_qty).not.toBeCloseTo(Number(expected.total_qty) + Number(bakery.stock), 3);
    expect(returnsRow.total_qty).toBe(0);
    expect(returnsRow.total_value).toBeCloseTo(0, 2);
  });

  test("stock report lists supermarket products under the main warehouse", async () => {
    const res = await request(ctx.app)
      .get("/api/v1/warehouses/stock")
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const rows = unwrap(res);
    const mainLines = rows.filter((r) => Number(r.warehouse_id) === Number(mainWarehouse.id));
    expect(mainLines.some((r) => Number(r.product_id) === Number(productId))).toBe(true);
    expect(mainLines.some((r) => Number(r.product_id) === Number(bakeryProductId))).toBe(false);
  });

  test("product overview shows current stock on the main warehouse", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/products/${productId}/overview`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const data = unwrap(res);
    const main = (data.warehouses || []).find((w) => Number(w.warehouse_id) === Number(mainWarehouse.id));
    expect(main).toBeTruthy();
    expect(Number(main.quantity)).toBe(100);
  });

  test("draft purchase return does not appear in the returns warehouse", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        return_date: "2026-09-17",
        items: [{ product_id: productId, unit_id: pieceId, quantity: 4, total_cost: 20 }],
      });
    expect(created.status).toBe(201);

    const res = await request(ctx.app)
      .get("/api/v1/warehouses/valuation")
      .set(authHeader(adminToken));
    expect(findWh(unwrap(res), "returns").total_qty).toBe(0);
  });

  test("posted purchase return appears on the returns warehouse", async () => {
    const before = findWh(
      unwrap(await request(ctx.app).get("/api/v1/warehouses/valuation").set(authHeader(adminToken))),
      "main"
    );
    const created = await request(ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        return_date: "2026-09-17",
        items: [{ product_id: productId, unit_id: pieceId, quantity: 6, total_cost: 30 }],
      });
    expect(created.status).toBe(201);
    const ret = unwrap(created);
    const posted = await request(ctx.app)
      .post(`/api/v1/purchases/returns/${ret.id}/post`)
      .set(authHeader(adminToken));
    expect(posted.status).toBe(200);

    const valuation = unwrap(
      await request(ctx.app).get("/api/v1/warehouses/valuation").set(authHeader(adminToken))
    );
    const main = findWh(valuation, "main");
    const returnsRow = findWh(valuation, "returns");
    expect((valuation.supplier_returns || []).some((row) => Number(row.product_id) === Number(productId))).toBe(true);
    expect(returnsRow.total_qty || 0).not.toBe(6);
    expect(Number(valuation.grand_total || valuation.known_subtotal || 0)).not.toBeCloseTo(
      Number(before.total_value || 0) + 30,
      2
    );

    const stock = unwrap(
      await request(ctx.app).get("/api/v1/warehouses/stock").set(authHeader(adminToken))
    );
    const returnLine = stock.find(
      (r) =>
        Number(r.warehouse_id) === Number(returnsWarehouse.id) &&
        Number(r.product_id) === Number(productId)
    );
    expect(returnLine).toBeUndefined();

    const overview = unwrap(
      await request(ctx.app)
        .get(`/api/v1/products/${productId}/overview`)
        .set(authHeader(adminToken))
    );
    const returnsLoc = (overview.warehouses || []).find(
      (w) => Number(w.warehouse_id) === Number(returnsWarehouse.id)
    );
    expect(returnsLoc).toBeUndefined();
  });

  test("search filters stock by name, barcode, or product number", async () => {
    const hdr = authHeader(adminToken);
    const byName = unwrap(
      await request(ctx.app).get("/api/v1/warehouses/stock").query({ q: "Test Product" }).set(hdr)
    );
    expect(byName.some((r) => Number(r.product_id) === Number(productId))).toBe(true);
    expect(byName.some((r) => Number(r.product_id) === Number(bakeryProductId))).toBe(false);

    const byBarcode = unwrap(
      await request(ctx.app).get("/api/v1/warehouses/stock").query({ q: "9990001" }).set(hdr)
    );
    expect(byBarcode.some((r) => Number(r.product_id) === Number(productId))).toBe(true);

    const bySku = unwrap(
      await request(ctx.app).get("/api/v1/warehouses/stock").query({ q: "4242" }).set(hdr)
    );
    expect(bySku.some((r) => Number(r.product_id) === Number(productId))).toBe(true);

    const miss = unwrap(
      await request(ctx.app).get("/api/v1/warehouses/stock").query({ q: "طحين مخبز" }).set(hdr)
    );
    expect(miss.some((r) => Number(r.product_id) === Number(bakeryProductId))).toBe(false);
  });

  test("bakery membership shows bakery stock and posted bakery returns", async () => {
    const hdr = authHeader(adminToken);
    const before = unwrap(
      await request(ctx.app).get("/api/v1/warehouses/valuation").query({ membership: "bakery" }).set(hdr)
    );
    const bakeryLine = (before.lines || []).find((row) => Number(row.product_id) === Number(bakeryProductId));
    expect(bakeryLine.quantity).toBeCloseTo(40, 3);
    expect(bakeryLine.cost_known).toBe(true);
    expect((before.lines || []).some((row) => Number(row.product_id) === Number(productId))).toBe(false);

    const stock = unwrap(
      await request(ctx.app).get("/api/v1/warehouses/stock").query({ membership: "bakery" }).set(hdr)
    );
    expect(stock.some((r) => Number(r.product_id) === Number(bakeryProductId))).toBe(true);
    expect(stock.some((r) => Number(r.product_id) === Number(productId))).toBe(false);

    const named = unwrap(
      await request(ctx.app)
        .get("/api/v1/warehouses/stock")
        .query({ membership: "bakery", q: "طحين" })
        .set(hdr)
    );
    expect(named.some((r) => Number(r.product_id) === Number(bakeryProductId))).toBe(true);

    const created = await request(ctx.app)
      .post("/api/v1/purchases/returns")
      .set(hdr)
      .send({
        supplier_id: supplierId,
        return_date: "2026-09-17",
        items: [{ product_id: bakeryProductId, unit_id: ctx.bakeryUnitId, quantity: 5, total_cost: 15 }],
      });
    expect(created.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/purchases/returns/${unwrap(created).id}/post`)
      .set(hdr);
    expect(posted.status).toBe(200);

    const bakeryVal = unwrap(
      await request(ctx.app).get("/api/v1/warehouses/valuation").query({ membership: "bakery" }).set(hdr)
    );
    expect(bakeryVal.costing_method).toBe("current_inventory_cost");
    expect((bakeryVal.lines || []).some((row) => Number(row.product_id) === Number(bakeryProductId))).toBe(true);
    expect((bakeryVal.supplier_returns || []).some((row) => Number(row.product_id) === Number(bakeryProductId))).toBe(true);
    expect(findWh(bakeryVal, "returns").total_value).toBeCloseTo(0, 2);

    const supermarketVal = unwrap(
      await request(ctx.app).get("/api/v1/warehouses/valuation").set(hdr)
    );
    expect(findWh(supermarketVal, "returns").total_qty || 0).not.toBe(6);

    const overview = unwrap(
      await request(ctx.app).get(`/api/v1/products/${bakeryProductId}/overview`).set(hdr)
    );
    const mainLoc = (overview.warehouses || []).find(
      (w) => Number(w.warehouse_id) === Number(mainWarehouse.id)
    );
    expect(Number(mainLoc.quantity)).toBe(35);
  });

  test("transfers out and back keep one company value, including returns and another location", async () => {
    const hdr = authHeader(adminToken);
    const warehouses = unwrap(await request(ctx.app).get("/api/v1/warehouses").set(hdr));
    const store = warehouses.find((w) => w.type === "store");
    const damaged = warehouses.find((w) => w.type === "damaged");
    const product = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [productId]);
    const stockBefore = Number(product.stock);
    const before = unwrap(await request(ctx.app).get("/api/v1/warehouses/valuation").set(hdr));

    async function postTransfer(fromId, toId, qty) {
      const draft = await request(ctx.app)
        .post("/api/v1/warehouses/transfers")
        .set(hdr)
        .send({
          from_warehouse_id: fromId,
          to_warehouse_id: toId,
          items: [{ product_id: productId, quantity: qty }],
        });
      expect(draft.status).toBe(201);
      const posted = await request(ctx.app)
        .post(`/api/v1/warehouses/transfers/${unwrap(draft).id}/post`)
        .set(hdr);
      expect(posted.status).toBe(200);
    }

    function lineSum(body) {
      return (body.warehouses || []).reduce(
        (sum, row) => Math.round((sum + Number(row.total_value || 0)) * 100) / 100,
        0
      );
    }

    function productQty(rows, warehouseId) {
      return rows
        .filter((row) => Number(row.product_id) === Number(productId) && Number(row.warehouse_id) === Number(warehouseId))
        .reduce((sum, row) => sum + Number(row.quantity), 0);
    }

    await postTransfer(mainWarehouse.id, store.id, 10);
    await postTransfer(store.id, mainWarehouse.id, 4);
    await postTransfer(mainWarehouse.id, returnsWarehouse.id, 2);
    await postTransfer(mainWarehouse.id, damaged.id, 1);

    const after = unwrap(await request(ctx.app).get("/api/v1/warehouses/valuation").set(hdr));
    const lines = unwrap(await request(ctx.app).get("/api/v1/warehouses/stock").set(hdr));
    const live = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [productId]);
    expect(Number(live.stock)).toBeCloseTo(stockBefore, 3);
    expect(after.costing_method).toBe("current_inventory_cost");
    expect(after.known_subtotal).toBeCloseTo(before.known_subtotal, 2);
    expect(productQty(lines, mainWarehouse.id)).toBeCloseTo(stockBefore - 6 - 2 - 1, 3);
    expect(productQty(lines, store.id)).toBeCloseTo(6, 3);
    expect(productQty(lines, returnsWarehouse.id)).toBeCloseTo(2, 3);
    expect(productQty(lines, damaged.id)).toBeCloseTo(1, 3);
  });
});
