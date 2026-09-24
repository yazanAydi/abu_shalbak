import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { initDatabase } from "../database/init.js";
import { closeSqliteConnection } from "../database/sqliteDriver.js";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";

function unwrap(res) {
  return res.body?.data ?? res.body;
}

function errText(res) {
  return String(res.body?.error || "");
}

async function dropColumnIfPresent(db, table, column) {
  const row = await db.get("SELECT 1 AS x FROM pragma_table_info(?) WHERE name = ? LIMIT 1", [
    table,
    column,
  ]);
  if (!row) return;
  try {
    await db.exec(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
    return;
  } catch {
    const cols = await db.all(`PRAGMA table_info("${table}")`);
    const keep = cols.filter((c) => c.name !== column).map((c) => `"${c.name}"`);
    await db.exec("PRAGMA foreign_keys = OFF");
    await db.exec(`CREATE TABLE "${table}__pre" AS SELECT ${keep.join(", ")} FROM "${table}"`);
    await db.exec(`DROP TABLE "${table}"`);
    await db.exec(`ALTER TABLE "${table}__pre" RENAME TO "${table}"`);
    await db.exec("PRAGMA foreign_keys = ON");
  }
}

describe("scale-only products", () => {
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
    return request(ctx.app).post("/api/v1/products").set(authHeader(adminToken)).send(body);
  }

  async function unitsOf(id) {
    const res = await request(ctx.app)
      .get(`/api/v1/products/${id}/units`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    return unwrap(res).units;
  }

  test("creates and edits a scale-only product without a regular barcode", async () => {
    const created = await createProduct({
      name: "بندورة ميزان",
      price: 8,
      stock: 4.5,
      scale_only: 1,
      scale_code: "2100100",
    });
    expect(created.status).toBe(201);
    const row = unwrap(created);
    expect(row.barcode).toBeNull();
    expect(Number(row.scale_only)).toBe(1);
    expect(Number(row.is_weighed)).toBe(1);
    expect(row.unit).toBe("كغم");
    expect(row.scale_code).toBe("2100100");
    expect(row.package_price).toBeNull();
    expect(row.package_conversion).toBeNull();

    const stored = await ctx.db.get(
      "SELECT barcode, scale_only, unit, stock FROM products WHERE id = ?",
      [row.id]
    );
    expect(stored.barcode).toBeNull();
    expect(Number(stored.scale_only)).toBe(1);
    expect(stored.unit).toBe("كغم");
    expect(Number(stored.stock)).toBeCloseTo(4.5, 3);

    const aliases = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM product_barcodes WHERE product_id = ?",
      [row.id]
    );
    expect(Number(aliases.n)).toBe(0);

    const kg = (await unitsOf(row.id)).find((u) => u.unit_name === "كغم");
    expect(kg.barcode).toBe("2100100");
    expect(kg.barcode).not.toBe(row.sku);
    expect(typeof kg.barcode).toBe("string");

    const edited = await request(ctx.app)
      .put(`/api/v1/products/${row.id}`)
      .set(authHeader(adminToken))
      .send({ name: "بندورة ميزان معدّلة", scale_code: "2100101", price: 9 });
    expect(edited.status).toBe(200);
    const next = unwrap(edited);
    expect(next.barcode).toBeNull();
    expect(next.name).toBe("بندورة ميزان معدّلة");
    expect(next.scale_code).toBe("2100101");
    expect(Number(next.price)).toBe(9);
    const kgAfter = (await unitsOf(row.id)).find((u) => u.unit_name === "كغم");
    expect(kgAfter.barcode).toBe("2100101");
    const stillNull = await ctx.db.get("SELECT barcode FROM products WHERE id = ?", [row.id]);
    expect(stillNull.barcode).toBeNull();
  });

  test("keeps internal zeros and does not strip a leading zero into another code", async () => {
    const created = await createProduct({
      name: "خيار ميزان",
      price: 6,
      stock: 1,
      scale_only: true,
      scale_code: "2100010",
    });
    expect(created.status).toBe(201);
    const id = unwrap(created).id;
    const kg = await ctx.db.get(
      "SELECT barcode, typeof(barcode) AS kind FROM product_units WHERE product_id = ? AND unit_name = 'كغم'",
      [id]
    );
    expect(kg.barcode).toBe("2100010");
    expect(kg.kind).toBe("text");
    expect(Number(kg.barcode)).not.toBe(210001);

    const arabic = await createProduct({
      name: "خيار أرقام عربية",
      price: 6,
      stock: 1,
      scale_only: 1,
      scale_code: "٢١٠٠١١١",
    });
    expect(arabic.status).toBe(201);
    expect(unwrap(arabic).scale_code).toBe("2100111");

    const leading = await createProduct({
      name: "صفر في البداية",
      price: 6,
      stock: 1,
      scale_only: 1,
      scale_code: "0210003",
    });
    expect(leading.status).toBe(400);
    expect(errText(leading)).toBe("كود الميزان غير صالح");
  });

  test("rejects a missing, invalid, duplicate, or piece-sale scale code", async () => {
    const missing = await createProduct({
      name: "بدون كود",
      price: 5,
      stock: 1,
      scale_only: 1,
    });
    expect(missing.status).toBe(400);
    expect(errText(missing)).toBe("كود الميزان مطلوب");

    const regularStillNeedsBarcode = await createProduct({
      name: "عادي بدون باركود",
      price: 5,
      stock: 1,
    });
    expect(regularStillNeedsBarcode.status).toBe(400);
    expect(errText(regularStillNeedsBarcode)).toBe("الباركود مطلوب");

    for (const scale_code of ["2200001", "210010", "21001000", "abc"]) {
      const bad = await createProduct({
        name: "كود مرفوض",
        price: 5,
        stock: 1,
        scale_only: 1,
        scale_code,
      });
      expect(bad.status).toBe(400);
      expect(errText(bad)).toBe("كود الميزان غير صالح");
    }

    const first = await createProduct({
      name: "كود مكرر",
      price: 5,
      stock: 1,
      scale_only: 1,
      scale_code: "2100200",
    });
    expect(first.status).toBe(201);

    const dup = await createProduct({
      name: "كود مكرر ٢",
      price: 5,
      stock: 1,
      scale_only: 1,
      scale_code: "2100200",
    });
    expect(dup.status).toBe(409);
    expect(errText(dup)).toBe("رمز الميزان مرتبط بمنتج آخر");

    const piece = await createProduct({
      name: "حبة ومزان",
      price: 5,
      stock: 1,
      scale_only: 1,
      scale_code: "2100201",
      package_conversion: 1,
      package_price: 4,
    });
    expect(piece.status).toBe(400);
    expect(errText(piece)).toBe("البيع بالحبة غير متاح لمنتج يباع بالميزان فقط");

    const same = await createProduct({
      name: "نفس الرمز",
      price: 5,
      stock: 1,
      scale_only: 1,
      barcode: "2100202",
      scale_code: "2100202",
    });
    expect(same.status).toBe(400);
    expect(errText(same)).toBe("كود الميزان يجب أن يختلف عن الباركود");

    const cleared = await request(ctx.app)
      .put(`/api/v1/products/${unwrap(first).id}`)
      .set(authHeader(adminToken))
      .send({ scale_code: "" });
    expect(cleared.status).toBe(400);
    expect(errText(cleared)).toBe("كود الميزان مطلوب");
  });

  test("optional regular barcode stays separate from the PLU", async () => {
    const created = await createProduct({
      name: "جبنة مع باركود",
      price: 22,
      stock: 2,
      scale_only: 1,
      barcode: "6281000000099",
      scale_code: "2100700",
    });
    expect(created.status).toBe(201);
    const row = unwrap(created);
    expect(row.barcode).toBe("6281000000099");
    expect(row.scale_code).toBe("2100700");
    const kg = (await unitsOf(row.id)).find((u) => u.unit_name === "كغم");
    expect(kg.barcode).toBe("2100700");
    const pack = (await unitsOf(row.id)).find((u) => u.unit_name === "حبة" && u.sale_enabled !== false);
    expect(pack).toBeFalsy();
  });

  test("Type A without a scale code still copies the product barcode onto the KG unit", async () => {
    const barcode = "6281000000088";
    const created = await createProduct({
      barcode,
      name: "موزون قديم",
      price: 11,
      stock: 3,
      is_weighed: 1,
      scale_code: null,
    });
    expect(created.status).toBe(201);
    const row = unwrap(created);
    expect(Number(row.scale_only)).toBe(0);
    expect(row.barcode).toBe(barcode);
    const kg = (await unitsOf(row.id)).find((u) => u.unit_name === "كغم");
    expect(kg.barcode).toBe(barcode);
  });

  test("scale label, bare PLU, unknown code, and existing products resolve without mixing identifiers", async () => {
    const scale = unwrap(
      await createProduct({
        name: "تفاح ميزان",
        price: 10,
        stock: 6,
        scale_only: 1,
        scale_code: "2100400",
      })
    );
    const exact = unwrap(
      await createProduct({
        barcode: "2100400999999",
        name: "باركود كامل يبدأ بـ 21",
        price: 4,
        stock: 2,
      })
    );
    const dual = unwrap(
      await createProduct({
        barcode: "6281000000077",
        name: "مرتديلا مزدوجة",
        price: 25,
        stock: 5,
        is_weighed: 1,
        scale_code: "2100410",
        package_conversion: 0.5,
        package_price: 14,
      })
    );

    const label = await request(ctx.app)
      .get("/api/v1/pos/lookup")
      .query({ barcode: "2100400015504" })
      .set(authHeader(cashierToken));
    expect(label.status).toBe(200);
    const labelBody = unwrap(label);
    expect(labelBody.found).toBe(true);
    expect(labelBody.name).toBe("تفاح ميزان");
    expect(labelBody.product.id).toBe(scale.id);
    expect(labelBody.weighed).toBe(true);
    expect(labelBody.weight).toBeCloseTo(1.55, 3);
    expect(labelBody.quantity).toBeCloseTo(1.55, 3);
    expect(labelBody.needs_weight).toBe(false);
    expect(labelBody.unit_name).toBe("كغم");
    expect(Number(labelBody.price)).toBe(10);

    const bare = unwrap(
      await request(ctx.app)
        .get("/api/v1/pos/lookup")
        .query({ barcode: "2100400" })
        .set(authHeader(cashierToken))
    );
    expect(bare.found).toBe(true);
    expect(bare.product.id).toBe(scale.id);
    expect(bare.weighed).toBeUndefined();
    expect(bare.quantity).toBeUndefined();
    expect(bare.weight).toBeUndefined();
    expect(bare.needs_weight).toBe(true);
    expect(bare.unit_name).toBe("كغم");

    const exactHit = unwrap(
      await request(ctx.app)
        .get("/api/v1/products/lookup")
        .query({ barcode: "2100400999999" })
        .set(authHeader(adminToken))
    );
    expect(exactHit.found).toBe(true);
    expect(exactHit.product.id).toBe(exact.id);
    expect(exactHit.product.name).toBe("باركود كامل يبدأ بـ 21");
    expect(exactHit.weighed).toBeUndefined();

    const otherLabel = unwrap(
      await request(ctx.app)
        .get("/api/v1/pos/lookup")
        .query({ barcode: "2100400012500" })
        .set(authHeader(cashierToken))
    );
    expect(otherLabel.product.id).toBe(scale.id);
    expect(otherLabel.weight).toBeCloseTo(1.25, 3);

    const dualLabel = unwrap(
      await request(ctx.app)
        .get("/api/v1/pos/lookup")
        .query({ barcode: "2100410010008" })
        .set(authHeader(cashierToken))
    );
    expect(dualLabel.product.id).toBe(dual.id);
    expect(dualLabel.weighed).toBe(true);
    expect(dualLabel.weight).toBeCloseTo(1, 3);
    expect(dualLabel.unit_name).toBe("كغم");

    const dualPiece = unwrap(
      await request(ctx.app)
        .get("/api/v1/pos/lookup")
        .query({ barcode: "6281000000077" })
        .set(authHeader(cashierToken))
    );
    expect(dualPiece.product.id).toBe(dual.id);
    expect(dualPiece.unit_name).toBe("حبة");
    expect(dualPiece.weighed).toBeUndefined();
    expect(dualPiece.needs_weight).toBe(false);

    const regular = unwrap(
      await request(ctx.app)
        .get("/api/v1/pos/lookup")
        .query({ barcode: "9990001" })
        .set(authHeader(cashierToken))
    );
    expect(regular.found).toBe(true);
    expect(regular.name).toBe("Test Product");
    expect(regular.needs_weight).toBe(false);
    expect(regular.weighed).toBeUndefined();

    const unknown = unwrap(
      await request(ctx.app)
        .get("/api/v1/pos/lookup")
        .query({ barcode: "2100800010004" })
        .set(authHeader(cashierToken))
    );
    expect(unknown.found).toBe(false);
    expect(unknown.error).toBe("كود الميزان غير معروف");
    expect(unknown.product).toBeUndefined();
    expect(unknown.name).toBeUndefined();

    const unknownHttp = await request(ctx.app)
      .get("/api/v1/products/by-barcode/2100800")
      .set(authHeader(cashierToken));
    expect(unknownHttp.status).toBe(404);
    expect(errText(unknownHttp)).toBe("كود الميزان غير معروف");

    const byName = unwrap(
      await request(ctx.app)
        .get("/api/v1/pos/search")
        .query({ q: "تفاح ميزان" })
        .set(authHeader(cashierToken))
    );
    const named = byName.find((row) => row.id === scale.id);
    expect(named).toBeTruthy();
    expect(named.barcode).toBeNull();
    expect(named.scale_code).toBe("2100400");
    expect(Number(named.scale_only)).toBe(1);
    expect(named.unit_name).toBe("كغم");

    const byPlu = unwrap(
      await request(ctx.app)
        .get("/api/v1/products")
        .query({ search: "2100400" })
        .set(authHeader(adminToken))
    );
    expect(byPlu.some((row) => row.id === scale.id)).toBe(true);
  });

  test("a shared code is a conflict instead of a silent product pick", async () => {
    const scale = unwrap(
      await createProduct({
        name: "رمان ميزان",
        price: 12,
        stock: 2,
        scale_only: 1,
        scale_code: "2100300",
      })
    );
    const stolen = await createProduct({
      barcode: "2100300",
      name: "باركود يسرق الكود",
      price: 3,
      stock: 1,
    });
    expect(stolen.status).toBe(409);

    await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, stock, unit, is_weighed, scale_only)
       VALUES ('2100300', 'باركود متعارض', 3, 1, 1, 'حبة', 0, 0)`
    );

    const hit = unwrap(
      await request(ctx.app)
        .get("/api/v1/pos/lookup")
        .query({ barcode: "2100300010005" })
        .set(authHeader(cashierToken))
    );
    expect(hit.found).toBe(false);
    expect(hit.error).toBe("هذا الرمز مستخدم لأكثر من منتج");
    expect(hit.code).toBe("IDENTIFIER_CONFLICT");
    expect(hit.product).toBeUndefined();
    expect(hit.name).toBeUndefined();
    expect(hit.product?.id).not.toBe(scale.id);

    const bare = await request(ctx.app)
      .get("/api/v1/products/2100300")
      .set(authHeader(adminToken));
    expect(bare.status).toBe(409);
    expect(errText(bare)).toBe("هذا الرمز مستخدم لأكثر من منتج");
  });

  test("a scale sale reduces stock by the fractional kilograms", async () => {
    const created = unwrap(
      await createProduct({
        name: "دجاج ميزان فقط",
        price: 30,
        cost: 15,
        stock: 10,
        scale_only: 1,
        scale_code: "2100600",
      })
    );
    const kg = (await unitsOf(created.id)).find((u) => u.unit_name === "كغم");
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          payment_method: "cash",
          items: [
            {
              product_id: created.id,
              unit_id: kg.id,
              quantity: 1.25,
              price: 30,
              scanned_barcode: "2100600012500",
            },
          ],
        })
      );
    expect(sale.status).toBe(201);
    const body = unwrap(sale);
    expect(body.total).toBe(38);

    const item = await ctx.db.get(
      "SELECT quantity, unit_name, unit_price FROM transaction_items WHERE transaction_id = ?",
      [body.transaction_id]
    );
    expect(item.quantity).toBeCloseTo(1.25, 3);
    expect(item.unit_name).toBe("كغم");
    expect(Number(item.unit_price)).toBe(30);

    const stock = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [created.id]);
    expect(Number(stock.stock)).toBeCloseTo(8.75, 3);
    const ledger = await ctx.db.get(
      "SELECT quantity_delta FROM inventory_ledger WHERE product_id = ? AND movement_type = 'sale'",
      [created.id]
    );
    expect(Number(ledger.quantity_delta)).toBeCloseTo(-1.25, 3);
  });

  test("bakery create and edit use the same scale-only rules", async () => {
    const missing = await createProduct({
      name: "طحين ميزان",
      price: 4,
      stock: 2,
      scale_only: 1,
      inventory_scope: "bakery",
    });
    expect(missing.status).toBe(400);
    expect(errText(missing)).toBe("كود الميزان مطلوب");

    const created = await createProduct({
      name: "طحين ميزان",
      price: 4,
      stock: 2.25,
      scale_only: 1,
      scale_code: "2100500",
      inventory_scope: "bakery",
    });
    expect(created.status).toBe(201);
    const row = unwrap(created);
    expect(row.barcode).toBeNull();
    expect(row.inventory_scope).toBe("bakery");
    expect(row.scale_code).toBe("2100500");
    expect(row.unit).toBe("كغم");

    const edited = await request(ctx.app)
      .put(`/api/v1/products/${row.id}`)
      .set(authHeader(adminToken))
      .send({ scale_code: "2100510", name: "طحين ميزان معدّل" });
    expect(edited.status).toBe(200);
    expect(unwrap(edited).barcode).toBeNull();
    expect(unwrap(edited).scale_code).toBe("2100510");
    expect(unwrap(edited).inventory_scope).toBe("bakery");

    const bad = await request(ctx.app)
      .put(`/api/v1/products/${row.id}`)
      .set(authHeader(adminToken))
      .send({ scale_code: "2200510" });
    expect(bad.status).toBe(400);
    expect(errText(bad)).toBe("كود الميزان غير صالح");
  });
});

describe("scale_only migration on a disposable database", () => {
  test("adds the flag without inventing PLUs or changing ids, stock, or barcodes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abo-shalbak-scale-mig-"));
    const dbPath = path.join(tmpDir, "legacy.db");
    let db = await initDatabase(dbPath);
    const weighed = await db.run(
      `INSERT INTO products (barcode, name, price, cost, stock, unit, is_weighed)
       VALUES ('6281777000001', 'منتج قديم', 10, 4, 12.5, 'كغم', 1)`
    );
    await db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
       VALUES (?, 'كغم', '6281777000001', 10, 4, 1, 1)`,
      [weighed.lastID]
    );
    const blank = await db.run(
      `INSERT INTO products (barcode, name, price, cost, stock)
       VALUES (NULL, 'بدون باركود قديم', 3, 1, 4)`
    );
    const productsBefore = await db.all(
      "SELECT id, barcode, name, price, cost, stock FROM products ORDER BY id"
    );
    const unitsBefore = await db.all(
      "SELECT product_id, unit_name, barcode FROM product_units ORDER BY product_id, id"
    );
    const ids = productsBefore.map((row) => row.id);
    expect(ids).toContain(weighed.lastID);
    expect(ids).toContain(blank.lastID);

    await dropColumnIfPresent(db, "products", "scale_only");
    expect(
      await db.get("SELECT 1 AS x FROM pragma_table_info('products') WHERE name = 'scale_only'")
    ).toBeFalsy();
    await closeSqliteConnection(db);

    db = await initDatabase(dbPath);
    const col = await db.get(
      "SELECT 1 AS x FROM pragma_table_info('products') WHERE name = 'scale_only'"
    );
    expect(col).toBeTruthy();
    const productsAfter = await db.all(
      "SELECT id, barcode, name, price, cost, stock FROM products ORDER BY id"
    );
    const unitsAfter = await db.all(
      "SELECT product_id, unit_name, barcode FROM product_units ORDER BY product_id, id"
    );
    expect(productsAfter).toEqual(productsBefore);
    expect(unitsAfter).toEqual(unitsBefore);
    const flags = await db.all("SELECT id, scale_only, barcode FROM products");
    expect(flags.every((row) => Number(row.scale_only) === 0)).toBe(true);
    const oldBlank = flags.find((row) => row.id === blank.lastID);
    expect(oldBlank.barcode).toBeNull();
    const oldWeighed = unitsAfter.find((row) => row.product_id === weighed.lastID);
    expect(oldWeighed.barcode).toBe("6281777000001");

    await closeSqliteConnection(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
