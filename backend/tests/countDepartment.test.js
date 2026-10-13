/**
 * Supermarket and bakery stock counts are separate documents.
 * Uses disposable databases only.
 */
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { initDatabase } from "../database/init.js";
import { closeSqliteConnection } from "../database/sqliteDriver.js";
import { allAccountantPermissionsDisabled } from "../utils/accountantPermissions.js";
import {
  authHeader,
  createAccountantUser,
  createTestContext,
  destroyTestContext,
  login,
} from "./helpers.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("stock count departments", () => {
  test("mixed open drafts split by inventory scope without posting, and ambiguity is kept", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abo-count-dept-"));
    const dbPath = path.join(tmpDir, "counts.db");
    expect(dbPath.toLowerCase()).not.toMatch(/supermarket/);
    let db;
    try {
      db = await initDatabase(dbPath);
      const warehouse = await db.get("SELECT id FROM warehouses WHERE type = 'main' ORDER BY id LIMIT 1");
      const retail = await db.run(
        `INSERT INTO products (barcode, name, price, cost, category, stock, inventory_scope)
         VALUES ('7700000001', 'حليب', 5, 2, 'ألبان', 20, 'retail')`
      );
      const bakery = await db.run(
        `INSERT INTO products (barcode, name, price, cost, category, stock, inventory_scope)
         VALUES ('8800000001', 'طحين', 4, 1, 'مخبز', 10, 'bakery')`
      );
      const odd = await db.run(
        `INSERT INTO products (barcode, name, price, cost, category, stock, inventory_scope)
         VALUES ('9900000001', 'صنف غامض', 3, 1, 'أخرى', 7, 'shared')`
      );
      const retailOther = await db.run(
        `INSERT INTO products (barcode, name, price, cost, category, stock, inventory_scope)
         VALUES ('7700000002', 'جبن', 5, 2, 'ألبان', 8, 'retail')`
      );
      const posted = await db.run(
        "INSERT INTO stock_count_sessions (status, notes, posted_at) VALUES ('posted', 'تاريخي مختلط', '2026-01-01 00:00:00')"
      );
      const openMixed = await db.run(
        "INSERT INTO stock_count_sessions (status, notes, created_at) VALUES ('open', 'مسودة مختلطة', '2026-02-01 00:00:00')"
      );
      const openOdd = await db.run(
        "INSERT INTO stock_count_sessions (status, notes) VALUES ('open', 'مسودة غامضة')"
      );
      const openRetailBusy = await db.run(
        "INSERT INTO stock_count_sessions (status, notes) VALUES ('open', 'متجر ثان')"
      );
      const ledgerBefore = Number((await db.get("SELECT COUNT(*) AS n FROM inventory_ledger")).n);
      async function addLine(sessionId, productId, counted, batchSource, expiry) {
        return db.run(
          `INSERT INTO stock_count_lines
             (session_id, product_id, system_qty, counted_qty, variance, batch_source, expiry_date, warehouse_id)
           VALUES (?, ?, 1, ?, 0, ?, ?, ?)`,
          [sessionId, productId, counted, batchSource, expiry, warehouse?.id || null]
        );
      }
      const postedRetail = await addLine(posted.lastID, retail.lastID, 3, "dated", "2031-04-01");
      const postedBakery = await addLine(posted.lastID, bakery.lastID, 0, "undated", null);
      const openRetailLine = await addLine(openMixed.lastID, retail.lastID, 9, "dated", "2032-01-15");
      const openBakeryLine = await addLine(openMixed.lastID, bakery.lastID, 4, "undated", null);
      const oddLine = await addLine(openOdd.lastID, odd.lastID, 2, null, null);
      await addLine(openRetailBusy.lastID, retailOther.lastID, 5, null, null);

      await closeSqliteConnection(db);
      db = null;
      db = await initDatabase(dbPath);

      const mixed = await db.get("SELECT * FROM stock_count_sessions WHERE id = ?", [openMixed.lastID]);
      expect(mixed.status).toBe("open");
      expect(mixed.department).toBe("retail");
      expect(mixed.notes).toBe("مسودة مختلطة");
      const split = await db.get(
        "SELECT * FROM stock_count_sessions WHERE split_from_session_id = ? AND status = 'open'",
        [openMixed.lastID]
      );
      expect(split.department).toBe("bakery");
      expect(split.notes).toBe("مسودة مختلطة");
      const retailLine = await db.get("SELECT * FROM stock_count_lines WHERE id = ?", [openRetailLine.lastID]);
      const bakeryLine = await db.get("SELECT * FROM stock_count_lines WHERE id = ?", [openBakeryLine.lastID]);
      expect(retailLine.session_id).toBe(openMixed.lastID);
      expect(Number(retailLine.counted_qty)).toBe(9);
      expect(retailLine.batch_source).toBe("dated");
      expect(retailLine.expiry_date).toBe("2032-01-15");
      expect(retailLine.warehouse_id).toBe(warehouse?.id || null);
      expect(bakeryLine.session_id).toBe(split.id);
      expect(Number(bakeryLine.counted_qty)).toBe(4);
      expect(bakeryLine.batch_source).toBe("undated");
      expect(bakeryLine.expiry_date).toBeNull();

      const historical = await db.get("SELECT * FROM stock_count_sessions WHERE id = ?", [posted.lastID]);
      expect(historical.status).toBe("posted");
      expect(historical.department).toBeNull();
      expect(historical.posted_at).toBe("2026-01-01 00:00:00");
      const historicalLines = await db.all(
        "SELECT id, session_id, counted_qty FROM stock_count_lines WHERE session_id = ? ORDER BY id",
        [posted.lastID]
      );
      expect(historicalLines.map((line) => line.id)).toEqual([postedRetail.lastID, postedBakery.lastID]);
      expect(historicalLines.map((line) => Number(line.counted_qty))).toEqual([3, 0]);

      const oddSession = await db.get("SELECT * FROM stock_count_sessions WHERE id = ?", [openOdd.lastID]);
      expect(oddSession.status).toBe("open");
      expect(oddSession.department).toBeNull();
      const hold = await db.get(
        "SELECT * FROM stock_count_department_holds WHERE session_id = ?",
        [openOdd.lastID]
      );
      expect(hold.reason).toBe("ambiguous_lines");
      const detail = JSON.parse(hold.detail_json);
      expect(detail.lines.map((line) => line.line_id)).toEqual([oddLine.lastID]);
      expect(detail.lines[0].kind).toBe("unknown_scope");
      expect(Number((await db.get("SELECT counted_qty FROM stock_count_lines WHERE id = ?", [oddLine.lastID])).counted_qty)).toBe(2);

      const busy = await db.get("SELECT * FROM stock_count_sessions WHERE id = ?", [openRetailBusy.lastID]);
      expect(busy.department).toBeNull();
      expect(busy.status).toBe("open");
      const busyHold = await db.get(
        "SELECT reason FROM stock_count_department_holds WHERE session_id = ?",
        [openRetailBusy.lastID]
      );
      expect(busyHold.reason).toBe("department_busy");

      expect(Number((await db.get("SELECT stock FROM products WHERE id = ?", [retail.lastID])).stock)).toBe(20);
      expect(Number((await db.get("SELECT stock FROM products WHERE id = ?", [bakery.lastID])).stock)).toBe(10);
      expect(Number((await db.get("SELECT stock FROM products WHERE id = ?", [odd.lastID])).stock)).toBe(7);
      expect(Number((await db.get("SELECT COUNT(*) AS n FROM inventory_ledger")).n)).toBe(ledgerBefore);

      const beforeRepeat = await db.all(
        "SELECT id, status, department, split_from_session_id FROM stock_count_sessions ORDER BY id"
      );
      const beforeLines = await db.all(
        "SELECT id, session_id, counted_qty, expiry_date, batch_source FROM stock_count_lines ORDER BY id"
      );
      await closeSqliteConnection(db);
      db = null;
      db = await initDatabase(dbPath);
      const afterRepeat = await db.all(
        "SELECT id, status, department, split_from_session_id FROM stock_count_sessions ORDER BY id"
      );
      const afterLines = await db.all(
        "SELECT id, session_id, counted_qty, expiry_date, batch_source FROM stock_count_lines ORDER BY id"
      );
      expect(afterRepeat).toEqual(beforeRepeat);
      expect(afterLines).toEqual(beforeLines);
    } finally {
      if (db) await closeSqliteConnection(db);
    }
  });
});

