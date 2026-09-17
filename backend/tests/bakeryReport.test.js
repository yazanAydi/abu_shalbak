import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";
import { shopTodayYmd, addShopDays, shopYmdToUtcBounds } from "../utils/shopTime.js";
import { toSqlUtc } from "../utils/businessDay.js";
import { round2 } from "../utils/money.js";
import { bakeryLineNetRevenue, roundQty } from "../services/bakeryReportService.js";

function unwrap(res) {
  return res.body?.data ?? res.body;
}

describe("bakery report", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  const today = shopTodayYmd();

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 100 });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function createProduct(body) {
    const res = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send(body);
    expect(res.status).toBe(201);
    return unwrap(res);
  }

  async function checkout(items, extra = {}) {
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({ payment_method: "cash", items, ...extra }));
    return res;
  }

  async function bakeryReport(query = {}) {
    const res = await request(ctx.app)
      .get("/api/v1/reports/bakery")
      .query({ from: today, to: today, ...query })
      .set(authHeader(adminToken));
    return { res, body: unwrap(res) };
  }

  async function rangeReport() {
    const res = await request(ctx.app)
      .get("/api/v1/reports/range")
      .query({ from: today, to: today })
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    return unwrap(res);
  }

  async function approveRefund(transactionId, lines) {
    const reqRes = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: transactionId,
        lines,
        reason: "bakery report test",
        payment_method: "cash",
      });
    expect(reqRes.status).toBe(201);
    const requestId = unwrap(reqRes).request_id;
    const approve = await request(ctx.app)
      .put(`/api/v1/refund-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approve.status).toBe(200);
    return requestId;
  }

  test("roundQty preserves fractional quantities and line revenue uses allocated discount", () => {
    expect(roundQty(0.93)).toBe(0.93);
    expect(roundQty(0.125)).toBe(0.125);
    expect(bakeryLineNetRevenue({ line_gross: 40, discount_at_sale: 4 })).toBe(36);
    expect(bakeryLineNetRevenue({ line_gross: 10, discount_at_sale: 10 })).toBe(0);
  });

  test("ambiguous bakery categories require explicit selection instead of guessing", async () => {
    const pastry = await createProduct({
      barcode: "8801000001",
      name: "كرواسان",
      price: 5,
      cost: 2,
      stock: 10,
      category: "معجنات",
      unit: "حبة",
    });
    await createProduct({
      barcode: "8801000002",
      name: "بيتزا صغيرة",
      price: 12,
      cost: 4,
      stock: 8,
      category: "بيتزا",
      unit: "حبة",
    });

    const { res, body } = await bakeryReport();
    expect(res.status).toBe(200);
    expect(body.needs_configuration).toBe(true);
    expect(body.classification.historical_category_snapshot).toBe(false);
    expect(body.classification.stored_as).toBe("products.category_name");
    expect(body.products).toEqual([]);
    expect(body.kpis.invoice_count).toBe(0);
    expect(body.available_categories.find((c) => c.name === "معجنات")?.product_count).toBeGreaterThanOrEqual(1);
    expect(body.available_categories.find((c) => c.name === "بيتزا")?.product_count).toBeGreaterThanOrEqual(1);

    const cat = await ctx.db.get("SELECT id FROM product_categories WHERE name = ?", ["معجنات"]);
    const save = await request(ctx.app)
      .put("/api/v1/reports/bakery/categories")
      .set(authHeader(adminToken))
      .send({ category_ids: [cat.id] });
    expect(save.status).toBe(200);
    expect(unwrap(save).needs_configuration).toBe(false);

    const configured = await bakeryReport();
    expect(configured.body.needs_configuration).toBe(false);
    expect(configured.body.products.some((p) => p.product_id === pastry.id)).toBe(true);
    expect(configured.body.products.some((p) => p.name === "بيتزا صغيرة")).toBe(false);
  });

  test("empty selected category stays empty and does not infer bakery membership", async () => {
    const namedBread = await createProduct({
      barcode: "8803000001",
      name: "خبز صاج",
      price: 3,
      cost: 1,
      stock: 9,
      category: "ألبان",
      unit: "حبة",
    });
    const flour = await createProduct({
      barcode: "8803000002",
      name: "طحين أبيض",
      price: 0,
      cost: 2,
      stock: 15,
      category: "ألبان",
      unit: "كغم",
      inventory_scope: "bakery",
    });
    await createProduct({
      barcode: "8803000003",
      name: "صنف بلا تصنيف",
      price: 1,
      cost: 1,
      stock: 1,
      category: "",
      unit: "حبة",
    });

    const supplies = await ctx.db.get("SELECT id FROM product_categories WHERE name = ?", [
      "مواد مخبز",
    ]);
    expect(supplies).toBeTruthy();
    const save = await request(ctx.app)
      .put("/api/v1/reports/bakery/categories")
      .set(authHeader(adminToken))
      .send({ category_ids: [supplies.id] });
    expect(save.status).toBe(200);
    expect(unwrap(save).available_categories.find((c) => Number(c.id) === Number(supplies.id))?.product_count).toBe(0);

    const { res, body } = await bakeryReport();
    expect(res.status).toBe(200);
    expect(body.empty_selected_catalog).toBe(true);
    expect(body.products).toEqual([]);
    expect(body.products.some((p) => p.product_id === namedBread.id)).toBe(false);
    expect(body.products.some((p) => p.product_id === flour.id)).toBe(false);
    expect(body.kpis.invoice_count).toBe(0);
    expect(body.kpis.net_revenue).toBe(0);

    const suppliesOpt = body.available_categories.find((c) => Number(c.id) === Number(supplies.id));
    expect(suppliesOpt.product_count).toBe(0);
    const dairy = body.available_categories.find((c) => c.name === "ألبان");
    expect(dairy.product_count).toBeGreaterThanOrEqual(2);
    expect(dairy.sample_names).toEqual(expect.arrayContaining(["خبز صاج"]));
    expect(body.uncategorized_product_count).toBeGreaterThanOrEqual(1);
    expect(body.classification.note).toMatch(/تغيير تصنيف المنتج/);
  });

  test("covers bakery-only, mixed invoice, units, refunds, discounts, search, stock, and global totals", async () => {
    const bakeryCat = await ctx.db.get("SELECT id FROM product_categories WHERE name = ?", ["مخبز"]);
    if (!bakeryCat) {
      await request(ctx.app)
        .post("/api/v1/products/categories")
        .set(authHeader(adminToken))
        .send({ name: "مخبز" });
    }
    await request(ctx.app)
      .put("/api/v1/reports/bakery/categories")
      .set(authHeader(adminToken))
      .send({
        category_ids: [
          (
            await ctx.db.get("SELECT id FROM product_categories WHERE name = ?", ["مخبز"])
          ).id,
        ],
      });

    const bread = await createProduct({
      barcode: "8802000001",
      name: "خبز عربي",
      price: 4,
      cost: 1,
      stock: 20,
      category: "مخبز",
      unit: "حبة",
    });
    await request(ctx.app)
      .post(`/api/v1/products/${bread.id}/barcodes`)
      .set(authHeader(adminToken))
      .send({ barcode: "8802000099", label: "صندوق" });

    const cake = await createProduct({
      barcode: "8802000002",
      name: "كيك فراولة",
      price: 15,
      cost: 6,
      stock: 6,
      category: "مخبز",
      unit: "حبة",
    });
    const unsold = await createProduct({
      barcode: "8802000003",
      name: "كعك يابس",
      price: 3,
      cost: 1,
      stock: -4,
      category: "مخبز",
      unit: "حبة",
    });
    const kgBread = await createProduct({
      barcode: "8802000004",
      name: "خبز كغم",
      price: 10,
      cost: 4,
      stock: 8,
      category: "مخبز",
      unit: "كغم",
      is_weighed: true,
      scale_code: "2100888",
      package_conversion: 2.5,
      package_price: 22,
    });
    const milk = await createProduct({
      barcode: "8802000005",
      name: "حليب طازج",
      price: 8,
      cost: 4,
      stock: 30,
      category: "ألبان",
      unit: "حبة",
    });

    const txBefore = await ctx.db.get("SELECT COUNT(*) AS n FROM transactions");
    const rangeBefore = await rangeReport();

    const bakeryOnly = await checkout([{ product_id: bread.id, quantity: 3, price: 4 }]);
    expect(bakeryOnly.status).toBe(201);

    const mixed = await checkout([
      { product_id: bread.id, quantity: 1, price: 4 },
      { product_id: cake.id, quantity: 1, price: 15 },
      { product_id: milk.id, quantity: 1, price: 8 },
    ]);
    expect(mixed.status).toBe(201);
    const mixedId = unwrap(mixed).transaction_id;

    const unitsRes = await request(ctx.app)
      .get(`/api/v1/products/${kgBread.id}/units`)
      .set(authHeader(adminToken));
    const units = unwrap(unitsRes).units || unwrap(unitsRes);
    const kgUnit = units.find((u) => u.unit_name === "كغم");
    const packUnit = units.find((u) => u.unit_name === "حبة");
    expect(kgUnit).toBeTruthy();
    expect(packUnit).toBeTruthy();

    const fractional = await checkout([
      { product_id: kgBread.id, unit_id: kgUnit.id, quantity: 0.75, price: 10 },
      { product_id: kgBread.id, unit_id: packUnit.id, quantity: 1, price: packUnit.price },
    ]);
    expect(fractional.status).toBe(201);

    const promo = await request(ctx.app)
      .post("/api/v1/marketing/promotions")
      .set(authHeader(adminToken))
      .send({
        name: "خصم خبز تقرير",
        offer_type: "percentage",
        category: "مخبز",
        discount_value: 10,
        active: true,
      });
    expect(promo.status).toBe(201);

    const discounted = await checkout([
      { product_id: bread.id, quantity: 5, price: 4 },
      { product_id: milk.id, quantity: 5, price: 8 },
    ]);
    expect(discounted.status).toBe(201);
    const discountedId = unwrap(discounted).transaction_id;
    const discountLines = await ctx.db.all(
      "SELECT product_id, line_gross, discount_at_sale FROM transaction_items WHERE transaction_id = ?",
      [discountedId]
    );
    const bakeryDiscountLine = discountLines.find((l) => Number(l.product_id) === bread.id);
    const invoiceDiscount = await ctx.db.get(
      "SELECT discount, total FROM transactions WHERE id = ?",
      [discountedId]
    );
    expect(Number(invoiceDiscount.discount)).toBeGreaterThan(0);
    expect(Number(bakeryDiscountLine.discount_at_sale)).toBeGreaterThan(0);
    expect(Number(bakeryDiscountLine.discount_at_sale)).toBeLessThan(Number(invoiceDiscount.discount));

    await approveRefund(mixedId, [{ product_id: bread.id, quantity: 1 }]);

    const pending = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: unwrap(bakeryOnly).transaction_id,
        lines: [{ product_id: bread.id, quantity: 1 }],
        reason: "pending should not count",
        payment_method: "cash",
      });
    expect(pending.status).toBe(201);

    await ctx.db.run("UPDATE products SET is_active = 0 WHERE id = ?", [cake.id]);

    const oldSale = await checkout([{ product_id: bread.id, quantity: 2, price: 4 }]);
    expect(oldSale.status).toBe(201);
    const oldId = unwrap(oldSale).transaction_id;
    const yesterday = addShopDays(shopTodayYmd(), -1);
    const { startIso } = shopYmdToUtcBounds(yesterday);
    await ctx.db.run("UPDATE transactions SET shift_id = NULL, created_at = ? WHERE id = ?", [
      toSqlUtc(startIso),
      oldId,
    ]);

    const txAfterOpen = await ctx.db.get("SELECT COUNT(*) AS n FROM transactions");
    const { res, body } = await bakeryReport();
    expect(res.status).toBe(200);
    const txAfterRead = await ctx.db.get("SELECT COUNT(*) AS n FROM transactions");
    expect(Number(txAfterRead.n)).toBe(Number(txAfterOpen.n));
    expect(body.classification.mode).toBe("current_product_category");
    expect(body.classification.historical_category_snapshot).toBe(false);
    expect(body.classification.includes_inactive_products).toBe(true);
    expect(body.classification.stored_as).toBe("products.category_name");
    expect(body.empty_selected_catalog).toBe(false);
    expect(body.available_categories.find((c) => c.name === "مخبز")?.product_count).toBeGreaterThanOrEqual(4);
    expect(body.stock_note).toMatch(/المخزون الحالي/);

    const byId = new Map(body.products.map((p) => [p.product_id, p]));
    expect(byId.get(unsold.id)).toBeTruthy();
    expect(byId.get(unsold.id).sold_quantity).toBe(0);
    expect(byId.get(unsold.id).stock).toBe(-4);
    expect(byId.get(cake.id)).toBeTruthy();
    expect(byId.get(cake.id).is_active).toBe(0);
    expect(byId.has(milk.id)).toBe(false);

    const breadRow = byId.get(bread.id);
    expect(breadRow.sold_quantity).toBe(9);
    expect(breadRow.refunded_quantity).toBe(1);
    expect(breadRow.net_quantity).toBe(8);
    expect(breadRow.invoice_count).toBe(3);

    const cakeRow = byId.get(cake.id);
    expect(cakeRow.sold_quantity).toBe(1);
    expect(cakeRow.invoice_count).toBe(1);

    const kgRow = byId.get(kgBread.id);
    expect(kgRow.unit).toBe("كغم");
    expect(kgRow.sold_quantity).toBeCloseTo(3.25, 4);
    expect(kgRow.invoice_count).toBe(1);

    expect(body.kpis.invoice_count).toBe(4);
    expect(body.kpis.material_net_revenue).toBe(0);
    expect(body.kpis.finished_net_revenue).toBe(body.kpis.net_revenue);
    expect(breadRow.revenue_kind).toBe("finished");
    const summedProductInvoices = body.products.reduce((s, p) => s + p.invoice_count, 0);
    expect(summedProductInvoices).toBeGreaterThan(body.kpis.invoice_count);

    const soldUnits = Object.fromEntries(
      body.kpis.sold_quantity_by_unit.map((u) => [u.unit, u.quantity])
    );
    expect(soldUnits["حبة"]).toBe(10);
    expect(soldUnits["كغم"]).toBeCloseTo(3.25, 4);

    const allocatedBakeryRev = bakeryLineNetRevenue(bakeryDiscountLine);
    expect(breadRow.net_revenue).toBe(
      round2(3 * 4 + (4 - 4) + allocatedBakeryRev)
    );

    const nameSearch = await bakeryReport({ q: "كيك" });
    expect(nameSearch.body.products).toHaveLength(1);
    expect(nameSearch.body.products[0].product_id).toBe(cake.id);
    expect(nameSearch.body.kpis.invoice_count).toBe(1);

    const barcodeSearch = await bakeryReport({ q: "8802000099" });
    expect(barcodeSearch.body.products.some((p) => p.product_id === bread.id)).toBe(true);
    expect(barcodeSearch.body.products.every((p) => p.product_id === bread.id)).toBe(true);

    const productFilter = await bakeryReport({ product_id: cake.id });
    expect(productFilter.body.products).toHaveLength(1);
    expect(productFilter.body.kpis.invoice_count).toBe(1);
    expect(productFilter.body.kpis.net_revenue).toBe(cakeRow.net_revenue);

    const yesterdayReport = await request(ctx.app)
      .get("/api/v1/reports/bakery")
      .query({ from: yesterday, to: yesterday })
      .set(authHeader(adminToken));
    const yesterdayBody = unwrap(yesterdayReport);
    const yesterdayBread = yesterdayBody.products.find((p) => p.product_id === bread.id);
    expect(yesterdayBread.sold_quantity).toBe(2);
    expect(yesterdayBody.kpis.invoice_count).toBe(1);

    const rangeAfter = await rangeReport();
    expect(rangeAfter.net_sales).toBeGreaterThan(rangeBefore.net_sales);
    expect(rangeAfter.net_sales).toBeGreaterThanOrEqual(body.kpis.net_revenue);
    expect(Number(txAfterOpen.n)).toBeGreaterThan(Number(txBefore.n));

    const finance = await request(ctx.app)
      .get("/api/v1/finance/overview")
      .query({ from: today, to: today })
      .set(authHeader(adminToken));
    expect(finance.status).toBe(200);
    const fin = unwrap(finance);
    expect(Number(fin.sales?.net ?? fin.net_sales)).toBe(rangeAfter.net_sales);
  });
});
