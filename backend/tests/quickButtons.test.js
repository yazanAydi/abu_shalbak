import fs from "fs";
import os from "os";
import path from "path";
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
      { product_id: 1, category: "معجنات" },
      { product_id: 2, category: "بيتزا" },
    ];
    expect(moveButtonsFromRemovedCategories(buttons, oldCats, newCats)).toEqual([
      { product_id: 1, category: "معجنات" },
      { product_id: 2, category: OTHER_QUICK_CATEGORY },
    ]);
  });
});
