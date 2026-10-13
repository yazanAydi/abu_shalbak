/**
 * Office expiry report: remaining lot quantities, plus a legacy product
 * date only for stock that is not already on a dated lot.
 * Dates use SQLite date('now') so they match the report's julianday window.
 */
import request from "supertest";
import { createTestContext, destroyTestContext, login, authHeader } from "./helpers.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("office expiry report", () => {
  let ctx;
  let adminToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function product(name, stock, expiryModifier) {
    const barcode = `77${String(name.length)}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 1000)}`;
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, stock, unit, expiry_date)
       VALUES (?, ?, 1, 1, ?, 'حبة', ${expiryModifier == null ? "NULL" : "date('now', ?)"})`,
      expiryModifier == null ? [barcode, name, stock] : [barcode, name, stock, expiryModifier]
    );
    return ins.lastID;
  }

  async function lot(productId, batchNo, expiryModifier, quantity) {
    const ins = await ctx.db.run(
      `INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity, cost)
       VALUES (?, ?, date('now', ?), ?, 1)`,
      [productId, batchNo, expiryModifier, quantity]
    );
    return ins.lastID;
  }

  test("lists each remaining lot, skips a depleted lot, and keeps an expired lot", async () => {
    const id = await product("دفعات متعددة", 12, null);
    await lot(id, "SOON", "+4 days", 5);
    await lot(id, "LATER", "+12 days", 7);
    await lot(id, "EMPTY", "+2 days", 0);
    const expiredId = await product("منتهي", 2, null);
    await lot(expiredId, "OLD", "-3 days", 2);
    const farId = await product("بعيد", 4, null);
    await lot(farId, "FAR", "+40 days", 4);

    const rows = unwrap(
      (await request(ctx.app).get("/api/v1/inventory/expiry?days=30").set(authHeader(adminToken))).body
    );
    const mine = rows.filter((row) => row.product_id === id || row.product_id === expiredId || row.product_id === farId);
    expect(mine.map((row) => row.batch_no).sort()).toEqual(["LATER", "OLD", "SOON"]);
    const soon = mine.find((row) => row.batch_no === "SOON");
    const later = mine.find((row) => row.batch_no === "LATER");
    const old = mine.find((row) => row.batch_no === "OLD");
    expect(soon.stock).toBe(5);
    expect(soon.source).toBe("batch");
    expect(later.stock).toBe(7);
    expect(Number(old.days_until_expiry)).toBeLessThan(0);
    expect(old.stock).toBe(2);
    expect(mine.some((row) => row.batch_no === "EMPTY" || row.batch_no === "FAR")).toBe(false);
    expect(mine.reduce((sum, row) => sum + Number(row.stock), 0)).toBe(14);
  });

  test("a product-level date covers only the undated remainder", async () => {
    const id = await product("صلاحية قديمة", 10, "+6 days");
    await lot(id, "SAME", "+6 days", 6);
    await lot(id, "OTHER", "+20 days", 3);
    await lot(id, "GONE", "+1 days", 0);

    const rows = unwrap(
      (await request(ctx.app).get("/api/v1/inventory/expiry?days=30").set(authHeader(adminToken))).body
    );
    const mine = rows.filter((row) => row.product_id === id);
    const legacy = mine.find((row) => row.source === "product");
    const same = mine.find((row) => row.batch_no === "SAME");
    const other = mine.find((row) => row.batch_no === "OTHER");
    expect(legacy.stock).toBe(1);
    expect(legacy.id).toBe(id);
    expect(same.stock).toBe(6);
    expect(other.stock).toBe(3);
    expect(mine.some((row) => row.batch_no === "GONE")).toBe(false);
    expect(mine.reduce((sum, row) => sum + Number(row.stock), 0)).toBe(10);
  });

  test("legacy stock with no lots is the product row, and an empty product is omitted", async () => {
    const live = await product("بدون دفعة", 7, "+5 days");
    const empty = await product("كمية صفر", 0, "+5 days");
    const outside = await product("خارج النافذة", 9, "+45 days");

    const rows = unwrap(
      (await request(ctx.app).get("/api/v1/inventory/expiry?days=30").set(authHeader(adminToken))).body
    );
    const row = rows.find((item) => item.product_id === live || item.id === live);
    expect(row.source).toBe("product");
    expect(row.stock).toBe(7);
    expect(rows.some((item) => item.product_id === empty || item.id === empty)).toBe(false);
    expect(rows.some((item) => item.product_id === outside || item.id === outside)).toBe(false);
  });
});
