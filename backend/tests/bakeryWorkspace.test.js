import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
  createAccountantUser,
} from "./helpers.js";
import { shopTodayYmd } from "../utils/shopTime.js";
import { round2 } from "../utils/money.js";
import { allAccountantPermissionsDisabled } from "../utils/accountantPermissions.js";
import { cacheInvalidate, CACHE_KEYS } from "../utils/cache.js";

function unwrap(res) {
  return res.body?.data ?? res.body;
}

function unwrapList(res) {
  const data = unwrap(res);
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.items) ? data.items : [];
}

describe("bakery office workspace", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let supplierId;
  let bakeryCatId;
  let flourId;
  let breadId;
  let milkId;
  let kgId;
  const today = shopTodayYmd();

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 200 });

    await ctx.db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_tax_rate', '0')");
    cacheInvalidate(CACHE_KEYS.SETTINGS);

    const sup = await ctx.db.run(
      "INSERT INTO suppliers (name, supplier_code, balance, opening_balance) VALUES ('مورد مخبز مشترك', 'S-BK', 0, 0)"
    );
    supplierId = sup.lastID;

    const cat = await request(ctx.app)
      .post("/api/v1/products/categories")
      .set(authHeader(adminToken))
      .send({ name: "مخبز" });
    expect([200, 201]).toContain(cat.status);
    bakeryCatId = unwrap(cat).id || (await ctx.db.get("SELECT id FROM product_categories WHERE name = ?", ["مخبز"])).id;

    await request(ctx.app)
      .put("/api/v1/reports/bakery/categories")
      .set(authHeader(adminToken))
      .send({ category_ids: [bakeryCatId] });

    flourId = unwrap(
      await request(ctx.app)
        .post("/api/v1/products")
        .set(authHeader(adminToken))
        .send({
          barcode: "8817001001",
          name: "طحين مخبز",
          price: 0,
          cost: 2,
          stock: 20,
          unit: "كغم",
          inventory_scope: "bakery",
          category: "مخبز",
        })
    ).id;

    breadId = unwrap(
      await request(ctx.app)
        .post("/api/v1/products")
        .set(authHeader(adminToken))
        .send({
          barcode: "8817002001",
          name: "خبز فرن",
          price: 3,
          cost: 1,
          stock: 40,
          unit: "حبة",
          category: "مخبز",
        })
    ).id;

    milkId = unwrap(
      await request(ctx.app)
        .post("/api/v1/products")
        .set(authHeader(adminToken))
        .send({
          barcode: "8817003001",
          name: "حليب سوبرماركت",
          price: 6,
          cost: 3,
          stock: 50,
          unit: "حبة",
          category: "ألبان",
        })
    ).id;

    kgId = unwrap(
      await request(ctx.app)
        .post("/api/v1/products")
        .set(authHeader(adminToken))
        .send({
          barcode: "8817004001",
          name: "كعك كغم",
          price: 12,
          cost: 5,
          stock: 10,
          unit: "كغم",
          category: "مخبز",
          is_weighed: true,
          scale_code: "2100777",
        })
    ).id;

    await ctx.db.run("UPDATE products SET expiry_date = date('now', '+3 days') WHERE id = ?", [flourId]);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function createInvoice(items, { post = false } = {}) {
    const created = await request(ctx.app)
      .post("/api/v1/purchases/invoices")
      .set(authHeader(adminToken))
      .send({ supplier_id: supplierId, invoice_date: today, items });
    expect(created.status).toBe(201);
    const invoice = unwrap(created);
    if (post) {
      const posted = await request(ctx.app)
        .post(`/api/v1/purchases/invoices/${invoice.id}/post`)
        .set(authHeader(adminToken));
      expect(posted.status).toBe(200);
      return unwrap(posted);
    }
    return invoice;
  }

  test("product lists split materials, finished goods, and workspace without renaming", async () => {
    const materials = unwrapList(
      await request(ctx.app)
        .get("/api/v1/products?membership=bakery&kind=materials")
        .set(authHeader(adminToken))
    );
    expect(materials.some((p) => p.id === flourId)).toBe(true);
    expect(materials.some((p) => p.id === breadId)).toBe(false);
    expect(materials.find((p) => p.id === flourId).inventory_scope).toBe("bakery");

    const finished = unwrapList(
      await request(ctx.app)
        .get("/api/v1/products?membership=bakery&kind=finished")
        .set(authHeader(adminToken))
    );
    expect(finished.some((p) => p.id === breadId)).toBe(true);
    expect(finished.some((p) => p.id === flourId)).toBe(false);
    expect(finished.some((p) => p.id === milkId)).toBe(false);

    const workspace = unwrapList(
      await request(ctx.app)
        .get("/api/v1/products?membership=bakery&kind=workspace")
        .set(authHeader(adminToken))
    );
    expect(workspace.some((p) => p.id === flourId)).toBe(true);
    expect(workspace.some((p) => p.id === breadId)).toBe(true);
    expect(workspace.some((p) => p.id === milkId)).toBe(false);
  });

  test("sales report excludes ingredients unless POS-enabled, and opening it creates no records", async () => {
    const txBefore = await ctx.db.get("SELECT COUNT(*) AS n FROM transactions");
    const ledgerBefore = await ctx.db.get("SELECT COUNT(*) AS n FROM inventory_ledger");

    const { body } = await request(ctx.app)
      .get("/api/v1/reports/bakery")
      .query({ from: today, to: today })
      .set(authHeader(adminToken));
    const report = unwrap({ body });
    expect(report.membership.overlap_count).toBeGreaterThanOrEqual(1);
    expect(report.products.some((p) => p.product_id === flourId)).toBe(false);
    expect(report.products.some((p) => p.product_id === breadId)).toBe(true);
    expect(report.products.find((p) => p.product_id === breadId).revenue_kind).toBe("finished");
    expect(report.kpis.material_net_revenue).toBe(0);
    expect(report.classification.historical_category_snapshot).toBe(false);

    const txAfter = await ctx.db.get("SELECT COUNT(*) AS n FROM transactions");
    const ledgerAfter = await ctx.db.get("SELECT COUNT(*) AS n FROM inventory_ledger");
    expect(Number(txAfter.n)).toBe(Number(txBefore.n));
    expect(Number(ledgerAfter.n)).toBe(Number(ledgerBefore.n));
  });

  test("cashier search hides bakery materials and keeps finished/supermarket SKUs", async () => {
    const cashierSearch = unwrapList(
      await request(ctx.app).get("/api/v1/products").query({ search: "طحين" }).set(authHeader(cashierToken))
    );
    expect(cashierSearch.some((p) => p.id === flourId)).toBe(false);

    const flourLookup = unwrap(
      await request(ctx.app).get("/api/v1/pos/lookup").query({ barcode: "8817001001" }).set(authHeader(cashierToken))
    );
    expect(flourLookup.found).toBe(false);

    const breadSearch = unwrapList(
      await request(ctx.app).get("/api/v1/pos/search?q=خبز").set(authHeader(cashierToken))
    );
    expect(breadSearch.some((p) => p.id === breadId)).toBe(true);

    const breadLookup = unwrap(
      await request(ctx.app).get("/api/v1/pos/lookup").query({ barcode: "8817002001" }).set(authHeader(cashierToken))
    );
    expect(breadLookup.found).toBe(true);

    const milkLookup = unwrap(
      await request(ctx.app).get("/api/v1/pos/lookup").query({ barcode: "8817003001" }).set(authHeader(cashierToken))
    );
    expect(milkLookup.found).toBe(true);
  });

  test("POS sells a bakery finished good once; ingredients stay blocked until sale_enabled", async () => {
    const blocked = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: flourId, quantity: 1, price: 2 }],
        payment_method: "cash",
      }));
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("BAKERY_SUPPLY_NOT_SELLABLE");

    const posMiss = unwrapList(
      await request(ctx.app).get("/api/v1/pos/search?q=طحين").set(authHeader(cashierToken))
    );
    expect(posMiss.some((p) => p.id === flourId)).toBe(false);

    const breadBefore = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [breadId]);
    const rangeBefore = unwrap(
      await request(ctx.app)
        .get("/api/v1/reports/range")
        .query({ from: today, to: today })
        .set(authHeader(adminToken))
    );

    const sold = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [
          { product_id: breadId, quantity: 2, price: 3 },
          { product_id: milkId, quantity: 1, price: 6 },
        ],
        payment_method: "cash",
      }));
    expect(sold.status).toBe(201);

    const breadAfter = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [breadId]);
    expect(Number(breadAfter.stock)).toBe(Number(breadBefore.stock) - 2);

    const bakery = unwrap(
      await request(ctx.app)
        .get("/api/v1/reports/bakery")
        .query({ from: today, to: today })
        .set(authHeader(adminToken))
    );
    const breadRow = bakery.products.find((p) => p.product_id === breadId);
    expect(breadRow.sold_quantity).toBe(2);
    expect(breadRow.net_revenue).toBe(6);
    expect(bakery.products.some((p) => p.product_id === milkId)).toBe(false);

    const rangeAfter = unwrap(
      await request(ctx.app)
        .get("/api/v1/reports/range")
        .query({ from: today, to: today })
        .set(authHeader(adminToken))
    );
    expect(rangeAfter.net_sales).toBe(rangeBefore.net_sales + 2 * 3 + 6);

    const units = unwrap(
      await request(ctx.app).get(`/api/v1/products/${flourId}/units`).set(authHeader(adminToken))
    );
    const unitList = units.units || units;
    const def = unitList.find((u) => Number(u.is_default) === 1) || unitList[0];
    const enable = await request(ctx.app)
      .put(`/api/v1/products/${flourId}/units/${def.id}`)
      .set(authHeader(adminToken))
      .send({ sale_enabled: true });
    expect(enable.status).toBe(200);
    const enabledUnit = unwrap(enable);
    expect(enabledUnit.sale_enabled === true || Number(enabledUnit.sale_enabled) === 1).toBe(true);

    const posHit = unwrapList(
      await request(ctx.app).get("/api/v1/pos/search?q=طحين").set(authHeader(cashierToken))
    );
    expect(posHit.some((p) => p.id === flourId)).toBe(true);
    const flourLookupOn = unwrap(
      await request(ctx.app).get("/api/v1/pos/lookup").query({ barcode: "8817001001" }).set(authHeader(cashierToken))
    );
    expect(flourLookupOn.found).toBe(true);

    const flourSale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{
          product_id: flourId,
          quantity: 1,
          price: enabledUnit.price,
          unit_id: enabledUnit.id,
        }],
        payment_method: "cash",
      }));
    expect(flourSale.status).toBe(201);

    const bakeryAfter = unwrap(
      await request(ctx.app)
        .get("/api/v1/reports/bakery")
        .query({ from: today, to: today })
        .set(authHeader(adminToken))
    );
    const flourRow = bakeryAfter.products.find((p) => p.product_id === flourId);
    expect(flourRow).toBeTruthy();
    expect(flourRow.revenue_kind).toBe("material");
  });

  test("mixed purchase invoices stay one supplier effect and expose bakery subtotals", async () => {
    const balanceBefore = await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId]);
    const flourBefore = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [flourId]);
    const milkBefore = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [milkId]);

    const draft = await createInvoice([
      { product_id: flourId, quantity: 4, total_cost: 8 },
      { product_id: milkId, quantity: 2, total_cost: 6 },
    ]);
    const afterDraft = await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId]);
    expect(Number(afterDraft.balance)).toBe(Number(balanceBefore.balance));
    const flourDraft = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [flourId]);
    expect(Number(flourDraft.stock)).toBe(Number(flourBefore.stock));

    const bakeryList = unwrapList(
      await request(ctx.app)
        .get("/api/v1/purchases/invoices?membership=bakery")
        .set(authHeader(adminToken))
    );
    const mixedRow = bakeryList.find((row) => row.id === draft.id);
    expect(mixedRow).toBeTruthy();
    expect(Number(mixedRow.mixed)).toBe(1);
    expect(Number(mixedRow.bakery_total)).toBe(8);
    expect(Number(mixedRow.invoice_total)).toBe(Number(mixedRow.total));
    expect(Number(mixedRow.invoice_total)).toBeGreaterThan(Number(mixedRow.bakery_total));

    const retailOnly = await createInvoice([{ product_id: milkId, quantity: 1, total_cost: 3 }]);
    const bakeryList2 = unwrapList(
      await request(ctx.app)
        .get("/api/v1/purchases/invoices?membership=bakery")
        .set(authHeader(adminToken))
    );
    expect(bakeryList2.some((row) => row.id === retailOnly.id)).toBe(false);

    const fullList = unwrapList(
      await request(ctx.app).get("/api/v1/purchases/invoices").set(authHeader(adminToken))
    );
    expect(fullList.some((row) => row.id === retailOnly.id)).toBe(true);

    const posted = await request(ctx.app)
      .post(`/api/v1/purchases/invoices/${draft.id}/post`)
      .set(authHeader(adminToken));
    expect(posted.status).toBe(200);

    const balanceAfter = await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId]);
    expect(Number(balanceAfter.balance)).toBe(Number(balanceBefore.balance) + Number(mixedRow.total));

    const flourAfter = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [flourId]);
    const milkAfter = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [milkId]);
    expect(Number(flourAfter.stock)).toBe(Number(flourBefore.stock) + 4);
    expect(Number(milkAfter.stock)).toBe(Number(milkBefore.stock) + 2);

    const detail = unwrap(
      await request(ctx.app)
        .get(`/api/v1/purchases/invoices/${draft.id}?membership=bakery`)
        .set(authHeader(adminToken))
    );
    expect(detail.items).toHaveLength(2);
    expect(detail.items.filter((it) => Number(it.bakery_item) === 1)).toHaveLength(1);
  });

  test("supplier returns use the same mixed-document rules", async () => {
    const invoice = await createInvoice(
      [
        { product_id: breadId, quantity: 5, total_cost: 5 },
        { product_id: milkId, quantity: 5, total_cost: 15 },
      ],
      { post: true }
    );
    const balanceBefore = await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId]);

    const created = await request(ctx.app)
      .post("/api/v1/purchases/returns")
      .set(authHeader(adminToken))
      .send({
        supplier_id: supplierId,
        invoice_id: invoice.id,
        return_date: today,
        items: [
          { product_id: breadId, quantity: 1, total_cost: 1 },
          { product_id: milkId, quantity: 1, total_cost: 3 },
        ],
      });
    expect(created.status).toBe(201);
    const ret = unwrap(created);

    const bakeryReturns = unwrapList(
      await request(ctx.app)
        .get("/api/v1/purchases/returns?membership=bakery")
        .set(authHeader(adminToken))
    );
    const row = bakeryReturns.find((r) => r.id === ret.id);
    expect(row).toBeTruthy();
    expect(Number(row.bakery_total)).toBe(1);
    expect(Number(row.invoice_total)).toBe(Number(row.total));

    const posted = await request(ctx.app)
      .post(`/api/v1/purchases/returns/${ret.id}/post`)
      .set(authHeader(adminToken));
    expect(posted.status).toBe(200);
    const balanceAfter = await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId]);
    expect(Number(balanceAfter.balance)).toBe(Number(balanceBefore.balance) - Number(row.total));
  });

  test("expiry, batches, movements, and fractional bakery sales stay on the shared stock model", async () => {
    const expiry = unwrapList(
      await request(ctx.app)
        .get("/api/v1/inventory/expiry?days=10&membership=bakery")
        .set(authHeader(adminToken))
    );
    expect(expiry.some((p) => p.id === flourId || p.name === "طحين مخبز")).toBe(true);
    expect(expiry.some((p) => p.id === milkId)).toBe(false);

    const batch = await request(ctx.app)
      .post("/api/v1/inventory/batches")
      .set(authHeader(adminToken))
      .send({
        product_id: flourId,
        batch_no: "BK-1",
        expiry_date: today,
        quantity: 1,
        cost: 2,
      });
    expect([200, 201]).toContain(batch.status);

    const batches = unwrapList(
      await request(ctx.app)
        .get("/api/v1/inventory/batches?membership=bakery")
        .set(authHeader(adminToken))
    );
    expect(batches.some((b) => b.batch_no === "BK-1" || b.product_id === flourId)).toBe(true);

    const units = unwrap(
      await request(ctx.app).get(`/api/v1/products/${kgId}/units`).set(authHeader(adminToken))
    );
    const unitList = units.units || units;
    const kgUnit = unitList.find((u) => u.unit_name === "كغم") || unitList[0];
    const frac = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: kgId, unit_id: kgUnit.id, quantity: 0.5, price: 12 }],
        payment_method: "cash",
      }));
    expect(frac.status).toBe(201);

    const bakery = unwrap(
      await request(ctx.app)
        .get("/api/v1/reports/bakery")
        .query({ from: today, to: today })
        .set(authHeader(adminToken))
    );
    const soldUnits = Object.fromEntries(
      (bakery.kpis.sold_quantity_by_unit || []).map((u) => [u.unit, u.quantity])
    );
    expect(soldUnits["كغم"]).toBeGreaterThanOrEqual(0.5);
    expect(soldUnits["حبة"]).toBeGreaterThanOrEqual(2);

    const moves = unwrapList(
      await request(ctx.app)
        .get("/api/v1/inventory/movements?membership=bakery")
        .set(authHeader(adminToken))
    );
    expect(moves.some((m) => Number(m.product_id) === breadId || m.product_name === "خبز فرن")).toBe(true);
    expect(moves.every((m) => Number(m.product_id) !== milkId)).toBe(true);
  });

  test("bakery reporting permission does not grant purchases, returns, or stock edits", async () => {
    const user = await createAccountantUser(ctx.db, {
      username: "bakery-report-only",
      password: "acctpass123",
      permissions: { ...allAccountantPermissionsDisabled(), bakery: true },
    });
    const token = (await login(ctx.app, user.username, user.password, "office")).body.token;
    const hdr = authHeader(token);

    expect((await request(ctx.app).get("/api/v1/reports/bakery").query({ from: today, to: today }).set(hdr)).status).toBe(200);
    expect((await request(ctx.app).get("/api/v1/products?membership=bakery").set(hdr)).status).toBe(200);
    expect((await request(ctx.app).post("/api/v1/purchases/invoices").set(hdr).send({
      supplier_id: supplierId,
      items: [{ product_id: breadId, quantity: 1, total_cost: 1 }],
    })).status).toBe(403);
    expect((await request(ctx.app).get("/api/v1/purchases/returns").set(hdr)).status).toBe(403);
    expect((await request(ctx.app).post("/api/v1/inventory/adjustments").set(hdr).send({
      adjustment_type: "correction",
      items: [{ product_id: breadId, quantity: 1 }],
      post: true,
    })).status).toBe(403);
  });

  test("cashier-enabled material without a sales category is its own revenue line", async () => {
    const hidden = unwrap(
      await request(ctx.app)
        .post("/api/v1/products")
        .set(authHeader(adminToken))
        .send({
          barcode: "8817009001",
          name: "خميرة مخفية",
          price: 4,
          cost: 1,
          stock: 20,
          unit: "كغم",
          inventory_scope: "bakery",
          category: "ألبان",
        })
    );
    const sellable = unwrap(
      await request(ctx.app)
        .post("/api/v1/products")
        .set(authHeader(adminToken))
        .send({
          barcode: "8817009002",
          name: "سكر كاشير",
          price: 9,
          cost: 3,
          stock: 20,
          unit: "كغم",
          inventory_scope: "bakery",
          category: "ألبان",
        })
    );

    const before = unwrap(
      await request(ctx.app)
        .get("/api/v1/reports/bakery")
        .query({ from: today, to: today })
        .set(authHeader(adminToken))
    );
    expect(before.products.some((p) => p.product_id === hidden.id)).toBe(false);
    expect(before.products.some((p) => p.product_id === sellable.id)).toBe(false);
    const finishedBefore = Number(before.kpis.finished_net_revenue) || 0;
    const materialBefore = Number(before.kpis.material_net_revenue) || 0;
    const breadBefore = before.products.find((p) => p.product_id === breadId);
    expect(breadBefore.revenue_kind).toBe("finished");

    const units = unwrap(
      await request(ctx.app).get(`/api/v1/products/${sellable.id}/units`).set(authHeader(adminToken))
    );
    const unitList = units.units || units;
    const def = unitList.find((u) => Number(u.is_default) === 1) || unitList[0];
    const enable = await request(ctx.app)
      .put(`/api/v1/products/${sellable.id}/units/${def.id}`)
      .set(authHeader(adminToken))
      .send({ sale_enabled: true });
    expect(enable.status).toBe(200);
    const enabledUnit = unwrap(enable);
    const unitPrice = Number(enabledUnit.price);

    const sold = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{
          product_id: sellable.id,
          quantity: 2,
          price: unitPrice,
          unit_id: enabledUnit.id,
        }],
        payment_method: "cash",
      }));
    expect(sold.status).toBe(201);

    const after = unwrap(
      await request(ctx.app)
        .get("/api/v1/reports/bakery")
        .query({ from: today, to: today })
        .set(authHeader(adminToken))
    );
    const materialRow = after.products.find((p) => p.product_id === sellable.id);
    expect(materialRow).toBeTruthy();
    expect(materialRow.revenue_kind).toBe("material");
    expect(materialRow.membership_kind).toBe("materials");
    expect(materialRow.net_revenue).toBe(round2(2 * unitPrice));
    expect(after.products.some((p) => p.product_id === hidden.id)).toBe(false);
    expect(after.kpis.material_net_revenue).toBe(round2(materialBefore + (2 * unitPrice)));
    expect(after.kpis.finished_net_revenue).toBe(finishedBefore);
    expect(after.kpis.net_revenue).toBe(
      round2(after.kpis.finished_net_revenue + after.kpis.material_net_revenue)
    );
    expect(after.products.find((p) => p.product_id === breadId).net_revenue).toBe(breadBefore.net_revenue);

    const materialSlice = unwrap(
      await request(ctx.app)
        .get("/api/v1/reports/bakery")
        .query({ from: today, to: today, revenue_kind: "material" })
        .set(authHeader(adminToken))
    );
    expect(materialSlice.products.every((p) => p.revenue_kind === "material")).toBe(true);
    expect(materialSlice.products.some((p) => p.product_id === sellable.id)).toBe(true);
    expect(materialSlice.products.some((p) => p.product_id === breadId)).toBe(false);
    expect(materialSlice.kpis.finished_net_revenue).toBe(0);
    expect(materialSlice.kpis.material_net_revenue).toBe(materialSlice.kpis.net_revenue);

    const finishedSlice = unwrap(
      await request(ctx.app)
        .get("/api/v1/reports/bakery")
        .query({ from: today, to: today, revenue_kind: "finished" })
        .set(authHeader(adminToken))
    );
    expect(finishedSlice.products.some((p) => p.product_id === breadId)).toBe(true);
    expect(finishedSlice.products.some((p) => p.product_id === sellable.id)).toBe(false);

    const badKind = await request(ctx.app)
      .get("/api/v1/reports/bakery")
      .query({ from: today, to: today, revenue_kind: "purchase" })
      .set(authHeader(adminToken));
    expect(badKind.status).toBe(400);

    const suppliesUser = await createAccountantUser(ctx.db, {
      username: "bakery-supplies-report",
      password: "acctpass123",
      permissions: { ...allAccountantPermissionsDisabled(), bakery_supplies: true },
    });
    const suppliesToken = (await login(ctx.app, suppliesUser.username, suppliesUser.password, "office")).body.token;
    const suppliesHdr = authHeader(suppliesToken);
    expect(
      (await request(ctx.app).get("/api/v1/reports/bakery").query({ from: today, to: today }).set(suppliesHdr)).status
    ).toBe(200);
    expect(
      (await request(ctx.app)
        .put("/api/v1/reports/bakery/categories")
        .set(suppliesHdr)
        .send({ category_ids: [bakeryCatId] })).status
    ).toBe(403);
  });
});