describe("independent supermarket and bakery counts", () => {
  let ctx;
  let adminToken;
  let bakeryToken;
  let seq = 0;

  beforeAll(async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TELEGRAM_")) delete process.env[key];
    }
    ctx = await createTestContext();
    expect(ctx.dbPath).toMatch(/abo-shalbak-test-/);
    expect(ctx.dbPath.toLowerCase()).not.toMatch(/supermarket/);
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    const bakeryUser = await createAccountantUser(ctx.db, {
      username: "bakery-count-only",
      password: "acctpass123",
      permissions: { ...allAccountantPermissionsDisabled(), bakery_supplies: true },
    });
    bakeryToken = (await login(ctx.app, bakeryUser.username, bakeryUser.password)).body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function makeProduct(name, scope, stock) {
    seq += 1;
    const barcode = `${scope === "bakery" ? "66" : "55"}${String(seq).padStart(8, "0")}`;
    const ins = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, inventory_scope)
       VALUES (?, ?, 8, 2, ?, ?, ?)`,
      [barcode, name, scope === "bakery" ? "مخبز" : "ألبان", stock, scope]
    );
    return { id: ins.lastID, barcode };
  }

  async function stockOf(id) {
    return Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [id])).stock);
  }

  async function openDepartment(department) {
    const created = await request(ctx.app)
      .post("/api/v1/inventory/counts")
      .set(authHeader(adminToken))
      .send({ department });
    expect(created.status).toBe(201);
    return unwrap(created.body);
  }

  test("each department saves and posts only its own document", async () => {
    const market = await makeProduct("سوق", "retail", 20);
    const flour = await makeProduct("دقيق", "bakery", 10);
    await ctx.db.run(
      `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default, sale_enabled)
       VALUES (?, 'كغم', ?, 8, 2, 1, 1, 1)`,
      [flour.id, `${flour.barcode}-U`]
    );
    const beforeLedger = await ctx.db.all(
      "SELECT id, quantity_delta, reference_id FROM inventory_ledger WHERE product_id IN (?, ?) ORDER BY id",
      [market.id, flour.id]
    );

    const [retailSession, bakerySession] = await Promise.all([
      openDepartment("retail"),
      openDepartment("bakery"),
    ]);
    expect(retailSession.id).not.toBe(bakerySession.id);
    expect(retailSession.department).toBe("retail");
    expect(bakerySession.department).toBe("bakery");

    const plainMarket = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${retailSession.id}/lines`)
      .set(authHeader(adminToken))
      .send({ department: "retail", product_id: market.id, counted_qty: 9 });
    expect(plainMarket.status).toBe(200);
    const savedFlour = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${bakerySession.id}/lines`)
      .set(authHeader(adminToken))
      .send({ department: "bakery", product_id: flour.id, counted_qty: 4 });
    expect(savedFlour.status).toBe(200);
    expect(await stockOf(market.id)).toBe(20);
    expect(await stockOf(flour.id)).toBe(10);

    const reloadedMarket = unwrap((await request(ctx.app)
      .get(`/api/v1/inventory/counts/${retailSession.id}?department=retail`)
      .set(authHeader(adminToken))).body);
    const reloadedFlour = unwrap((await request(ctx.app)
      .get(`/api/v1/inventory/counts/${bakerySession.id}?department=bakery`)
      .set(authHeader(adminToken))).body);
    expect(Number(reloadedMarket.lines.find((line) => line.product_id === market.id).counted_qty)).toBe(9);
    expect(Number(reloadedFlour.lines.find((line) => line.product_id === flour.id).counted_qty)).toBe(4);

    const wrongScreen = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${bakerySession.id}/lines`)
      .set(authHeader(adminToken))
      .send({ department: "retail", product_id: flour.id, counted_qty: 1 });
    expect(wrongScreen.status).toBe(409);
    expect(unwrap(wrongScreen.body).code).toBe("COUNT_DEPARTMENT_MISMATCH");
    const injected = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${retailSession.id}/lines`)
      .set(authHeader(adminToken))
      .send({ department: "retail", product_id: flour.id, counted_qty: 1 });
    expect(injected.status).toBe(400);
    expect(unwrap(injected.body).code).toBe("COUNT_SCOPE");
    expect(await stockOf(market.id)).toBe(20);
    expect(await stockOf(flour.id)).toBe(10);
    const retailLines = await ctx.db.all(
      "SELECT product_id, counted_qty FROM stock_count_lines WHERE session_id = ?",
      [retailSession.id]
    );
    expect(retailLines.map((line) => line.product_id)).toEqual([market.id]);

    const marketLists = unwrap((await request(ctx.app)
      .get("/api/v1/inventory/counts?department=retail")
      .set(authHeader(adminToken))).body);
    const bakeryLists = unwrap((await request(ctx.app)
      .get("/api/v1/inventory/counts?department=bakery")
      .set(authHeader(adminToken))).body);
    expect(marketLists.some((row) => row.id === retailSession.id && row.status === "open")).toBe(true);
    expect(marketLists.some((row) => row.id === bakerySession.id)).toBe(false);
    expect(bakeryLists.some((row) => row.id === bakerySession.id && row.status === "open")).toBe(true);
    expect(bakeryLists.some((row) => row.id === retailSession.id)).toBe(false);

    const postedMarket = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${retailSession.id}/post`)
      .set(authHeader(adminToken))
      .send({ department: "retail" });
    expect(postedMarket.status).toBe(200);
    expect(unwrap(postedMarket.body).status).toBe("posted");
    expect(await stockOf(market.id)).toBe(9);
    expect(await stockOf(flour.id)).toBe(10);
    const flourStill = await ctx.db.get(
      "SELECT status FROM stock_count_sessions WHERE id = ?",
      [bakerySession.id]
    );
    expect(flourStill.status).toBe("open");
    expect(Number((await ctx.db.get(
      "SELECT counted_qty FROM stock_count_lines WHERE session_id = ? AND product_id = ?",
      [bakerySession.id, flour.id]
    )).counted_qty)).toBe(4);

    const postedFlour = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${bakerySession.id}/post`)
      .set(authHeader(adminToken))
      .send({ department: "bakery" });
    expect(postedFlour.status).toBe(200);
    expect(await stockOf(flour.id)).toBe(4);
    expect(await stockOf(market.id)).toBe(9);

    const marketLedger = await ctx.db.get(
      `SELECT reference_id, reference_type FROM inventory_ledger
        WHERE product_id = ? AND reference_type = 'stock_count_session'
        ORDER BY id DESC LIMIT 1`,
      [market.id]
    );
    expect(marketLedger.reference_id).toBe(retailSession.id);
    const flourLedger = await ctx.db.get(
      `SELECT reference_id FROM inventory_ledger
        WHERE product_id = ? AND reference_type = 'stock_count_session'
        ORDER BY id DESC LIMIT 1`,
      [flour.id]
    );
    expect(flourLedger.reference_id).toBe(bakerySession.id);
    expect(beforeLedger).toEqual([]);

    const again = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${retailSession.id}/post`)
      .set(authHeader(adminToken))
      .send({ department: "retail" });
    expect(again.status).toBe(400);
    expect(await stockOf(market.id)).toBe(9);
  });

  test("an incomplete bakery count does not block supermarket posting, and a failed post can be retried", async () => {
    const market = await makeProduct("سوق كامل", "retail", 20);
    const flour = await makeProduct("دقيق ناقص", "bakery", 10);
    await ctx.db.run(
      "INSERT INTO product_batches (product_id, expiry_date, quantity) VALUES (?, '2034-01-01', 6)",
      [flour.id]
    );
    const retailSession = await openDepartment("retail");
    const bakerySession = await openDepartment("bakery");
    expect((await request(ctx.app)
      .post(`/api/v1/inventory/counts/${retailSession.id}/lines`)
      .set(authHeader(adminToken))
      .send({ department: "retail", product_id: market.id, counted_qty: 9 })).status).toBe(200);
    expect((await request(ctx.app)
      .post(`/api/v1/inventory/counts/${bakerySession.id}/lines`)
      .set(authHeader(adminToken))
      .send({
        department: "bakery",
        product_id: flour.id,
        sources: [{ batch_source: "dated", expiry_date: "2034-01-01", counted_qty: 6 }],
      })).status).toBe(200);

    const [bakeryPost, marketPost] = await Promise.all([
      request(ctx.app)
        .post(`/api/v1/inventory/counts/${bakerySession.id}/post`)
        .set(authHeader(adminToken))
        .send({ department: "bakery" }),
      request(ctx.app)
        .post(`/api/v1/inventory/counts/${retailSession.id}/post`)
        .set(authHeader(adminToken))
        .send({ department: "retail" }),
    ]);
    expect(bakeryPost.status).toBe(400);
    expect(unwrap(bakeryPost.body).code).toBe("INCOMPLETE_COUNT");
    expect(marketPost.status).toBe(200);
    expect(await stockOf(market.id)).toBe(9);
    expect(await stockOf(flour.id)).toBe(10);
    expect((await ctx.db.get("SELECT status FROM stock_count_sessions WHERE id = ?", [bakerySession.id])).status).toBe("open");

    const finished = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${bakerySession.id}/lines`)
      .set(authHeader(adminToken))
      .send({
        department: "bakery",
        product_id: flour.id,
        sources: [
          { batch_source: "dated", expiry_date: "2034-01-01", counted_qty: 6 },
          { batch_source: "undated", expiry_date: null, counted_qty: 0 },
        ],
      });
    expect(finished.status).toBe(200);
    const retry = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${bakerySession.id}/post`)
      .set(authHeader(adminToken))
      .send({ department: "bakery" });
    expect(retry.status).toBe(200);
    expect(await stockOf(flour.id)).toBe(6);
    expect(await stockOf(market.id)).toBe(9);
    const zeroLine = await ctx.db.get(
      `SELECT counted_qty, expiry_date FROM stock_count_lines
        WHERE session_id = ? AND batch_source = 'undated'`,
      [bakerySession.id]
    );
    expect(Number(zeroLine.counted_qty)).toBe(0);
    expect(zeroLine.expiry_date).toBeNull();
    const datedLine = await ctx.db.get(
      `SELECT expiry_date FROM stock_count_lines
        WHERE session_id = ? AND batch_source = 'dated'`,
      [bakerySession.id]
    );
    expect(datedLine.expiry_date).toBe("2034-01-01");
  });

  test("delete and cancel affect only the chosen document, and bakery permission cannot touch supermarket counts", async () => {
    const market = await makeProduct("سوق يحذف", "retail", 3);
    const flour = await makeProduct("دقيق يلغي", "bakery", 2);
    const retailSession = await openDepartment("retail");
    const bakerySession = await openDepartment("bakery");
    await request(ctx.app)
      .post(`/api/v1/inventory/counts/${retailSession.id}/lines`)
      .set(authHeader(adminToken))
      .send({ department: "retail", product_id: market.id, counted_qty: 1 });
    await request(ctx.app)
      .post(`/api/v1/inventory/counts/${bakerySession.id}/lines`)
      .set(authHeader(adminToken))
      .send({ department: "bakery", product_id: flour.id, counted_qty: 0 });

    const deniedCreate = await request(ctx.app)
      .post("/api/v1/inventory/counts")
      .set(authHeader(bakeryToken))
      .send({ department: "retail" });
    expect(deniedCreate.status).toBe(403);
    const deniedPost = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${retailSession.id}/post`)
      .set(authHeader(bakeryToken))
      .send({ department: "retail" });
    expect(deniedPost.status).toBe(403);
    expect(await stockOf(market.id)).toBe(3);

    const allowedBakery = await request(ctx.app)
      .get("/api/v1/inventory/counts?department=bakery")
      .set(authHeader(bakeryToken));
    expect(allowedBakery.status).toBe(200);

    const cancelled = await request(ctx.app)
      .post(`/api/v1/inventory/counts/${bakerySession.id}/cancel?department=bakery`)
      .set(authHeader(adminToken))
      .send({});
    expect(cancelled.status).toBe(200);
    expect(unwrap(cancelled.body).status).toBe("cancelled");
    expect((await ctx.db.get("SELECT status FROM stock_count_sessions WHERE id = ?", [retailSession.id])).status).toBe("open");
    expect(await stockOf(flour.id)).toBe(2);
    expect(Number((await ctx.db.get(
      "SELECT counted_qty FROM stock_count_lines WHERE session_id = ?",
      [bakerySession.id]
    )).counted_qty)).toBe(0);

    const removed = await request(ctx.app)
      .delete(`/api/v1/inventory/counts/${retailSession.id}?department=retail`)
      .set(authHeader(adminToken));
    expect(removed.status).toBe(200);
    expect(await ctx.db.get("SELECT id FROM stock_count_sessions WHERE id = ?", [retailSession.id])).toBeUndefined();
    expect(await ctx.db.get("SELECT id FROM stock_count_sessions WHERE id = ?", [bakerySession.id])).toBeTruthy();
    expect(await stockOf(market.id)).toBe(3);
  });

  test("a second open count for the same department is rejected", async () => {
    const first = await openDepartment("retail");
    const [again, other] = await Promise.all([
      request(ctx.app).post("/api/v1/inventory/counts").set(authHeader(adminToken)).send({ department: "retail" }),
      request(ctx.app).post("/api/v1/inventory/counts").set(authHeader(adminToken)).send({ department: "bakery" }),
    ]);
    expect(again.status).toBe(400);
    expect(unwrap(again.body).code).toBe("OPEN_COUNT_EXISTS");
    expect(other.status).toBe(201);
    await ctx.db.run("DELETE FROM stock_count_sessions WHERE id IN (?, ?)", [first.id, unwrap(other.body).id]);
  });
});
