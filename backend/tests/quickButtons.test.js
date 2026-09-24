import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { initDatabase } from "../database/init.js";
import {
  DEFAULT_QUICK_CATEGORIES,
  OTHER_QUICK_CATEGORY,
  getAppSettings,
  moveButtonsFromRemovedCategories,
  normalizeQuickButtons,
  normalizeQuickCategories,
  updateAppSettings,
} from "../utils/settings.js";
import { upsertProductUnit } from "../utils/productUnits.js";
import { cacheInvalidate, CACHE_KEYS } from "../utils/cache.js";
import { createTestContext, destroyTestContext, login, authHeader } from "./helpers.js";

describe("quick button categories", () => {
  let db;
  let dbPath;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `quick-buttons-${Date.now()}.db`);
    db = await initDatabase(dbPath);
  });

  afterEach(async () => {
    if (db?.close) await db.close();
    try {
      fs.unlinkSync(dbPath);
    } catch (_) {}
  });

  test("default categories include معجنات, بيتزا, and أخرى", async () => {
    const settings = await getAppSettings(db);
    expect(settings.pos_quick_categories).toEqual(DEFAULT_QUICK_CATEGORIES);
    expect(settings.pos_quick_buttons).toEqual([]);
  });

  test("legacy pos_favorite_product_ids migrate to أخرى on read", async () => {
    await db.run(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ["pos_favorite_product_ids", "[5, 9, 12]"]
    );

    const settings = await getAppSettings(db);
    expect(settings.pos_quick_buttons).toEqual([
      { product_id: 5, category: OTHER_QUICK_CATEGORY },
      { product_id: 9, category: OTHER_QUICK_CATEGORY },
      { product_id: 12, category: OTHER_QUICK_CATEGORY },
    ]);
  });

  test("delete category moves buttons to أخرى via updateAppSettings", async () => {
    await updateAppSettings(db, {
      pos_quick_categories: ["معجنات", "بيتزا", OTHER_QUICK_CATEGORY],
      pos_quick_buttons: [
        { product_id: 1, category: "معجنات" },
        { product_id: 2, category: "بيتزا" },
        { product_id: 3, category: "بيتزا" },
      ],
    });

    const updated = await updateAppSettings(db, {
      pos_quick_categories: ["معجنات", OTHER_QUICK_CATEGORY],
    });

    expect(updated.pos_quick_categories).toEqual(["معجنات", OTHER_QUICK_CATEGORY]);
    expect(updated.pos_quick_buttons).toEqual([
      { product_id: 1, category: "معجنات" },
      { product_id: 2, category: OTHER_QUICK_CATEGORY },
      { product_id: 3, category: OTHER_QUICK_CATEGORY },
    ]);
  });

  test("أخرى is always kept even when omitted from patch", async () => {
    const updated = await updateAppSettings(db, {
      pos_quick_categories: ["معجنات", "بيتزا"],
    });
    expect(updated.pos_quick_categories).toEqual(["معجنات", "بيتزا", OTHER_QUICK_CATEGORY]);
  });

  test("duplicate product_id is deduped on normalize", () => {
    const buttons = normalizeQuickButtons(
      [
        { product_id: 4, category: "معجنات" },
        { product_id: 4, category: "بيتزا" },
        { product_id: 5, category: "بيتزا" },
      ],
      DEFAULT_QUICK_CATEGORIES
    );
    expect(buttons).toEqual([
      { product_id: 4, category: "معجنات" },
      { product_id: 5, category: "بيتزا" },
    ]);
  });

  test("legacy button without product_unit_id stays without a unit", () => {
    const buttons = normalizeQuickButtons(
      [{ product_id: 7, category: "معجنات" }],
      DEFAULT_QUICK_CATEGORIES
    );
    expect(buttons).toEqual([{ product_id: 7, category: "معجنات" }]);
  });

  test("same product with two units is kept", () => {
    const buttons = normalizeQuickButtons(
      [
        { product_id: 4, product_unit_id: 11, category: "معجنات" },
        { product_id: 4, productUnitId: 22, category: "بيتزا" },
      ],
      DEFAULT_QUICK_CATEGORIES
    );
    expect(buttons).toEqual([
      { product_id: 4, category: "معجنات", product_unit_id: 11 },
      { product_id: 4, category: "بيتزا", product_unit_id: 22 },
    ]);
  });

  test("same product and same unit is collapsed", () => {
    const buttons = normalizeQuickButtons(
      [
        { product_id: 4, product_unit_id: 11, category: "معجنات" },
        { product_id: 4, product_unit_id: 11, category: "بيتزا" },
      ],
      DEFAULT_QUICK_CATEGORIES
    );
    expect(buttons).toEqual([{ product_id: 4, category: "معجنات", product_unit_id: 11 }]);
  });

  test("invalid product_unit_id is dropped", () => {
    const buttons = normalizeQuickButtons(
      [{ product_id: 8, product_unit_id: "x", category: "بيتزا" }],
      DEFAULT_QUICK_CATEGORIES
    );
    expect(buttons).toEqual([{ product_id: 8, category: "بيتزا" }]);
  });

  test("invalid button category falls back to أخرى", () => {
    const buttons = normalizeQuickButtons(
      [{ product_id: 7, category: "غير موجود" }],
      DEFAULT_QUICK_CATEGORIES
    );
    expect(buttons).toEqual([{ product_id: 7, category: OTHER_QUICK_CATEGORY }]);
  });

  test("normalizeQuickCategories always ensures أخرى exists", () => {
    expect(normalizeQuickCategories(["معجنات", "بيتزا"])).toEqual([
      "معجنات",
      "بيتزا",
      OTHER_QUICK_CATEGORY,
    ]);
  });

  test("moveButtonsFromRemovedCategories helper", () => {
    const oldCats = ["معجنات", "بيتزا", OTHER_QUICK_CATEGORY];
    const newCats = ["معجنات", OTHER_QUICK_CATEGORY];
    const buttons = [
      { product_id: 1, category: "معجنات", product_unit_id: 11 },
      { product_id: 2, category: "بيتزا" },
    ];
    expect(moveButtonsFromRemovedCategories(buttons, oldCats, newCats)).toEqual([
      { product_id: 1, category: "معجنات", product_unit_id: 11 },
      { product_id: 2, category: OTHER_QUICK_CATEGORY },
    ]);
  });

  test("updateAppSettings persists product_unit_id", async () => {
    const updated = await updateAppSettings(db, {
      pos_quick_buttons: [{ product_id: 1, category: "معجنات", product_unit_id: 99 }],
    });
    expect(updated.pos_quick_buttons).toEqual([
      { product_id: 1, category: "معجنات", product_unit_id: 99 },
    ]);
  });
});

