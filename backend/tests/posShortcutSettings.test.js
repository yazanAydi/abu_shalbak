import fs from "fs";
import os from "os";
import path from "path";
import { initDatabase } from "../database/init.js";
import {
  getAppSettings,
  sanitizePosShortcut,
  updateAppSettings,
} from "../utils/settings.js";

describe("POS shortcut settings", () => {
  let db;
  let dbPath;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `pos-shortcuts-${Date.now()}.db`);
    db = await initDatabase(dbPath);
  });

  afterEach(async () => {
    if (db?.close) await db.close();
    try {
      fs.unlinkSync(dbPath);
    } catch (_) {}
  });

  test.each(["F12", "F11", "Ctrl+Shift+I", "ctrl+shift+i", "f12"])(
    "rejects reserved shortcut %s",
    async (key) => {
      await expect(
        updateAppSettings(db, { pos_shortcut_hold_cart: key })
      ).rejects.toThrow(/محجوز للمتصفح/);
      await expect(
        updateAppSettings(db, { pos_shortcut_suspended_carts: key })
      ).rejects.toThrow(/محجوز للمتصفح/);
    }
  );

  test("accepts F8 and stores a display-friendly key", async () => {
    const updated = await updateAppSettings(db, {
      pos_shortcut_hold_cart: "f8",
      pos_shortcut_suspended_carts: "Ctrl+Shift+L",
    });
    expect(updated.pos_shortcut_hold_cart).toBe("F8");
    expect(updated.pos_shortcut_suspended_carts).toBe("Ctrl+Shift+L");

    const reread = await getAppSettings(db);
    expect(reread.pos_shortcut_hold_cart).toBe("F8");
    expect(reread.pos_shortcut_suspended_carts).toBe("Ctrl+Shift+L");
  });

  test("empty value disables the shortcut", async () => {
    await updateAppSettings(db, { pos_shortcut_hold_cart: "F8" });
    const updated = await updateAppSettings(db, { pos_shortcut_hold_cart: "" });
    expect(updated.pos_shortcut_hold_cart).toBe("");
  });

  test("reads of reserved keys already in the database are ignored", async () => {
    await db.run(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ["pos_shortcut_hold_cart", "F12"]
    );
    const settings = await getAppSettings(db);
    expect(settings.pos_shortcut_hold_cart).toBe("");
  });

  test("sanitizePosShortcut rejects F12 and accepts F8", () => {
    expect(() => sanitizePosShortcut("F12")).toThrow(/محجوز للمتصفح/);
    expect(sanitizePosShortcut("F8")).toBe("F8");
  });
});
