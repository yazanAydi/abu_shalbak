import request from "supertest";
import { computeCartDiscount, getActivePromotions, invalidatePromotionsCache } from "../utils/promotions.js";
import { shopTodayYmd } from "../utils/shopTime.js";
import { allAccountantPermissionsDisabled } from "../utils/accountantPermissions.js";
import {
  createAccountantUser,
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";

function shiftYmd(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

describe("promotion office to POS flow", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let productId;
  let pieceId;
  let cartonId;
  let hiddenUnitId;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    const shift = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 50 });
    expect(shift.status).toBe(201);

    const product = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock)
       VALUES ('8800101', 'حليب العرض', 10, 4, 'ألبان', 120)`
    );
    productId = product.lastID;
    await ctx.db.run(
      "INSERT INTO product_barcodes (product_id, barcode, is_primary) VALUES (?, '8800101', 1)",
      [productId]
    );
    const piece = await ctx.db.run(
      `INSERT INTO product_units
         (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default, sale_enabled)
       VALUES (?, 'حبة', '8800101', 10, 4, 1, 1, 1)`,
      [productId]
    );
    pieceId = piece.lastID;
    const carton = await ctx.db.run(
      `INSERT INTO product_units
         (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default, sale_enabled)
       VALUES (?, 'صندوق', '8800102', 50, 40, 12, 0, 1)`,
      [productId]
    );
    cartonId = carton.lastID;
    const hidden = await ctx.db.run(
      `INSERT INTO product_units
         (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default, sale_enabled)
       VALUES (?, 'كرتونة شراء', '8800103', 48, 40, 12, 0, 0)`,
      [productId]
    );
    hiddenUnitId = hidden.lastID;
    invalidatePromotionsCache();
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function createPromo(body) {
    return request(ctx.app)
      .post("/api/v1/marketing/promotions")
      .set(authHeader(adminToken))
      .send(body);
  }

  test("sale-units lists selling units and keeps a purchase-only unit out", async () => {
    const perms = allAccountantPermissionsDisabled();
    perms.marketing = true;
    const accountant = await createAccountantUser(ctx.db, {
      username: "promoacct",
      permissions: perms,
    });
    const acct = await login(ctx.app, accountant.username, accountant.password, "office");
    const blocked = await request(ctx.app)
      .get(`/api/v1/products/${productId}/units`)
      .set(authHeader(acct.body.token));
    expect(blocked.status).toBe(403);

    const writeBlocked = await request(ctx.app)
      .post(`/api/v1/products/${productId}/units`)
      .set(authHeader(acct.body.token))
      .send({ unit_name: "ممنوع", barcode: "8800991", price: 1, conversion_to_base: 1 });
    expect(writeBlocked.status).toBe(403);

    const res = await request(ctx.app)
      .get(`/api/v1/marketing/products/${productId}/sale-units`)
      .set(authHeader(acct.body.token));
    expect(res.status).toBe(200);
    const units = res.body.data.units;
    expect(units.map((unit) => unit.unit_name)).toEqual(["حبة", "صندوق"]);
    expect(units.find((unit) => unit.unit_name === "صندوق").conversion_to_base).toBe(12);
    expect(units.every((unit) => unit.cost === undefined && unit.sale_enabled === true)).toBe(true);

    const cashierBlocked = await request(ctx.app)
      .get(`/api/v1/marketing/products/${productId}/sale-units`)
      .set(authHeader(cashierToken));
    expect(cashierBlocked.status).toBe(403);

    const noMarketing = await createAccountantUser(ctx.db, {
      username: "nomarketing",
      permissions: allAccountantPermissionsDisabled(),
    });
    const deniedLogin = await login(ctx.app, noMarketing.username, noMarketing.password, "office");
    const denied = await request(ctx.app)
      .get(`/api/v1/marketing/products/${productId}/sale-units`)
      .set(authHeader(deniedLogin.body.token));
    expect(denied.status).toBe(403);
  });

  test("rejects a unit from another product and a unit that is not for sale", async () => {
    const other = await ctx.db.get("SELECT id FROM product_units WHERE product_id = ?", [ctx.productId]);
    const foreign = await createPromo({
      name: "وحدة غريبة",
      offer_type: "multi_price",
      product_id: productId,
      product_unit_id: other.id,
      discount_value: 15,
      buy_qty: 2,
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe("الوحدة لا تتبع هذا المنتج");

    const hidden = await createPromo({
      name: "وحدة شراء",
      offer_type: "multi_price",
      product_id: productId,
      product_unit_id: hiddenUnitId,
      discount_value: 15,
      buy_qty: 2,
    });
    expect(hidden.status).toBe(400);
    expect(hidden.body.error).toBe("هذه الوحدة غير متاحة للبيع");
  });

  test("saves the carton unit, restores it on read, and prices below, at, and above the deal", async () => {
    const created = await createPromo({
      name: "صندوقين بـ 80",
      offer_type: "multi_price",
      product_id: productId,
      product_unit_id: cartonId,
      discount_value: 80,
      buy_qty: 2,
      active: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.product_unit_id).toBe(cartonId);
    expect(created.body.data.unit_name).toBe("صندوق");

    const listed = await request(ctx.app)
      .get("/api/v1/marketing/promotions")
      .set(authHeader(adminToken));
    const row = listed.body.data.find((promo) => promo.id === created.body.data.id);
    expect(row.product_unit_id).toBe(cartonId);
    expect(row.unit_name).toBe("صندوق");

    const active = await request(ctx.app)
      .get("/api/v1/marketing/active")
      .set(authHeader(cashierToken));
    expect(active.body.data.map((promo) => promo.name)).toContain("صندوقين بـ 80");

    async function quote(unitId, quantity) {
      const res = await request(ctx.app)
        .post("/api/v1/marketing/quote")
        .set(authHeader(cashierToken))
        .send({ items: [{ product_id: productId, product_unit_id: unitId, quantity }] });
      expect(res.status).toBe(200);
      return res.body.data;
    }

    expect((await quote(cartonId, 1)).discount).toBe(0);
    expect((await quote(cartonId, 2)).discount).toBe(20);
    expect((await quote(cartonId, 3)).discount).toBe(20);
    expect((await quote(pieceId, 2)).discount).toBe(0);
    expect((await quote(pieceId, 12)).discount).toBe(0);

    const edited = await request(ctx.app)
      .put(`/api/v1/marketing/promotions/${created.body.data.id}`)
      .set(authHeader(adminToken))
      .send({
        name: "صندوقين بـ 80",
        offer_type: "multi_price",
        product_id: productId,
        product_unit_id: cartonId,
        discount_value: 80,
        buy_qty: 2,
        active: true,
      });
    expect(edited.status).toBe(200);
    expect(edited.body.data.product_unit_id).toBe(cartonId);
  });

  test("checkout deducts carton quantity in base pieces and does not stack a second discount", async () => {
    await ctx.db.run("DELETE FROM promotions WHERE product_id = ?", [productId]);
    invalidatePromotionsCache();
    const created = await createPromo({
      name: "صندوقين بـ 80",
      offer_type: "multi_price",
      product_id: productId,
      product_unit_id: cartonId,
      discount_value: 80,
      buy_qty: 2,
    });
    expect(created.status).toBe(201);
    await ctx.db.run(
      `INSERT INTO promotions
         (name, offer_type, product_id, product_unit_id, discount_value, active)
       VALUES ('خصم إضافي', 'percentage', ?, ?, 50, 1)`,
      [productId, cartonId]
    );
    invalidatePromotionsCache();

    const before = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [productId]);
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: productId, unit_id: cartonId, quantity: 2, price: 50 }],
        payment_method: "cash",
      }));
    expect(sale.status).toBe(201);
    expect(Number(sale.body.data.discount)).toBe(20);
    expect(Number(sale.body.data.total)).toBe(80);

    const after = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [productId]);
    expect(Number(after.stock)).toBe(Number(before.stock) - 24);
    const ledger = await ctx.db.get(
      `SELECT quantity_delta FROM inventory_ledger
       WHERE product_id = ? AND reference_id = ? AND movement_type = 'sale'`,
      [productId, sale.body.data.transaction_id]
    );
    expect(Number(ledger.quantity_delta)).toBe(-24);
  });

  test("a disabled offer and an expired offer are not applied", async () => {
    await ctx.db.run("DELETE FROM promotions WHERE product_id = ?", [productId]);
    invalidatePromotionsCache();
    const today = shopTodayYmd();
    const created = await createPromo({
      name: "عرض يُوقف",
      offer_type: "multi_price",
      product_id: productId,
      product_unit_id: pieceId,
      discount_value: 15,
      buy_qty: 2,
    });
    expect(created.status).toBe(201);
    const off = await request(ctx.app)
      .put(`/api/v1/marketing/promotions/${created.body.data.id}`)
      .set(authHeader(adminToken))
      .send({ active: false });
    expect(off.status).toBe(200);

    await ctx.db.run(
      `INSERT INTO promotions
         (name, offer_type, product_id, product_unit_id, discount_value, buy_qty, end_date, active)
       VALUES ('عرض منته', 'multi_price', ?, ?, 15, 2, ?, 1)`,
      [productId, pieceId, shiftYmd(today, -1)]
    );
    invalidatePromotionsCache();

    const active = await getActivePromotions(ctx.db);
    expect(active.map((promo) => promo.name)).not.toContain("عرض يُوقف");
    expect(active.map((promo) => promo.name)).not.toContain("عرض منته");

    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: productId, unit_id: pieceId, quantity: 2, price: 10 }],
        payment_method: "cash",
      }));
    expect(sale.status).toBe(201);
    expect(Number(sale.body.data.discount)).toBe(0);
    expect(Number(sale.body.data.total)).toBe(20);
  });

  test("a category deal counts each sold unit and does not turn one carton into base pieces", () => {
    const promo = {
      id: 77,
      name: "عرض ألبان",
      offer_type: "multi_price",
      category: "ألبان",
      product_unit_id: null,
      discount_value: 15,
      buy_qty: 2,
    };
    const oneCarton = computeCartDiscount([promo], [
      { product_id: productId, product_unit_id: cartonId, category: "ألبان", quantity: 1, unitPrice: 50 },
    ]);
    expect(oneCarton.discount).toBe(0);
    const twoPieces = computeCartDiscount([promo], [
      { product_id: productId, product_unit_id: pieceId, category: "ألبان", quantity: 2, unitPrice: 10 },
    ]);
    expect(twoPieces.discount).toBe(5);
  });
});