describe("GET /api/pos/quick-buttons units", () => {
  let ctx;
  let cashierToken;
  let pieceUnit;
  let boxUnit;

  beforeAll(async () => {
    ctx = await createTestContext();
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = cashierLogin.body.token;
    pieceUnit = await ctx.db.get(
      "SELECT * FROM product_units WHERE product_id = ? AND is_default = 1",
      [ctx.productId]
    );
    boxUnit = await upsertProductUnit(ctx.db, ctx.productId, {
      unit_name: "صندوق",
      barcode: "9990002",
      price: 48,
      cost: 24,
      conversion_to_base: 12,
      is_default: false,
    });
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  beforeEach(() => {
    cacheInvalidate(CACHE_KEYS.SETTINGS);
  });

  test("box button returns box price and name, not the default piece", async () => {
    await updateAppSettings(ctx.db, {
      pos_quick_buttons: [
        {
          product_id: ctx.productId,
          category: OTHER_QUICK_CATEGORY,
          product_unit_id: boxUnit.id,
        },
      ],
    });

    const res = await request(ctx.app)
      .get("/api/pos/quick-buttons")
      .set(authHeader(cashierToken));
    expect(res.status).toBe(200);
    const items = res.body.buttonsByCategory[OTHER_QUICK_CATEGORY];
    expect(items).toHaveLength(1);
    expect(items[0].unit_id).toBe(boxUnit.id);
    expect(items[0].unit_name).toBe("صندوق");
    expect(Number(items[0].price)).toBe(48);
    expect(items[0].selectedUnit?.id).toBe(boxUnit.id);
    expect(items[0].availableUnits.map((u) => u.unit_name).sort()).toEqual(["حبة", "صندوق"]);
  });

  test("legacy button without unit uses the default sale unit", async () => {
    await updateAppSettings(ctx.db, {
      pos_quick_buttons: [{ product_id: ctx.productId, category: OTHER_QUICK_CATEGORY }],
    });

    const res = await request(ctx.app)
      .get("/api/pos/quick-buttons")
      .set(authHeader(cashierToken));
    expect(res.status).toBe(200);
    const items = res.body.buttonsByCategory[OTHER_QUICK_CATEGORY];
    expect(items).toHaveLength(1);
    expect(items[0].unit_id).toBe(pieceUnit.id);
    expect(items[0].unit_name).toBe("حبة");
    expect(Number(items[0].price)).toBe(10);
  });

  test("same product can appear twice with different units", async () => {
    await updateAppSettings(ctx.db, {
      pos_quick_buttons: [
        {
          product_id: ctx.productId,
          category: OTHER_QUICK_CATEGORY,
          product_unit_id: pieceUnit.id,
        },
        {
          product_id: ctx.productId,
          category: OTHER_QUICK_CATEGORY,
          product_unit_id: boxUnit.id,
        },
      ],
    });

    const res = await request(ctx.app)
      .get("/api/pos/quick-buttons")
      .set(authHeader(cashierToken));
    expect(res.status).toBe(200);
    const items = res.body.buttonsByCategory[OTHER_QUICK_CATEGORY];
    expect(items).toHaveLength(2);
    const names = items.map((p) => p.unit_name).sort();
    expect(names).toEqual(["حبة", "صندوق"]);
    expect(items.find((p) => p.unit_name === "صندوق").price).toBe(48);
    expect(items.find((p) => p.unit_name === "حبة").price).toBe(10);
  });
});

describe("quick buttons beyond the old 48 cap", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let buttons;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123", "office");
    adminToken = adminLogin.body.token;
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = cashierLogin.body.token;

    buttons = [];
    for (let i = 0; i < 100; i += 1) {
      const barcode = `77${String(i).padStart(6, "0")}`;
      const ins = await ctx.db.run(
        `INSERT INTO products (barcode, name, price, cost, category, stock)
         VALUES (?, ?, ?, 1, 'Test', 10)`,
        [barcode, `سريع ${i + 1}`, i + 1]
      );
      const unit = await ctx.db.run(
        `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
         VALUES (?, 'حبة', ?, ?, 1, 1, 1)`,
        [ins.lastID, barcode, i + 1]
      );
      const category = i % 2 === 0 ? "معجنات" : "بيتزا";
      buttons.push({
        product_id: ins.lastID,
        category,
        product_unit_id: unit.lastID,
      });
    }
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  beforeEach(() => {
    cacheInvalidate(CACHE_KEYS.SETTINGS);
  });

  test("saves, reloads, reorders, edits, and removes a 100-button list", async () => {
    const saved = await updateAppSettings(ctx.db, { pos_quick_buttons: buttons });
    expect(saved.pos_quick_buttons).toHaveLength(100);
    expect(saved.pos_quick_buttons[48]).toEqual(buttons[48]);
    expect(saved.pos_quick_buttons[99]).toEqual(buttons[99]);

    cacheInvalidate(CACHE_KEYS.SETTINGS);
    const reloaded = await getAppSettings(ctx.db);
    expect(reloaded.pos_quick_buttons).toEqual(buttons);

    const patched = await request(ctx.app)
      .patch("/api/v1/settings")
      .set(authHeader(adminToken))
      .send({ pos_quick_buttons: buttons });
    expect(patched.status).toBe(200);
    expect(patched.body.data?.pos_quick_buttons || patched.body.pos_quick_buttons).toHaveLength(100);

    const reordered = [buttons[60], ...buttons.slice(0, 60), ...buttons.slice(61)];
    const edited = reordered.map((b, index) =>
      index === 49 ? { ...b, category: OTHER_QUICK_CATEGORY } : b
    );
    const removed = edited.filter((_, index) => index !== 70);
    const after = await updateAppSettings(ctx.db, { pos_quick_buttons: removed });
    expect(after.pos_quick_buttons).toHaveLength(99);
    expect(after.pos_quick_buttons[0]).toEqual({
      ...buttons[60],
      category: buttons[60].category,
    });
    expect(after.pos_quick_buttons[49].category).toBe(OTHER_QUICK_CATEGORY);
    expect(after.pos_quick_buttons[49].product_id).toBe(edited[49].product_id);
    expect(after.pos_quick_buttons.some((b) => b.product_id === edited[70].product_id)).toBe(false);

    const small = buttons.slice(0, 3);
    const smallSaved = await updateAppSettings(ctx.db, { pos_quick_buttons: small });
    expect(smallSaved.pos_quick_buttons).toEqual(small);
  });

  test("POS lists every button and the one past position 48 keeps its product and unit", async () => {
    await updateAppSettings(ctx.db, { pos_quick_buttons: buttons });
    const res = await request(ctx.app)
      .get("/api/pos/quick-buttons")
      .set(authHeader(cashierToken));
    expect(res.status).toBe(200);

    const pastry = res.body.buttonsByCategory["معجنات"];
    const pizza = res.body.buttonsByCategory["بيتزا"];
    expect(pastry).toHaveLength(50);
    expect(pizza).toHaveLength(50);
    expect(pastry[24].id).toBe(buttons[48].product_id);
    expect(pastry[24].unit_id).toBe(buttons[48].product_unit_id);
    expect(pastry[24].name).toBe("سريع 49");
    expect(pizza[0].id).toBe(buttons[1].product_id);
    expect(res.body.categories).toEqual(expect.arrayContaining(["معجنات", "بيتزا"]));
  });
});
