import request from "supertest";
import {
  authHeader,
  createTestContext,
  destroyTestContext,
  login,
  withCheckoutKey,
} from "./helpers.js";
import { upsertProductUnit } from "../utils/productUnits.js";
import { effectiveInventoryDay } from "../utils/businessDay.js";
import { updateAppSettings } from "../utils/settings.js";
import { shopLocalParts } from "../utils/shopTime.js";
import { round2 } from "../utils/money.js";
import {
  buildHistoricalWarehouseValuation,
  getWarehouseValuationReport,
  inventoryDayForMovement,
  KNOWN_VALUE_LABEL_AR,
} from "../utils/warehouseValuationHistory.js";

function unwrap(res) {
  return res.body?.data ?? res.body;
}

function sqliteUtcForShop(ymd, hour, minute = 30) {
  const [y, m, d] = ymd.split("-").map(Number);
  for (const dayOffset of [0, -1, 1]) {
    for (let utcHour = 0; utcHour < 24; utcHour += 1) {
      const ms = Date.UTC(y, m - 1, d + dayOffset, utcHour, minute, 0);
      const parts = shopLocalParts(ms);
      if (parts?.ymd === ymd && parts.hour === hour) {
        return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
      }
    }
  }
  throw new Error(`no shop instant for ${ymd} ${hour}:${minute}`);
}

function rowsOf(report, productId) {
  return (report.lines || []).filter((row) => Number(row.product_id) === Number(productId));
}

function ownedRows(report, productId) {
  return rowsOf(report, productId).filter((row) => row.ownership !== "cross_scope");
}

function qtyOf(rows) {
  return rows.reduce((sum, row) => sum + Number(row.quantity), 0);
}

function valueOf(rows) {
  return rows
    .filter((row) => row.cost_known && row.value != null)
    .reduce((sum, row) => round2(sum + Number(row.value)), 0);
}

function assertReconciled(report) {
  const owned = (report.lines || []).filter((row) => row.ownership !== "cross_scope");
  const lineQty = qtyOf(owned);
  const warehouseQty = (report.warehouses || []).reduce((sum, row) => sum + Number(row.total_qty || 0), 0);
  expect(lineQty).toBeCloseTo(warehouseQty, 3);
  const lineKnown = valueOf(owned);
  const warehouseKnown = (report.warehouses || []).reduce((sum, row) => round2(sum + Number(row.total_value || 0)), 0);
  expect(lineKnown).toBeCloseTo(warehouseKnown, 2);
  if (report.known_subtotal != null) expect(Number(report.known_subtotal)).toBeCloseTo(lineKnown, 2);
  const groupQty = (report.category_groups || []).reduce((sum, group) => sum + Number(group.total_qty || 0), 0);
  const groupKnown = (report.category_groups || []).reduce((sum, group) => round2(sum + Number(group.known_value || 0)), 0);
  expect(groupQty).toBeCloseTo(lineQty, 3);
  expect(groupKnown).toBeCloseTo(lineKnown, 2);
}

