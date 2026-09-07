import fs from "fs";
import os from "os";
import path from "path";
import { initDatabase } from "../database/init.js";
import { getAppSettings, updateAppSettings } from "../utils/settings.js";
import { resolvePrintBranding, STORE_LICENSE_LINE, STORE_NAME_AR, STORE_PHONE } from "../utils/storeBranding.js";

describe("print branding settings", () => {
  let db;
  let dbPath;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `print-branding-${Date.now()}.db`);
    db = await initDatabase(dbPath);
  });

  afterEach(async () => {
    if (db?.close) await db.close();
    try {
      fs.unlinkSync(dbPath);
    } catch (_) {}
  });

  test("seeds store print fields and default visibility", async () => {
    const settings = await getAppSettings(db);
    expect(settings.store_name_ar).toBe(STORE_NAME_AR);
    expect(settings.store_phone).toBe(STORE_PHONE);
    expect(settings.store_address).toBe("");
    expect(settings.store_license).toBe(STORE_LICENSE_LINE);
    expect(settings.print_show_logo).toBe(true);
    expect(settings.print_show_name).toBe(true);
    expect(settings.print_show_phone).toBe(true);
    expect(settings.print_show_address).toBe(false);
    expect(settings.print_show_license).toBe(true);
  });

  test("persists edited store fields and visibility flags", async () => {
    const updated = await updateAppSettings(db, {
      store_name_ar: "متجر الاختبار",
      store_phone: "0590000000",
      store_address: "رام الله",
      store_license: "مشتغل مرخص 111",
      print_show_logo: false,
      print_show_name: true,
      print_show_phone: false,
      print_show_address: true,
      print_show_license: false,
    });
    expect(updated.store_name_ar).toBe("متجر الاختبار");
    expect(updated.store_phone).toBe("0590000000");
    expect(updated.store_address).toBe("رام الله");
    expect(updated.store_license).toBe("مشتغل مرخص 111");
    expect(updated.print_show_logo).toBe(false);
    expect(updated.print_show_phone).toBe(false);
    expect(updated.print_show_address).toBe(true);
    expect(updated.print_show_license).toBe(false);

    const reread = await getAppSettings(db);
    expect(reread.store_name_ar).toBe("متجر الاختبار");
    expect(reread.print_show_address).toBe(true);
  });

  test("resolvePrintBranding hides address unless explicitly enabled", () => {
    const defaults = resolvePrintBranding({});
    expect(defaults.name).toBe(STORE_NAME_AR);
    expect(defaults.phone).toBe(STORE_PHONE);
    expect(defaults.showAddress).toBe(false);
    expect(defaults.showLicense).toBe(true);

    const custom = resolvePrintBranding({
      store_name_ar: "اسم جديد",
      store_address: "العنوان",
      print_show_address: true,
      print_show_phone: false,
    });
    expect(custom.name).toBe("اسم جديد");
    expect(custom.address).toBe("العنوان");
    expect(custom.showAddress).toBe(true);
    expect(custom.showPhone).toBe(false);
  });
});
