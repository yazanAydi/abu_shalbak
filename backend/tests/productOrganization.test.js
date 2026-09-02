import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

function unwrap(res) {
  return res.body?.data ?? res.body;
}

describe("product organization (category/unit)", () => {
  /** @type {Awaited<ReturnType<typeof createTestContext>>} */
  let ctx;
  let adminToken;
  let cashierToken;

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
      .send({
        price: 5,
        stock: 20,
        unit: "حبة",
        ...body,
      });
    expect(res.status).toBe(201);
    return unwrap(res);
  }

  test("admin can update product category", async () => {
    const product = await createProduct({
      barcode: "8800110001",
      name: "جبنة بيضاء",
      category: "ألبان",
      sku: "11001",
    });
    const res = await request(ctx.app)
      .put(`/api/v1/products/${product.id}`)
      .set(authHeader(adminToken))
      .send({ category: "لحوم" });
    expect(res.status).toBe(200);
    expect(unwrap(res).category).toBe("لحوم");
    const row = await ctx.db.get("SELECT category FROM products WHERE id = ?", [product.id]);
    expect(row.category).toBe("لحوم");
  });

  test("unauthorized users cannot update category", async () => {
    const product = await createProduct({
      barcode: "8800110002",
      name: "حليب",
      category: "ألبان",
    });
    const res = await request(ctx.app)
      .put(`/api/v1/products/${product.id}`)
      .set(authHeader(cashierToken))
      .send({ category: "مشروبات" });
    expect(res.status).toBe(403);
    const row = await ctx.db.get("SELECT category FROM products WHERE id = ?", [product.id]);
    expect(row.category).toBe("ألبان");
  });

  test("admin can update display unit and matching product_units row", async () => {
    const product = await createProduct({
      barcode: "8800110003",
      name: "سكر",
      unit: "حبة",
    });
    const beforeUnits = await ctx.db.all(
      "SELECT id, unit_name, conversion_to_base, is_default, barcode, price FROM product_units WHERE product_id = ?",
      [product.id]
    );
    expect(beforeUnits).toHaveLength(1);
    expect(beforeUnits[0].unit_name).toBe("حبة");

    const res = await request(ctx.app)
      .put(`/api/v1/products/${product.id}`)
      .set(authHeader(adminToken))
      .send({ unit: "كيس" });
    expect(res.status).toBe(200);
    expect(unwrap(res).unit).toBe("كيس");

    const after = await ctx.db.get("SELECT unit FROM products WHERE id = ?", [product.id]);
    expect(after.unit).toBe("كيس");
    const afterUnits = await ctx.db.all(
      "SELECT id, unit_name, conversion_to_base, is_default, barcode, price FROM product_units WHERE product_id = ?",
      [product.id]
    );
    expect(afterUnits).toHaveLength(1);
    expect(afterUnits[0].id).toBe(beforeUnits[0].id);
    expect(afterUnits[0].unit_name).toBe("كيس");
    expect(Number(afterUnits[0].conversion_to_base)).toBe(Number(beforeUnits[0].conversion_to_base));
    expect(Number(afterUnits[0].is_default)).toBe(Number(beforeUnits[0].is_default));
    expect(afterUnits[0].barcode).toBe(beforeUnits[0].barcode);
    expect(Number(afterUnits[0].price)).toBe(Number(beforeUnits[0].price));
  });

  test("unit update does not delete other product_units; collision returns 409", async () => {
    const product = await createProduct({
      barcode: "8800110004",
      name: "ماء",
      unit: "قنينة",
    });
    const pack = await request(ctx.app)
      .post(`/api/v1/products/${product.id}/units`)
      .set(authHeader(adminToken))
      .send({
        unit_name: "صندوق",
        barcode: "8800110094",
        price: 24,
        conversion_to_base: 12,
        is_default: false,
      });
    expect(pack.status).toBe(201);

    const beforeIds = (
      await ctx.db.all("SELECT id, unit_name FROM product_units WHERE product_id = ? ORDER BY id", [
        product.id,
      ])
    ).map((u) => ({ id: u.id, unit_name: u.unit_name }));
    expect(beforeIds.map((u) => u.unit_name).sort()).toEqual(["صندوق", "قنينة"]);

    const ok = await request(ctx.app)
      .put(`/api/v1/products/${product.id}`)
      .set(authHeader(adminToken))
      .send({ unit: "علبة" });
    expect(ok.status).toBe(200);
    expect(unwrap(ok).unit).toBe("علبة");

    const afterRename = await ctx.db.all(
      "SELECT id, unit_name FROM product_units WHERE product_id = ? ORDER BY id",
      [product.id]
    );
    expect(afterRename).toHaveLength(2);
    expect(afterRename.map((u) => u.id).sort()).toEqual(beforeIds.map((u) => u.id).sort());
    expect(afterRename.map((u) => u.unit_name).sort()).toEqual(["صندوق", "علبة"]);

    const collision = await request(ctx.app)
      .put(`/api/v1/products/${product.id}`)
      .set(authHeader(adminToken))
      .send({ unit: "صندوق" });
    expect(collision.status).toBe(409);
    expect(unwrap(collision).error || collision.body.error).toMatch(/يملك هذه الوحدة/);

    const afterCollision = await ctx.db.all(
      "SELECT id, unit_name FROM product_units WHERE product_id = ? ORDER BY id",
      [product.id]
    );
    expect(afterCollision.map((u) => u.unit_name).sort()).toEqual(["صندوق", "علبة"]);
    const live = await ctx.db.get("SELECT unit FROM products WHERE id = ?", [product.id]);
    expect(live.unit).toBe("علبة");
  });

  test("category update does not change stock, barcode, or sku", async () => {
    const product = await createProduct({
      barcode: "8800110005",
      name: "لبن",
      category: "ألبان",
      sku: "11005",
      stock: 33,
    });
    await ctx.db.run("UPDATE products SET stock = 33 WHERE id = ?", [product.id]);
    const before = await ctx.db.get(
      "SELECT stock, barcode, sku, unit, price, cost FROM products WHERE id = ?",
      [product.id]
    );

    const res = await request(ctx.app)
      .put(`/api/v1/products/${product.id}`)
      .set(authHeader(adminToken))
      .send({ category: "مشروبات", stock: 0 });
    expect(res.status).toBe(200);
    expect(unwrap(res).category).toBe("مشروبات");

    const after = await ctx.db.get(
      "SELECT stock, barcode, sku, unit, price, cost FROM products WHERE id = ?",
      [product.id]
    );
    expect(Number(after.stock)).toBe(Number(before.stock));
    expect(after.barcode).toBe(before.barcode);
    expect(after.sku).toBe(before.sku);
    expect(after.unit).toBe(before.unit);
    expect(Number(after.price)).toBe(Number(before.price));
    expect(Number(after.cost)).toBe(Number(before.cost));
  });

  test("unit update does not modify historical transactions or create inventory movements", async () => {
    const product = await createProduct({
      barcode: "8800110006",
      name: "خبز",
      unit: "حبة",
      price: 3,
      stock: 50,
    });
    const live = await ctx.db.get("SELECT * FROM products WHERE id = ?", [product.id]);
    const checkout = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: product.id, quantity: 2, price: live.price }],
        payment_method: "cash",
      });
    expect(checkout.status).toBe(201);
    const txId = unwrap(checkout).transaction_id;
    expect(txId).toBeTruthy();

    const itemsBefore = await ctx.db.all(
      `SELECT product_id, quantity, unit_name, product_unit_id, conversion_to_base, unit_price
       FROM transaction_items WHERE transaction_id = ? ORDER BY id`,
      [txId]
    );
    const ledgerBefore = await ctx.db.all(
      "SELECT id, movement_type, quantity_delta FROM inventory_ledger WHERE product_id = ? ORDER BY id",
      [product.id]
    );

    const res = await request(ctx.app)
      .put(`/api/v1/products/${product.id}`)
      .set(authHeader(adminToken))
      .send({ unit: "ربطة" });
    expect(res.status).toBe(200);
    expect(unwrap(res).unit).toBe("ربطة");

    const itemsAfter = await ctx.db.all(
      `SELECT product_id, quantity, unit_name, product_unit_id, conversion_to_base, unit_price
       FROM transaction_items WHERE transaction_id = ? ORDER BY id`,
      [txId]
    );
    expect(itemsAfter).toEqual(itemsBefore);

    const ledgerAfter = await ctx.db.all(
      "SELECT id, movement_type, quantity_delta FROM inventory_ledger WHERE product_id = ? ORDER BY id",
      [product.id]
    );
    expect(ledgerAfter).toEqual(ledgerBefore);
  });

  test("weighed product configuration remains intact when category or unit is patched", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode: "6253341010038",
        name: "مرتديلا",
        price: 25,
        stock: 8,
        is_weighed: true,
        scale_code: "2100099",
        package_conversion: 2,
        package_price: 40,
        sku: "11007",
      });
    expect(created.status).toBe(201);
    const product = unwrap(created);
    expect(product.unit).toBe("كغم");
    expect(product.scale_code).toBe("2100099");
    expect(Number(product.package_conversion)).toBe(2);
    expect(Number(product.package_price)).toBe(40);

    const unitsBefore = await ctx.db.all(
      `SELECT unit_name, barcode, price, cost, conversion_to_base, is_default
       FROM product_units WHERE product_id = ? ORDER BY unit_name`,
      [product.id]
    );
    const stockBefore = await ctx.db.get("SELECT stock, sku, barcode FROM products WHERE id = ?", [
      product.id,
    ]);

    const unitPatch = await request(ctx.app)
      .put(`/api/v1/products/${product.id}`)
      .set(authHeader(adminToken))
      .send({ unit: "حبة" });
    expect(unitPatch.status).toBe(200);
    const afterUnit = unwrap(unitPatch);
    expect(afterUnit.unit).toBe("كغم");
    expect(afterUnit.scale_code).toBe("2100099");
    expect(Number(afterUnit.package_conversion)).toBe(2);
    expect(Number(afterUnit.package_price)).toBe(40);
    expect(afterUnit.barcode).toBe("6253341010038");
    expect(Number(afterUnit.price)).toBe(25);

    const catPatch = await request(ctx.app)
      .put(`/api/v1/products/${product.id}`)
      .set(authHeader(adminToken))
      .send({ category: "لحوم" });
    expect(catPatch.status).toBe(200);
    const afterCat = unwrap(catPatch);
    expect(afterCat.category).toBe("لحوم");
    expect(afterCat.unit).toBe("كغم");
    expect(afterCat.scale_code).toBe("2100099");
    expect(Number(afterCat.package_conversion)).toBe(2);
    expect(Number(afterCat.package_price)).toBe(40);
    expect(afterCat.barcode).toBe(stockBefore.barcode);
    expect(afterCat.sku).toBe(stockBefore.sku);
    expect(Number(afterCat.stock)).toBe(Number(stockBefore.stock));

    const unitsAfter = await ctx.db.all(
      `SELECT unit_name, barcode, price, cost, conversion_to_base, is_default
       FROM product_units WHERE product_id = ? ORDER BY unit_name`,
      [product.id]
    );
    expect(unitsAfter).toEqual(unitsBefore);
  });

  test("admin list filters by category, unit, is_active, catalog_search, and combinations", async () => {
    const dairyKg = await createProduct({
      barcode: "8800110010",
      name: "جبنة صفراء",
      category: "ألبان-تنظيم",
      unit: "كغم",
      sku: "12010",
    });
    const dairyPiece = await createProduct({
      barcode: "8800110011",
      name: "لبن عيران",
      category: "ألبان-تنظيم",
      unit: "حبة",
      sku: "12011",
    });
    const meat = await createProduct({
      barcode: "8800110012",
      name: "مرتديلا تنظيم",
      category: "لحوم-تنظيم",
      unit: "كغم",
      sku: "12012",
    });
    await request(ctx.app)
      .patch(`/api/v1/products/${dairyPiece.id}/active`)
      .set(authHeader(adminToken))
      .send({ is_active: 0 });

    const byCategory = unwrap(
      await request(ctx.app)
        .get("/api/v1/products")
        .query({ category: "ألبان-تنظيم", limit: 50 })
        .set(authHeader(adminToken))
    );
    expect(byCategory.items.map((p) => p.id).sort()).toEqual([dairyKg.id, dairyPiece.id].sort());

    const byUnit = unwrap(
      await request(ctx.app)
        .get("/api/v1/products")
        .query({ unit: "كغم", category: "ألبان-تنظيم", limit: 50 })
        .set(authHeader(adminToken))
    );
    expect(byUnit.items.map((p) => p.id)).toEqual([dairyKg.id]);

    const inactive = unwrap(
      await request(ctx.app)
        .get("/api/v1/products")
        .query({ is_active: 0, category: "ألبان-تنظيم", limit: 50 })
        .set(authHeader(adminToken))
    );
    expect(inactive.items.map((p) => p.id)).toEqual([dairyPiece.id]);

    const byName = unwrap(
      await request(ctx.app)
        .get("/api/v1/products")
        .query({ catalog_search: "عيران", limit: 50 })
        .set(authHeader(adminToken))
    );
    expect(byName.items.some((p) => p.id === dairyPiece.id)).toBe(true);

    const bySku = unwrap(
      await request(ctx.app)
        .get("/api/v1/products")
        .query({ catalog_search: "12012", limit: 50 })
        .set(authHeader(adminToken))
    );
    expect(bySku.items.map((p) => p.id)).toEqual([meat.id]);

    const byBarcode = unwrap(
      await request(ctx.app)
        .get("/api/v1/products")
        .query({ catalog_search: "8800110010", limit: 50 })
        .set(authHeader(adminToken))
    );
    expect(byBarcode.items.map((p) => p.id)).toEqual([dairyKg.id]);

    const combined = unwrap(
      await request(ctx.app)
        .get("/api/v1/products")
        .query({
          category: "ألبان-تنظيم",
          unit: "كغم",
          catalog_search: "جبنة",
          is_active: 1,
          limit: 50,
        })
        .set(authHeader(adminToken))
    );
    expect(combined.items.map((p) => p.id)).toEqual([dairyKg.id]);

    const cashierList = await request(ctx.app)
      .get("/api/v1/products")
      .query({ category: "ألبان-تنظيم" })
      .set(authHeader(cashierToken));
    expect(cashierList.status).toBe(403);

    const posSearch = await request(ctx.app)
      .get("/api/v1/products")
      .query({ search: "عيران", limit: 20 })
      .set(authHeader(cashierToken));
    expect(posSearch.status).toBe(200);
    const posRows = unwrap(posSearch);
    expect(Array.isArray(posRows)).toBe(true);
    expect(posRows.some((p) => p.id === dairyPiece.id)).toBe(true);
  });

  test("admin list filters missing category and unit with __none__", async () => {
    const noCat = await createProduct({
      barcode: "8800110020",
      name: "بدون تصنيف تنظيم",
      category: "ألبان-تنظيم-ناقص",
      unit: "حبة",
    });
    const noUnit = await createProduct({
      barcode: "8800110021",
      name: "بدون وحدة تنظيم",
      category: "لحوم-تنظيم-ناقص",
      unit: "كيس",
    });
    await ctx.db.run("UPDATE products SET category = NULL WHERE id = ?", [noCat.id]);
    await ctx.db.run("UPDATE products SET unit = NULL, is_weighed = 0 WHERE id = ?", [noUnit.id]);

    const byMissingCat = unwrap(
      await request(ctx.app)
        .get("/api/v1/products")
        .query({ category: "__none__", limit: 50 })
        .set(authHeader(adminToken))
    );
    expect(byMissingCat.items.map((p) => p.id)).toEqual(expect.arrayContaining([noCat.id]));
    expect(byMissingCat.items.some((p) => p.id === noUnit.id)).toBe(false);

    const byMissingUnit = unwrap(
      await request(ctx.app)
        .get("/api/v1/products")
        .query({ unit: "__none__", limit: 50 })
        .set(authHeader(adminToken))
    );
    expect(byMissingUnit.items.map((p) => p.id)).toEqual(expect.arrayContaining([noUnit.id]));
    expect(byMissingUnit.items.some((p) => p.id === noCat.id)).toBe(false);
  });
});
