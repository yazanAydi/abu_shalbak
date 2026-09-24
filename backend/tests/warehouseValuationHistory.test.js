import request from "supertest";
import {
  authHeader,
  createAccountantUser,
  createTestContext,
  destroyTestContext,
  login,
  withCheckoutKey,
} from "./helpers.js";
import { upsertProductUnit } from "../utils/productUnits.js";
import { businessDayFromTimestamp } from "../utils/businessDay.js";
import { updateAppSettings } from "../utils/settings.js";
import { round2 } from "../utils/money.js";

function unwrap(res) {
  return res.body?.data ?? res.body;
}

const DAY1 = "2026-01-10";
const DAY2 = "2026-01-12";

describe("historical warehouse valuation", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let supplierId;
  let mainId;
  let storeId;
  let returnsId;
  let shiftId;
  let seq = 1000;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    supplierId = (
      await ctx.db.run(
        "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد تاريخ', 'HV-1', 0, 0)"
      )
    ).lastID;
    const warehouses = unwrap(await request(ctx.app).get("/api/v1/warehouses").set(authHeader(adminToken)));
    mainId = warehouses.find((w) => w.type === "main").id;
    storeId = warehouses.find((w) => w.type === "store").id;
    returnsId = warehouses.find((w) => w.type === "returns").id;
    const shift = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    expect(shift.status).toBe(201);
    shiftId = unwrap(shift).shift_id;
    await ctx.db.run("UPDATE cashier_shifts SET business_day = ? WHERE id = ?", [DAY1, shiftId]);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function makeProduct(name, { scope = "retail", category = "عام", cost = 0, stock = 0 } = {}) {
    seq += 1;
    const barcode = `77${String(seq).padStart(6, "0")}`;
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, cost_known, category, stock, inventory_scope, is_active)
       VALUES (?, ?, 10, ?, NULL, ?, ?, ?, 1)`,
      [barcode, name, cost, category, stock, scope]
    );
    const unit = await upsertProductUnit(ctx.db, ins.lastID, {
      unit_name: "حبة",
      barcode,
      price: 10,
      cost,
      conversion_to_base: 1,
      is_default: true,
    });
    return { id: ins.lastID, unitId: unit.id, barcode };
  }

  async function postPurchase(product, { qty, total, date, bonus = 0 }) {
    const create = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        invoice_date: date,
        items: [{
          product_id: product.id,
          unit_id: product.unitId,
          quantity: qty,
          bonus_quantity: bonus,
          total_cost: total,
        }],
      });
    expect(create.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${unwrap(create).id}/post`)
      .set(authHeader(adminToken));
    expect(posted.status).toBe(200);
  }

  async function sell(product, qty) {
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: product.id, quantity: qty, price: 10, unit_id: product.unitId }],
        payment_method: "cash",
      }));
    expect(res.status).toBe(201);
    return unwrap(res);
  }

  async function val(date, membership) {
    const res = await request(ctx.app)
      .get("/api/v1/warehouses/valuation")
      .query({ as_of: date, ...(membership ? { membership } : {}) })
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    return unwrap(res);
  }

  function line(report, productId, warehouseId = mainId) {
    return (report.lines || []).find(
      (row) => Number(row.product_id) === Number(productId) && Number(row.warehouse_id) === Number(warehouseId)
    );
  }

  test("weighted average stays on the earlier day, and transfers do not change company value", async () => {
    const product = await makeProduct("تاريخ متوسط");
    await postPurchase(product, { qty: 10, total: 50, date: DAY1 });
    await sell(product, 2);
    await postPurchase(product, { qty: 2, total: 20, date: DAY2 });

    const earlier = await val(DAY1);
    const later = await val(DAY2);
    const early = line(earlier, product.id);
    const next = line(later, product.id);
    expect(early.quantity).toBeCloseTo(8, 3);
    expect(early.unit_cost).toBeCloseTo(5, 2);
    expect(early.value).toBeCloseTo(40, 2);
    expect(next.quantity).toBeCloseTo(10, 3);
    expect(next.unit_cost).toBeCloseTo(6, 2);
    expect(next.value).toBeCloseTo(60, 2);
    expect(early.as_of).toBe(DAY1);
    expect(early.warehouse_name).toBeTruthy();

    const moved = await makeProduct("تاريخ تحويل");
    await postPurchase(moved, { qty: 10, total: 50, date: DAY1 });
    const before = await val(DAY1);
    const beforeCompany = (before.lines || [])
      .filter((row) => Number(row.product_id) === moved.id && row.cost_known)
      .reduce((sum, row) => round2(sum + Number(row.value)), 0);
    const draft = await request(ctx.app)
      .post("/api/v1/warehouses/transfers")
      .set(authHeader(adminToken))
      .send({
        from_warehouse_id: mainId,
        to_warehouse_id: storeId,
        transfer_date: DAY1,
        items: [{ product_id: moved.id, quantity: 4 }],
      });
    expect(draft.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/warehouses/transfers/${unwrap(draft).id}/post`)
      .set(authHeader(adminToken));
    expect(posted.status).toBe(200);
    const after = await val(DAY1);
    const afterCompany = (after.lines || [])
      .filter((row) => Number(row.product_id) === moved.id && row.cost_known)
      .reduce((sum, row) => round2(sum + Number(row.value)), 0);
    expect(line(after, moved.id, mainId).quantity).toBeCloseTo(6, 3);
    expect(line(after, moved.id, storeId).quantity).toBeCloseTo(4, 3);
    expect(afterCompany).toBeCloseTo(beforeCompany, 2);
    expect(line(after, moved.id, storeId).unit_cost).toBeCloseTo(5, 2);
  });

  test("supplier return leaves main stock, and customer return, consumption, and damage keep the average", async () => {
    const product = await makeProduct("تاريخ حركة");
    await postPurchase(product, { qty: 10, total: 50, date: DAY1 });
    const sale = await sell(product, 2);
    const refundReq = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: sale.transaction_id || sale.transactionId,
        lines: [{ product_id: product.id, quantity: 1 }],
        payment_method: "cash",
        reason: "مرتجع زبون",
      });
    expect(refundReq.status).toBe(201);
    const approved = await request(ctx.app)
      .put(`/api/v1/refund-requests/${unwrap(refundReq).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);

    const consumed = await request(ctx.app)
      .post("/api/v1/inventory/adjustments")
      .set(authHeader(adminToken))
      .send({
        adjustment_type: "consumption",
        adjustment_date: DAY1,
        post: true,
        items: [{ product_id: product.id, quantity: 1 }],
      });
    expect(consumed.status).toBe(201);

    const damage = await request(ctx.app)
      .post("/api/v1/inventory/adjustments")
      .set(authHeader(adminToken))
      .send({
        adjustment_type: "damage",
        adjustment_date: DAY1,
        post: true,
        items: [{ product_id: product.id, quantity: 1 }],
      });
    expect(damage.status).toBe(201);

    const ret = await request(ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        return_date: DAY1,
        items: [{ product_id: product.id, unit_id: product.unitId, quantity: 2, total_cost: 10 }],
      });
    expect(ret.status).toBe(201);
    const retPost = await request(ctx.app)
      .post(`/api/v1/purchases/returns/${unwrap(ret).id}/post`)
      .set(authHeader(adminToken));
    expect(retPost.status).toBe(200);

    const report = await val(DAY1);
    const main = line(report, product.id, mainId);
    const returns = line(report, product.id, returnsId);
    const history = (report.supplier_returns || []).filter((row) => Number(row.product_id) === product.id);
    // 10 purchased − 2 sold + 1 customer return − 1 consumption − 1 damage − 2 supplier return
    expect(main.quantity).toBeCloseTo(5, 3);
    expect(main.unit_cost).toBeCloseTo(5, 2);
    expect(main.value).toBeCloseTo(25, 2);
    expect(returns).toBeUndefined();
    expect(history.reduce((sum, row) => sum + Number(row.value), 0)).toBeCloseTo(10, 2);
    expect(history.every((row) => row.owned === false)).toBe(true);
    const owned = (report.lines || []).filter((row) => row.cost_known).reduce((sum, row) => sum + Number(row.value), 0);
    expect(owned).not.toBeCloseTo(owned + 10, 2);
  });

  test("free stock is a known zero and unknown cost stays incomplete", async () => {
    const free = await makeProduct("مجاني");
    await postPurchase(free, { qty: 4, total: 0, date: DAY1 });
    const unknown = await makeProduct("بلا تكلفة");
    const adj = await request(ctx.app)
      .post("/api/v1/inventory/adjustments")
      .set(authHeader(adminToken))
      .send({
        adjustment_type: "in",
        adjustment_date: DAY1,
        post: true,
        items: [{ product_id: unknown.id, quantity: 3 }],
      });
    expect(adj.status).toBe(201);

    const before = await val(DAY1);
    const report = await val(DAY1);
    const freeLine = line(report, free.id);
    const unknownLine = line(report, unknown.id);
    expect(freeLine.cost_known).toBe(true);
    expect(freeLine.unit_cost).toBe(0);
    expect(freeLine.value).toBe(0);
    expect(unknownLine.cost_known).toBe(false);
    expect(unknownLine.value).toBeNull();
    expect(unknownLine.unit_cost).toBeNull();
    expect(report.known_subtotal).toBeCloseTo(before.known_subtotal, 2);
    expect(report.unvalued_count).toBeGreaterThan(0);
    expect(report.lines.some((row) => row.value == null && row.quantity)).toBe(true);
  });

  test("approved shop consumption removes quantity at the saved average", async () => {
    const product = await makeProduct("استهلاك محل");
    await postPurchase(product, { qty: 6, total: 30, date: DAY1 });
    await ctx.db.run("UPDATE cashier_shifts SET status = 'closed' WHERE status = 'open'");
    const opened = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    expect(opened.status).toBe(201);
    shiftId = unwrap(opened).shift_id;
    await ctx.db.run("UPDATE cashier_shifts SET business_day = ? WHERE id = ?", [DAY1, shiftId]);
    const consumed = await request(ctx.app)
      .post("/api/v1/pos/shop-consumption")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: product.id, quantity: 1, unit_id: product.unitId }],
        reason: "استهلاك تاريخي",
        idempotency_key: `hist-shop-${product.id}`,
      });
    expect(consumed.status).toBe(201);
    const ok = await request(ctx.app)
      .post(`/api/v1/shop-consumption-requests/${unwrap(consumed).request_id}/approve`)
      .set(authHeader(adminToken));
    expect(ok.status).toBe(200);
    const report = await val(DAY1);
    const row = line(report, product.id);
    expect(row.quantity).toBeCloseTo(5, 3);
    expect(row.unit_cost).toBeCloseTo(5, 2);
    expect(row.value).toBeCloseTo(25, 2);
  });

  test("bonus quantity uses the paid amount over received units", async () => {
    const product = await makeProduct("بونص");
    await postPurchase(product, { qty: 10, total: 60, date: DAY1, bonus: 2 });
    const report = await val(DAY1);
    const row = line(report, product.id);
    expect(row.quantity).toBeCloseTo(12, 3);
    expect(row.unit_cost).toBeCloseTo(5, 2);
    expect(row.value).toBeCloseTo(60, 2);
  });

  test("backdated purchase changes the document day, and a gap is not invented", async () => {
    const product = await makeProduct("مرحل لاحقاً");
    await postPurchase(product, { qty: 2, total: 20, date: DAY2 });
    const before = await val(DAY1);
    expect(line(before, product.id)).toBeUndefined();
    await postPurchase(product, { qty: 2, total: 10, date: DAY1 });
    const after = await val(DAY1);
    const day2 = await val(DAY2);
    expect(line(after, product.id).quantity).toBeCloseTo(2, 3);
    expect(line(after, product.id).value).toBeCloseTo(10, 2);
    expect(line(day2, product.id).quantity).toBeCloseTo(4, 3);
    expect(after.backdated_note).toMatch(/تاريخ/);

    const gap = await makeProduct("رصيد بلا حركة", { stock: 8, cost: 9 });
    const limited = await val(DAY1);
    expect(line(limited, gap.id)).toBeUndefined();
    expect(limited.history_limited).toBe(true);
    expect(limited.history_message).toMatch(/لم يُفترض/);
    expect(limited.known_subtotal).not.toBeCloseTo(
      (before.known_subtotal || 0) + 72,
      0
    );
  });

  test("deactivated products and stored bakery membership are kept", async () => {
    const gone = await makeProduct("موقوف");
    await postPurchase(gone, { qty: 3, total: 15, date: DAY1 });
    await ctx.db.run("UPDATE products SET is_active = 0 WHERE id = ?", [gone.id]);
    const still = await val(DAY1);
    expect(line(still, gone.id).quantity).toBeCloseTo(3, 3);

    const bakery = await makeProduct("دقيق تاريخي", { scope: "bakery", category: "مواد" });
    await postPurchase(bakery, { qty: 4, total: 8, date: DAY1 });
    await ctx.db.run("UPDATE products SET inventory_scope = 'retail', category = 'ألبان' WHERE id = ?", [bakery.id]);
    const pastBakery = await val(DAY1, "bakery");
    const pastShop = await val(DAY1);
    expect(line(pastBakery, bakery.id).quantity).toBeCloseTo(4, 3);
    expect(line(pastShop, bakery.id)).toBeUndefined();
    const todayName = unwrap(await request(ctx.app).get("/api/v1/warehouses/valuation").set(authHeader(adminToken))).shop_business_day;
    const today = await val(todayName);
    const todayBakery = await val(todayName, "bakery");
    expect(today.as_of_label).toBe("حتى الآن");
    expect(today.costing_method).toBe(pastShop.costing_method);
    expect(line(today, bakery.id)).toBeUndefined();
    expect(line(todayBakery, bakery.id).quantity).toBeCloseTo(4, 3);
  });

  test("fractional average keeps the receipt value, and a backdated purchase uses one method for today and yesterday", async () => {
    const fractional = await makeProduct("كسر");
    await postPurchase(fractional, { qty: 3, total: 10, date: DAY1 });
    const fraction = await val(DAY1);
    const fractionLine = line(fraction, fractional.id);
    expect(fractionLine.quantity).toBeCloseTo(3, 3);
    expect(fractionLine.value).toBeCloseTo(10, 2);
    expect(round2(3 * round2(fractionLine.unit_cost))).not.toBe(10);
    expect(fractionLine.value).not.toBeCloseTo(9.99, 2);

    const product = await makeProduct("ترتيب التاريخ");
    await postPurchase(product, { qty: 10, total: 50, date: DAY1 });
    await ctx.db.run("UPDATE cashier_shifts SET business_day = ? WHERE id = ?", [DAY2, shiftId]);
    await sell(product, 2);
    await postPurchase(product, { qty: 2, total: 20, date: DAY1 });
    const postedCost = await ctx.db.get("SELECT cost, stock FROM products WHERE id = ?", [product.id]);
    const day1 = await val(DAY1);
    const day2 = await val(DAY2);
    const today = await val(
      unwrap(await request(ctx.app).get("/api/v1/warehouses/valuation").set(authHeader(adminToken))).shop_business_day
    );
    const after = await ctx.db.get("SELECT cost FROM products WHERE id = ?", [product.id]);
    expect(Number(after.cost)).toBeCloseTo(Number(postedCost.cost), 2);
    const saleCost = await ctx.db.get(
      `SELECT unit_cost_at_sale FROM transaction_items WHERE product_id = ? ORDER BY id DESC LIMIT 1`,
      [product.id]
    );
    expect(Number(saleCost.unit_cost_at_sale)).toBeCloseTo(5, 2);
    expect(line(day1, product.id).quantity).toBeCloseTo(12, 3);
    expect(line(day1, product.id).value).toBeCloseTo(70, 2);
    expect(line(day2, product.id).quantity).toBeCloseTo(10, 3);
    expect(line(day2, product.id).value).toBeCloseTo(60, 2);
    expect(line(today, product.id).value).toBeCloseTo(60, 2);
    expect(line(today, product.id).value).toBeCloseTo(Number(postedCost.stock) * Number(postedCost.cost), 2);
    const estimate = (day2.document_date_estimate?.lines || []).find((row) => Number(row.product_id) === Number(product.id));
    expect(estimate.estimate_value).toBeCloseTo(58.33, 2);
    expect(estimate.recorded_value).toBeCloseTo(60, 2);
    expect(day2.document_date_estimate.label).toBe("تقدير تاريخ المستند");
    expect(today.costing_method).toBe("recorded_posting");
    expect(today.costing_method).toBe(day1.costing_method);
    expect(today.valuation_complete === false || today.grand_total == null || today.excluded_products.length > 0).toBe(true);
  });

  test("depletion absorbs the last agora, and an overstated supplier return stays unreconciled", async () => {
    const product = await makeProduct("تصفير");
    await postPurchase(product, { qty: 3, total: 10, date: DAY1 });
    await ctx.db.run("UPDATE cashier_shifts SET business_day = ? WHERE id = ?", [DAY1, shiftId]);
    await sell(product, 1);
    await sell(product, 1);
    await sell(product, 1);
    const saved = await ctx.db.all(
      "SELECT unit_cost_at_sale FROM transaction_items WHERE product_id = ? ORDER BY id",
      [product.id]
    );
    expect(saved.map((row) => Number(row.unit_cost_at_sale))).toEqual([3.33, 3.33, 3.33]);
    const depletion = await ctx.db.get(
      `SELECT id, value_adjustment FROM inventory_ledger
        WHERE product_id = ? AND movement_type = 'sale'
        ORDER BY id DESC LIMIT 1`,
      [product.id]
    );
    expect(Number(depletion.value_adjustment)).toBeCloseTo(-0.01, 2);
    const cleared = await val(DAY1);
    expect(line(cleared, product.id)).toBeUndefined();
    const recorded = (cleared.rounding_adjustments || []).filter((row) => Number(row.product_id) === Number(product.id));
    expect(recorded).toHaveLength(1);
    expect(recorded[0].recorded).toBe(true);
    expect(recorded[0].ledger_id).toBe(depletion.id);
    expect(round2(9.99 + Math.abs(recorded[0].amount))).toBeCloseTo(10, 2);
    expect((cleared.unexplained_rounding || []).some((row) => Number(row.product_id) === Number(product.id))).toBe(false);

    await ctx.db.run("UPDATE inventory_ledger SET value_adjustment = NULL WHERE id = ?", [depletion.id]);
    const historical = await val(DAY1);
    expect((historical.rounding_adjustments || []).some((row) => Number(row.product_id) === Number(product.id))).toBe(false);
    const gap = (historical.unexplained_rounding || []).find((row) => Number(row.product_id) === Number(product.id));
    expect(gap.amount).toBeCloseTo(0.01, 2);
    expect(historical.valuation_complete).toBe(false);
    await ctx.db.run("UPDATE inventory_ledger SET value_adjustment = ? WHERE id = ?", [-0.01, depletion.id]);

    const sales = await ctx.db.all(
      `SELECT reference_id FROM inventory_ledger
        WHERE product_id = ? AND movement_type = 'sale' ORDER BY id`,
      [product.id]
    );
    async function refundOne(transactionId) {
      const refundReq = await request(ctx.app)
        .post("/api/v1/refund-requests")
        .set(authHeader(cashierToken))
        .send({
          original_transaction_id: transactionId,
          lines: [{ product_id: product.id, quantity: 1 }],
          payment_method: "cash",
          reason: "مرتجع",
        });
      expect(refundReq.status).toBe(201);
      const approved = await request(ctx.app)
        .put(`/api/v1/refund-requests/${unwrap(refundReq).request_id}`)
        .set(authHeader(adminToken))
        .send({ status: "approved" });
      expect(approved.status).toBe(200);
    }
    await refundOne(sales[2].reference_id);
    const partial = await val(DAY1);
    expect(line(partial, product.id).quantity).toBeCloseTo(1, 3);
    expect(line(partial, product.id).value).toBeCloseTo(3.34, 2);
    const afterPartial = await ctx.db.all(
      `SELECT value_adjustment FROM inventory_ledger
        WHERE product_id = ? AND value_adjustment IS NOT NULL ORDER BY id`,
      [product.id]
    );
    expect(afterPartial.map((row) => Number(row.value_adjustment))).toEqual([-0.01, 0.01]);
    await refundOne(sales[1].reference_id);
    await refundOne(sales[0].reference_id);
    const restored = await val(DAY1);
    expect(line(restored, product.id).quantity).toBeCloseTo(3, 3);
    expect(line(restored, product.id).value).toBeCloseTo(10, 2);
    const afterFull = await ctx.db.all(
      `SELECT value_adjustment FROM inventory_ledger
        WHERE product_id = ? AND value_adjustment IS NOT NULL`,
      [product.id]
    );
    expect(afterFull).toHaveLength(2);
    expect(round2(afterFull.reduce((sum, row) => sum + Number(row.value_adjustment), 0))).toBe(0);

    const over = await makeProduct("غير مسوّى");
    await postPurchase(over, { qty: 10, total: 50, date: DAY1 });
    const created = await request(ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        return_date: DAY1,
        items: [{ product_id: over.id, unit_id: over.unitId, quantity: 2, total_cost: 80 }],
      });
    expect(created.status).toBe(201);
    const posted = await request(ctx.app)
      .post(`/api/v1/purchases/returns/${unwrap(created).id}/post`)
      .set(authHeader(adminToken));
    expect(posted.status).toBe(200);
    const report = await val(DAY1);
    expect(line(report, over.id)).toBeUndefined();
    expect((report.unreconciled_products || []).some((row) => Number(row.product_id) === Number(over.id))).toBe(true);
    expect(report.valuation_complete).toBe(false);
    expect(report.grand_total).toBeNull();
  });

  test("cutoff business day, read-only date selection, and warehouse permission", async () => {
    const counts = {
      ledger: (await ctx.db.get("SELECT COUNT(*) AS n FROM inventory_ledger")).n,
      stock: (await ctx.db.get("SELECT COALESCE(SUM(stock),0) AS n FROM products")).n,
    };
    const report = await val(DAY1);
    expect(report.read_only).toBe(true);
    expect((await ctx.db.get("SELECT COUNT(*) AS n FROM inventory_ledger")).n).toBe(counts.ledger);
    expect((await ctx.db.get("SELECT COALESCE(SUM(stock),0) AS n FROM products")).n).toBeCloseTo(counts.stock, 3);

    await updateAppSettings(ctx.db, { business_day_cutoff_hour: 23 });
    const expected = businessDayFromTimestamp(new Date().toISOString(), 23);
    const product = await makeProduct("حد اليوم");
    await postPurchase(product, { qty: 2, total: 8, date: expected });
    await ctx.db.run("UPDATE cashier_shifts SET status = 'closed' WHERE id = ?", [shiftId]);
    const opened = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    expect(opened.status).toBe(201);
    expect(unwrap(opened).business_day).toBe(expected);
    await sell(product, 1);
    const onDay = await val(expected);
    const saleRow = await ctx.db.get(
      `SELECT business_day FROM inventory_ledger
        WHERE product_id = ? AND movement_type = 'sale'
        ORDER BY id DESC LIMIT 1`,
      [product.id]
    );
    expect(saleRow.business_day).toBe(expected);
    expect(line(onDay, product.id).quantity).toBeCloseTo(1, 3);
    expect(line(onDay, product.id).value).toBeCloseTo(4, 2);
    const dayBefore = expected.replace(/(\d{2})$/, (d) => String(Number(d) - 1).padStart(2, "0"));
    if (dayBefore < expected) {
      const prev = await val(dayBefore);
      expect(line(prev, product.id)).toBeUndefined();
    }

    const deniedUser = await createAccountantUser(ctx.db, {
      username: "hist-no-wh",
      permissions: { warehouses: false },
    });
    const deniedToken = (await login(ctx.app, deniedUser.username, deniedUser.password, "office")).body.token;
    const denied = await request(ctx.app)
      .get("/api/v1/warehouses/valuation")
      .query({ as_of: DAY1 })
      .set(authHeader(deniedToken));
    expect(denied.status).toBe(403);
    const allowedUser = await createAccountantUser(ctx.db, {
      username: "hist-wh",
      permissions: { warehouses: true },
    });
    const allowedToken = (await login(ctx.app, allowedUser.username, allowedUser.password, "office")).body.token;
    const allowed = await request(ctx.app)
      .get("/api/v1/warehouses/valuation")
      .query({ as_of: DAY1 })
      .set(authHeader(allowedToken));
    expect(allowed.status).toBe(200);
  });
});