describe("valuation scope ownership, unknown cost, and business-day dates", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let supplierId;
  let mainId;
  let damagedId;
  let shiftId;
  let seq = 3000;

  const beforeTs = sqliteUtcForShop("2026-09-26", 0, 30);
  const afterTs = sqliteUtcForShop("2026-09-26", 6, 30);

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await updateAppSettings(ctx.db, { business_day_cutoff_hour: 6 });
    await ctx.db.run("INSERT INTO product_categories (name, active) VALUES ('مخبز', 1)");
    supplierId = (
      await ctx.db.run(
        "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد النطاق', 'SC-1', 0, 0)"
      )
    ).lastID;
    const warehouses = unwrap(await request(ctx.app).get("/api/v1/warehouses").set(authHeader(adminToken)));
    mainId = warehouses.find((row) => row.type === "main").id;
    damagedId = warehouses.find((row) => row.type === "damaged").id;
    const shift = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken)).send({});
    expect(shift.status).toBe(201);
    shiftId = unwrap(shift).shift_id;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function makeProduct(name, { scope = "retail", category = "عام", cost = 0 } = {}) {
    seq += 1;
    const barcode = `66${String(seq).padStart(6, "0")}`;
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, cost_known, category, stock, inventory_scope, is_active)
       VALUES (?, ?, 10, ?, NULL, ?, 0, ?, 1)`,
      [barcode, name, cost, category, scope]
    );
    const unit = await upsertProductUnit(ctx.db, ins.lastID, {
      unit_name: "حبة",
      barcode,
      price: 10,
      cost,
      conversion_to_base: 1,
      is_default: true,
      sale_enabled: true,
    });
    return { id: ins.lastID, unitId: unit.id };
  }

  async function postPurchase(product, { qty, total, date }) {
    const create = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        invoice_date: date,
        items: [{ product_id: product.id, unit_id: product.unitId, quantity: qty, total_cost: total }],
      });
    expect(create.status).toBe(201);
    const invoiceId = unwrap(create).id;
    const posted = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${invoiceId}/post`)
      .set(authHeader(adminToken));
    expect(posted.status).toBe(200);
    return invoiceId;
  }

  async function postTransfer(productId, qty, date) {
    const draft = await request(ctx.app)
      .post("/api/v1/warehouses/transfers")
      .set(authHeader(adminToken))
      .send({
        from_warehouse_id: mainId,
        to_warehouse_id: damagedId,
        transfer_date: date,
        items: [{ product_id: productId, quantity: qty }],
      });
    expect(draft.status).toBe(201);
    const id = unwrap(draft).id;
    const posted = await request(ctx.app)
      .post(`/api/v1/warehouses/transfers/${id}/post`)
      .set(authHeader(adminToken));
    expect(posted.status).toBe(200);
    return id;
  }

  async function val(date, membership) {
    const res = await request(ctx.app)
      .get("/api/v1/warehouses/valuation")
      .query({ ...(date ? { as_of: date } : {}), ...(membership ? { membership } : {}) })
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    return unwrap(res);
  }

  test("document inventory dates follow the cutoff, and sales keep the stored shift day", () => {
    expect(shopLocalParts(beforeTs).ymd).toBe("2026-09-26");
    expect(shopLocalParts(beforeTs).hour).toBe(0);
    expect(shopLocalParts(afterTs).hour).toBe(6);
    expect(effectiveInventoryDay("2026-09-26", beforeTs, 6)).toBe("2026-09-25");
    expect(effectiveInventoryDay("2026-09-26", afterTs, 6)).toBe("2026-09-26");
    expect(effectiveInventoryDay("2026-09-20", beforeTs, 6)).toBe("2026-09-20");
    expect(inventoryDayForMovement({
      movement_type: "purchase_receive",
      reference_type: "purchase_invoice",
      business_day: "2026-09-26",
      created_at: beforeTs,
    }, "2026-09-26", 6)).toBe("2026-09-25");
    expect(inventoryDayForMovement({
      movement_type: "purchase_receive",
      reference_type: "purchase_invoice",
      business_day: "2026-09-26",
      created_at: afterTs,
    }, "2026-09-26", 6)).toBe("2026-09-26");
    expect(inventoryDayForMovement({
      movement_type: "sale",
      reference_type: "transaction",
      business_day: "2026-09-25",
      created_at: beforeTs,
    }, "2026-09-25", 6)).toBe("2026-09-25");
  });

  test("retail bakery stock stays in the supermarket total and is labeled outside the bakery total", async () => {
    const finished = await makeProduct("خبز يباع في المتجر", { scope: "retail", category: "مخبز" });
    await postPurchase(finished, { qty: 10, total: 50, date: "2026-08-01" });
    await postTransfer(finished.id, 1, "2026-08-01");
    const material = await makeProduct("طحين مخبز", { scope: "bakery", category: "مخبز" });
    await postPurchase(material, { qty: 6, total: 18, date: "2026-08-01" });
    const grocery = await makeProduct("حليب", { scope: "retail", category: "ألبان" });
    await postPurchase(grocery, { qty: 3, total: 9, date: "2026-08-01" });

    const retail = await val("2026-08-01");
    const bakery = await val("2026-08-01", "bakery");
    assertReconciled(retail);
    assertReconciled(bakery);

    const retailFinished = ownedRows(retail, finished.id);
    expect(qtyOf(retailFinished)).toBeCloseTo(10, 3);
    expect(valueOf(retailFinished)).toBeCloseTo(50, 2);
    expect(retailFinished.every((row) => row.ownership === "owned" && row.inventory_scope === "retail")).toBe(true);
    expect(retailFinished.every((row) => row.category_label === "مخبز" && row.grouping_label === "التصنيف الحالي")).toBe(true);
    expect(retailFinished.find((row) => Number(row.warehouse_id) === mainId).quantity).toBeCloseTo(9, 3);
    expect(retailFinished.find((row) => Number(row.warehouse_id) === damagedId).quantity).toBeCloseTo(1, 3);
    expect(ownedRows(retail, material.id)).toHaveLength(0);
    expect(valueOf(ownedRows(retail, grocery.id))).toBeCloseTo(9, 2);

    const bakeryFinished = rowsOf(bakery, finished.id);
    expect(qtyOf(bakeryFinished)).toBeCloseTo(10, 3);
    expect(valueOf(bakeryFinished)).toBeCloseTo(50, 2);
    expect(bakeryFinished.every((row) => row.ownership === "cross_scope" && row.cross_scope_label)).toBe(true);
    expect(ownedRows(bakery, finished.id)).toHaveLength(0);
    expect(valueOf(ownedRows(bakery, material.id))).toBeCloseTo(18, 2);
    expect(rowsOf(bakery, grocery.id)).toHaveLength(0);
    expect(bakery.cross_scope_note).toBeTruthy();
    expect(Number(bakery.cross_scope_known_value)).toBeGreaterThanOrEqual(50);

    const ownedOnce = valueOf(ownedRows(retail, finished.id)) + valueOf(ownedRows(bakery, finished.id));
    expect(ownedOnce).toBeCloseTo(50, 2);
    const qtyOnce = qtyOf(ownedRows(retail, finished.id)) + qtyOf(ownedRows(bakery, finished.id));
    expect(qtyOnce).toBeCloseTo(10, 3);
    expect(retail.ownership_note).toBeTruthy();
    expect(bakery.date_rule).toBeTruthy();
  });

  test("unknown cost stays null and known totals are labeled incomplete", async () => {
    const known = await makeProduct("ألبان معروفة", { category: "ألبان" });
    await postPurchase(known, { qty: 3, total: 9, date: "2026-08-02" });
    const unknown = await makeProduct("تكلفة مجهولة", { category: "ألبان" });
    await ctx.db.run(
      "UPDATE products SET cost = 9, cost_known = 0, stock = 4 WHERE id = ?",
      [unknown.id]
    );
    await ctx.db.run(
      `INSERT INTO inventory_ledger
         (product_id, movement_type, quantity_delta, qty_before, qty_after, business_day,
          cost_known, unit_cost_after, inventory_scope, category, store_id)
       VALUES (?, 'manual_adjustment', 4, 0, 4, '2026-08-02', 0, NULL, 'retail', 'ألبان', 1)`,
      [unknown.id]
    );

    for (const date of ["2026-08-02", null]) {
      const report = await val(date);
      const lines = rowsOf(report, unknown.id);
      expect(lines).toHaveLength(1);
      expect(lines[0].quantity).toBeCloseTo(4, 3);
      expect(lines[0].cost_known).toBe(false);
      expect(lines[0].unit_cost).toBeNull();
      expect(lines[0].value).toBeNull();
      const group = (report.category_groups || []).find((row) => row.category_label === "ألبان");
      expect(group.money_label).toBe(KNOWN_VALUE_LABEL_AR);
      expect(Number(group.known_value)).toBeGreaterThanOrEqual(9);
      const knownOnly = group.lines
        .filter((row) => row.cost_known && row.value != null)
        .reduce((sum, row) => round2(sum + Number(row.value)), 0);
      expect(Number(group.known_value)).toBeCloseTo(knownOnly, 2);
      expect(group.lines.filter((row) => Number(row.product_id) === unknown.id).every((row) => row.value == null)).toBe(true);
      const warehouse = group.warehouses.find((row) => Number(row.warehouse_id) === Number(lines[0].warehouse_id));
      expect(warehouse.money_label).toBe(KNOWN_VALUE_LABEL_AR);
      expect(report.status).toBe("partial");
      expect(report.valuation_complete).toBe(false);
      expect(report.money_label).toBe(KNOWN_VALUE_LABEL_AR);
      expect(report.status_message).toContain("القيمة المعروفة");
      expect(report.grand_total).toBeNull();
      assertReconciled(report);
    }
  });

  test("before-cutoff purchases and transfers stay on the business day in the live view and the replay", async () => {
    const early = await makeProduct("قبل الساعة");
    const earlyInvoice = await postPurchase(early, { qty: 4, total: 20, date: "2026-09-26" });
    const earlyTransfer = await postTransfer(early.id, 1, "2026-09-26");
    await ctx.db.run(
      "UPDATE inventory_ledger SET business_day = '2026-09-26', created_at = ? WHERE product_id = ? AND movement_type = 'purchase_receive'",
      [beforeTs, early.id]
    );
    await ctx.db.run(
      "UPDATE warehouse_transfers SET inventory_business_day = NULL, transfer_date = '2026-09-26', posted_at = ? WHERE id = ?",
      [beforeTs, earlyTransfer]
    );

    const late = await makeProduct("بعد الساعة");
    await postPurchase(late, { qty: 3, total: 15, date: "2026-09-26" });
    const lateTransfer = await postTransfer(late.id, 1, "2026-09-26");
    await ctx.db.run(
      "UPDATE inventory_ledger SET business_day = '2026-09-26', created_at = ? WHERE product_id = ? AND movement_type = 'purchase_receive'",
      [afterTs, late.id]
    );
    await ctx.db.run(
      "UPDATE warehouse_transfers SET inventory_business_day = NULL, transfer_date = '2026-09-26', posted_at = ? WHERE id = ?",
      [afterTs, lateTransfer]
    );

    const fresh = await makeProduct("ترحيل الآن");
    const freshInvoice = await postPurchase(fresh, { qty: 2, total: 8, date: "2026-09-26" });
    const freshTransfer = await postTransfer(fresh.id, 1, "2026-09-26");
    const freshLedger = await ctx.db.get(
      "SELECT business_day, created_at FROM inventory_ledger WHERE product_id = ? AND movement_type = 'purchase_receive'",
      [fresh.id]
    );
    const freshInvoiceRow = await ctx.db.get("SELECT invoice_date FROM purchase_invoices WHERE id = ?", [freshInvoice]);
    const freshTransferRow = await ctx.db.get(
      "SELECT transfer_date, inventory_business_day FROM warehouse_transfers WHERE id = ?",
      [freshTransfer]
    );
    expect(freshInvoiceRow.invoice_date.slice(0, 10)).toBe("2026-09-26");
    expect(freshTransferRow.transfer_date.slice(0, 10)).toBe("2026-09-26");
    expect(freshLedger.business_day).toBe(effectiveInventoryDay("2026-09-26", freshLedger.created_at, 6));
    expect(freshTransferRow.inventory_business_day).toBe(effectiveInventoryDay("2026-09-26", freshLedger.created_at, 6));

    const earlyInvoiceRow = await ctx.db.get("SELECT invoice_date FROM purchase_invoices WHERE id = ?", [earlyInvoice]);
    expect(earlyInvoiceRow.invoice_date.slice(0, 10)).toBe("2026-09-26");

    const replayPrev = await buildHistoricalWarehouseValuation(ctx.db, {}, "2026-09-25", "2026-09-25", "2026-09-25");
    const replayCal = await buildHistoricalWarehouseValuation(ctx.db, {}, "2026-09-26", "2026-09-26", "2026-09-26");
    expect(qtyOf(rowsOf(replayPrev, early.id))).toBeCloseTo(4, 3);
    expect(valueOf(rowsOf(replayPrev, early.id))).toBeCloseTo(20, 2);
    expect(rowsOf(replayPrev, early.id).find((row) => Number(row.warehouse_id) === mainId).quantity).toBeCloseTo(3, 3);
    expect(rowsOf(replayPrev, early.id).find((row) => Number(row.warehouse_id) === damagedId).quantity).toBeCloseTo(1, 3);
    expect(rowsOf(replayPrev, late.id)).toHaveLength(0);
    expect(qtyOf(rowsOf(replayCal, early.id))).toBeCloseTo(4, 3);
    expect(qtyOf(rowsOf(replayCal, late.id))).toBeCloseTo(3, 3);
    expect(valueOf(rowsOf(replayCal, late.id))).toBeCloseTo(15, 2);
    expect(rowsOf(replayCal, late.id).find((row) => Number(row.warehouse_id) === damagedId).quantity).toBeCloseTo(1, 3);
    assertReconciled(replayPrev);
    assertReconciled(replayCal);

    const shopDay = (await getWarehouseValuationReport(ctx.db, {})).shop_business_day;
    const live = await getWarehouseValuationReport(ctx.db, { asOf: shopDay });
    const replayShop = await buildHistoricalWarehouseValuation(ctx.db, {}, shopDay, shopDay, shopDay);
    for (const productId of [early.id, late.id, fresh.id]) {
      expect(qtyOf(rowsOf(live, productId))).toBeCloseTo(qtyOf(rowsOf(replayShop, productId)), 3);
      expect(valueOf(rowsOf(live, productId))).toBeCloseTo(valueOf(rowsOf(replayShop, productId)), 2);
      for (const warehouseId of [mainId, damagedId]) {
        const liveQty = qtyOf(rowsOf(live, productId).filter((row) => Number(row.warehouse_id) === warehouseId));
        const replayQty = qtyOf(rowsOf(replayShop, productId).filter((row) => Number(row.warehouse_id) === warehouseId));
        expect(liveQty).toBeCloseTo(replayQty, 3);
      }
    }
    expect(qtyOf(rowsOf(live, early.id))).toBeGreaterThan(0);

    await ctx.db.run("UPDATE cashier_shifts SET business_day = '2026-09-25' WHERE id = ?", [shiftId]);
    const sold = await makeProduct("بيع بعد منتصف الليل");
    await postPurchase(sold, { qty: 5, total: 25, date: "2026-09-20" });
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: sold.id, quantity: 1, price: 10, unit_id: sold.unitId }],
        payment_method: "cash",
      }));
    expect(sale.status).toBe(201);
    await ctx.db.run(
      "UPDATE inventory_ledger SET created_at = ? WHERE product_id = ? AND movement_type = 'sale'",
      [beforeTs, sold.id]
    );
    const saleDay = await ctx.db.get(
      "SELECT business_day FROM inventory_ledger WHERE product_id = ? AND movement_type = 'sale'",
      [sold.id]
    );
    expect(saleDay.business_day).toBe("2026-09-25");
    const beforeSale = await buildHistoricalWarehouseValuation(ctx.db, {}, "2026-09-24", "2026-09-25", "2026-09-24");
    const saleDayReport = await buildHistoricalWarehouseValuation(ctx.db, {}, "2026-09-25", "2026-09-25", "2026-09-25");
    expect(qtyOf(rowsOf(beforeSale, sold.id))).toBeCloseTo(5, 3);
    expect(qtyOf(rowsOf(saleDayReport, sold.id))).toBeCloseTo(4, 3);
    expect(valueOf(rowsOf(saleDayReport, sold.id))).toBeCloseTo(20, 2);
  });
});
