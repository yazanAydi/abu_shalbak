import request from "supertest";
import bcrypt from "bcrypt";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { updateAppSettings, SETTING_KEYS } from "../utils/settings.js";
import { defaultAccountantPermissions } from "../utils/accountantPermissions.js";

describe("inventory documents (goods-in / goods-out)", () => {
  let ctx;
  let adminToken;
  let accountantToken;
  let cashierToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    const hash = await bcrypt.hash("acctpass123", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'accountant', 0)",
      ["testaccountant", hash]
    );
    accountantToken = (await login(ctx.app, "testaccountant", "acctpass123", "office")).body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  function unwrap(res) {
    return res.body?.data ?? res.body;
  }

  async function setAccountantPermissions(overrides) {
    await updateAppSettings(ctx.db, {
      [SETTING_KEYS.accountant_permissions]: {
        ...defaultAccountantPermissions(),
        ...overrides,
      },
    });
  }

  async function stockOf(productId) {
    const row = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [productId]);
    return Number(row.stock);
  }

  async function createWeighed(body) {
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
      packUnit: units.find((u) => u.unit_name === "حبة" && u.sale_enabled !== false),
      units,
    };
  }

  test("goods-in 4 حبة × 2 = +8 KG", async () => {
    const p = await createWeighed({
      barcode: "6291000000001",
      name: "مرتديلا إدخال",
      scale_code: "2100201",
      price: 10,
      package_conversion: 2,
      package_price: 12,
    });
    const res = await request(ctx.app)
      .post("/api/v1/inventory-receipts")
      .set(authHeader(adminToken))
      .send({
        reason: "opening",
        items: [{ product_id: p.id, product_unit_id: p.packUnit.id, quantity: 4 }],
      });
    expect(res.status).toBe(201);
    const doc = unwrap(res);
    expect(doc.document_number).toMatch(/^GIN-\d{6}$/);
    expect(doc.items[0].quantity).toBe(4);
    expect(Number(doc.items[0].conversion_used)).toBe(2);
    expect(Number(doc.items[0].base_quantity)).toBe(8);
    expect(await stockOf(p.id)).toBeCloseTo(8, 3);

    const tx = await ctx.db.get("SELECT COUNT(*) AS c FROM transactions");
    const pay = await ctx.db.get("SELECT COUNT(*) AS c FROM sale_payments");
    expect(Number(tx.c)).toBe(0);
    expect(Number(pay.c)).toBe(0);

    const ledger = await ctx.db.get(
      `SELECT movement_type, reference_type, quantity_delta, notes
       FROM inventory_ledger WHERE product_id = ? ORDER BY id DESC LIMIT 1`,
      [p.id]
    );
    expect(ledger.movement_type).toBe("manual_adjustment");
    expect(ledger.reference_type).toBe("inventory_receipt");
    expect(Number(ledger.quantity_delta)).toBeCloseTo(8, 3);
    expect(ledger.notes).toContain("سند إدخال بضاعة");
    expect(ledger.notes).toContain(doc.document_number);
  });

  test("goods-out 0.5 KG then 1 حبة × 2 → 7.5 then 5.5", async () => {
    const p = await createWeighed({
      barcode: "6291000000002",
      name: "مرتديلا إخراج",
      scale_code: "2100202",
      price: 10,
      package_conversion: 2,
      package_price: 12,
    });
    await request(ctx.app)
      .post("/api/v1/inventory-receipts")
      .set(authHeader(adminToken))
      .send({
        reason: "opening",
        items: [{ product_id: p.id, product_unit_id: p.kgUnit.id, quantity: 8 }],
      });
    expect(await stockOf(p.id)).toBeCloseTo(8, 3);

    const outKg = await request(ctx.app)
      .post("/api/v1/inventory-issues")
      .set(authHeader(adminToken))
      .send({
        reason: "damaged",
        items: [{ product_id: p.id, product_unit_id: p.kgUnit.id, quantity: 0.5 }],
      });
    expect(outKg.status).toBe(201);
    expect(unwrap(outKg).document_number).toMatch(/^GOUT-\d{6}$/);
    expect(await stockOf(p.id)).toBeCloseTo(7.5, 3);

    const outPack = await request(ctx.app)
      .post("/api/v1/inventory-issues")
      .set(authHeader(adminToken))
      .send({
        reason: "internal",
        items: [{ product_id: p.id, product_unit_id: p.packUnit.id, quantity: 1 }],
      });
    expect(outPack.status).toBe(201);
    expect(await stockOf(p.id)).toBeCloseTo(5.5, 3);
  });

  test("conversions 1, 1.5, 2, 3.2 convert to base KG", async () => {
    const cases = [
      { conv: 1, barcode: "6291000000011", scale: "2100211" },
      { conv: 1.5, barcode: "6291000000012", scale: "2100212" },
      { conv: 2, barcode: "6291000000013", scale: "2100213" },
      { conv: 3.2, barcode: "6291000000014", scale: "2100214" },
    ];
    for (const c of cases) {
      const p = await createWeighed({
        barcode: c.barcode,
        name: `تحويل ${c.conv}`,
        scale_code: c.scale,
        price: 9,
        package_conversion: c.conv,
        package_price: 11,
      });
      const res = await request(ctx.app)
        .post("/api/v1/inventory-receipts")
        .set(authHeader(adminToken))
        .send({
          reason: "opening",
          items: [{ product_id: p.id, product_unit_id: p.packUnit.id, quantity: 2 }],
        });
      expect(res.status).toBe(201);
      expect(Number(unwrap(res).items[0].base_quantity)).toBeCloseTo(2 * c.conv, 3);
      expect(await stockOf(p.id)).toBeCloseTo(2 * c.conv, 3);
    }
  });

  test("issue beyond stock is allowed and stock may go negative", async () => {
    const p = await createWeighed({
      barcode: "6291000000003",
      name: "جبنة سالب",
      scale_code: "2100203",
      price: 15,
    });
    await request(ctx.app)
      .post("/api/v1/inventory-receipts")
      .set(authHeader(adminToken))
      .send({
        reason: "opening",
        items: [{ product_id: p.id, product_unit_id: p.kgUnit.id, quantity: 2 }],
      });
    const res = await request(ctx.app)
      .post("/api/v1/inventory-issues")
      .set(authHeader(adminToken))
      .send({
        reason: "damaged",
        items: [{ product_id: p.id, product_unit_id: p.kgUnit.id, quantity: 5 }],
      });
    expect(res.status).toBe(201);
    expect(await stockOf(p.id)).toBeCloseTo(-3, 3);
  });

  test("posted document snapshots survive later conversion edits", async () => {
    const p = await createWeighed({
      barcode: "6291000000004",
      name: "مرتديلا لقطة",
      scale_code: "2100204",
      price: 10,
      package_conversion: 2,
      package_price: 12,
    });
    const posted = await request(ctx.app)
      .post("/api/v1/inventory-receipts")
      .set(authHeader(adminToken))
      .send({
        reason: "opening",
        items: [{ product_id: p.id, product_unit_id: p.packUnit.id, quantity: 4 }],
      });
    expect(posted.status).toBe(201);
    const docId = unwrap(posted).id;

    const upd = await request(ctx.app)
      .put(`/api/v1/products/${p.id}/units/${p.packUnit.id}`)
      .set(authHeader(adminToken))
      .send({ conversion_to_base: 1.5, barcode: p.barcode, unit_name: "حبة" });
    expect(upd.status).toBe(200);

    const got = await request(ctx.app)
      .get(`/api/v1/inventory-receipts/${docId}`)
      .set(authHeader(adminToken));
    expect(got.status).toBe(200);
    const line = unwrap(got).items[0];
    expect(Number(line.quantity)).toBe(4);
    expect(Number(line.conversion_used)).toBe(2);
    expect(Number(line.conversion_to_base)).toBe(2);
    expect(Number(line.base_quantity)).toBe(8);
  });

  test("weight-only product: 20 KG in then 0.750 KG out", async () => {
    const p = await createWeighed({
      barcode: "6291000000005",
      name: "جبنة وزن فقط",
      scale_code: "2100205",
      price: 22,
    });
    expect(p.packUnit).toBeUndefined();
    expect(p.units.filter((u) => u.sale_enabled !== false)).toHaveLength(1);

    const gin = await request(ctx.app)
      .post("/api/v1/inventory-receipts")
      .set(authHeader(adminToken))
      .send({
        reason: "opening",
        items: [{ product_id: p.id, product_unit_id: p.kgUnit.id, quantity: 20 }],
      });
    expect(gin.status).toBe(201);
    expect(await stockOf(p.id)).toBeCloseTo(20, 3);

    const gout = await request(ctx.app)
      .post("/api/v1/inventory-issues")
      .set(authHeader(adminToken))
      .send({
        reason: "samples",
        items: [{ product_id: p.id, product_unit_id: p.kgUnit.id, quantity: 0.75 }],
      });
    expect(gout.status).toBe(201);
    expect(await stockOf(p.id)).toBeCloseTo(19.25, 3);
  });

  test("print HTML is an inventory document, not a sale receipt", async () => {
    const p = await createWeighed({
      barcode: "6291000000006",
      name: "منتج طباعة",
      scale_code: "2100206",
      price: 5,
    });
    const created = unwrap(
      await request(ctx.app)
        .post("/api/v1/inventory-receipts")
        .set(authHeader(adminToken))
        .send({
          reason: "opening",
          items: [{ product_id: p.id, product_unit_id: p.kgUnit.id, quantity: 1 }],
        })
    );
    const printRes = await request(ctx.app)
      .get(`/api/v1/inventory-documents/${created.id}/print`)
      .set(authHeader(adminToken));
    expect(printRes.status).toBe(200);
    expect(printRes.headers["content-type"]).toMatch(/text\/html/);
    expect(printRes.text).toContain("سند إدخال بضاعة");
    expect(printRes.text).toContain(created.document_number);
    expect(printRes.text).not.toContain("فاتورة مبيعات");
  });

  test("accountant needs the inventory_receipts permission; cashier can never post", async () => {
    const p = await createWeighed({
      barcode: "6291000000007",
      name: "صلاحيات سند",
      scale_code: "2100207",
      price: 4,
    });

    await setAccountantPermissions({ inventory_receipts: false });

    const deniedList = await request(ctx.app)
      .get("/api/v1/inventory-receipts")
      .set(authHeader(accountantToken));
    expect(deniedList.status).toBe(403);

    const deniedPost = await request(ctx.app)
      .post("/api/v1/inventory-receipts")
      .set(authHeader(accountantToken))
      .send({
        reason: "opening",
        items: [{ product_id: p.id, product_unit_id: p.kgUnit.id, quantity: 1 }],
      });
    expect(deniedPost.status).toBe(403);

    await setAccountantPermissions({ inventory_receipts: true });

    const list = await request(ctx.app)
      .get("/api/v1/inventory-receipts")
      .set(authHeader(accountantToken));
    expect(list.status).toBe(200);

    const acctPost = await request(ctx.app)
      .post("/api/v1/inventory-receipts")
      .set(authHeader(accountantToken))
      .send({
        reason: "opening",
        items: [{ product_id: p.id, product_unit_id: p.kgUnit.id, quantity: 1 }],
      });
    expect(acctPost.status).toBe(201);

    const cashierPost = await request(ctx.app)
      .post("/api/v1/inventory-receipts")
      .set(authHeader(cashierToken))
      .send({
        reason: "opening",
        items: [{ product_id: p.id, product_unit_id: p.kgUnit.id, quantity: 1 }],
      });
    expect(cashierPost.status).toBe(403);
  });
});
