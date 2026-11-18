/** Large count requests use a disposable database, never the store database. */
import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  createAccountantUser,
  login,
  authHeader,
} from "./helpers.js";
import { withTransaction } from "../utils/dbTx.js";
import { ensureMaterialized } from "../services/warehouseBatchStock.js";

const unwrap = (body) => body?.data ?? body;

describe("bounded stock count batch APIs", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let seq = 0;

  beforeAll(async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TELEGRAM_")) delete process.env[key];
    }
    ctx = await createTestContext();
    expect(ctx.dbPath).toMatch(/abo-shalbak-test-/);
    adminToken = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
  });

  afterAll(async () => destroyTestContext(ctx));

  async function product(scope = "retail", stock = 5) {
    seq += 1;
    const inserted = await ctx.db.run(
      `INSERT INTO products (barcode, name, price, cost, category, stock, unit, inventory_scope)
       VALUES (?, ?, 10, 2, 'Test', ?, 'حبة', ?)`,
      [`bulk-${seq}`, `صنف جرد ${seq}`, stock, scope]
    );
    return inserted.lastID;
  }

  async function openCount(department = "retail") {
    await ctx.db.run("DELETE FROM stock_count_sessions WHERE status = 'open'");
    const result = await request(ctx.app).post("/api/v1/inventory/counts")
      .set(authHeader(adminToken)).send({ department });
    expect(result.status).toBe(201);
    return unwrap(result.body).id;
  }

  function save(id, products, department = "retail", token = adminToken) {
    return request(ctx.app).post(`/api/v1/inventory/counts/${id}/lines/bulk`)
      .set(authHeader(token)).send({ department, products });
  }

  function post(id) {
    return request(ctx.app).post(`/api/v1/inventory/counts/${id}/post`)
      .set(authHeader(adminToken)).send({ department: "retail" });
  }

  function sources(ids, token = adminToken) {
    return request(ctx.app).post("/api/v1/inventory/stock-sources/batch")
      .set(authHeader(token)).send({ product_ids: ids });
  }

  const entry = (id, quantity = 6) => ({ product_id: id, sources: [{ counted_qty: quantity }] });
  const savedRows = (sessionId) => ctx.db.all(
    "SELECT * FROM stock_count_lines WHERE session_id = ? ORDER BY id", [sessionId]
  );

  test("152 products read in two batches, save once with joined rows, and post only once", async () => {
    const ids = [];
    await withTransaction(ctx.db, async () => {
      for (let i = 0; i < 152; i += 1) ids.push(await product());
    });
    const id = await openCount();
    const pictures = {};
    for (const chunk of [ids.slice(0, 100), ids.slice(100)]) {
      const response = await sources(chunk);
      expect(response.status).toBe(200);
      Object.assign(pictures, unwrap(response.body).pictures);
    }
    expect(Object.keys(pictures)).toHaveLength(152);
    const single = await request(ctx.app).get("/api/v1/inventory/stock-sources")
      .query({ product_id: ids[0] }).set(authHeader(adminToken));
    expect(pictures[ids[0]]).toEqual(unwrap(single.body));

    const response = await save(id, ids.map((pid) => entry(pid)));
    expect(response.status).toBe(200);
    const saved = unwrap(response.body);
    expect(saved.lines).toHaveLength(152);
    expect(saved.lines.every((line) => line.name && line.barcode && line.unit === "حبة"
      && line.inventory_scope === "retail" && line.counted_qty === 6)).toBe(true);
    const fetched = await request(ctx.app).get(`/api/v1/inventory/counts/${id}`)
      .set(authHeader(adminToken));
    expect(saved).toEqual(unwrap(fetched.body));
    expect((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ids[0]])).stock).toBe(5);
    expect((await post(id)).status).toBe(200);
    expect((await post(id)).status).toBe(400);
    const changed = await ctx.db.get(
      `SELECT COUNT(*) AS total FROM inventory_ledger
       WHERE reference_type = 'stock_count_session' AND reference_id = ?`, [id]
    );
    expect(changed.total).toBe(152);
    expect((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ids[0]])).stock).toBe(6);
    expect((await save(id, [entry(ids[0], 9)])).status).toBe(400);
  });

  test("a later invalid product, scope, or unit rolls back earlier replacements", async () => {
    const first = await product();
    const second = await product();
    const bakery = await product("bakery");
    const firstUnit = await ctx.db.run(
      "INSERT INTO product_units (product_id, unit_name, conversion_to_base, price, cost) VALUES (?, 'كرتونة', 6, 60, 12)", [first]
    );
    const id = await openCount();
    expect((await save(id, [entry(first, 8), entry(second, 9)])).status).toBe(200);
    const before = await savedRows(id);
    const invalidCases = [
      { next: entry(999999999), status: 404, code: "NOT_FOUND" },
      { next: entry(bakery), status: 400, code: "COUNT_SCOPE" },
      {
        next: { product_id: second, sources: [{ counted_qty: 12,
          count_unit_snapshot: { unit_id: firstUnit.lastID, conversion_to_base: 6 } }] },
        status: 400, code: "COUNT_UNIT_INVALID",
      },
    ];
    for (const invalid of invalidCases) {
      const response = await save(id, [entry(first, 20), invalid.next]);
      expect(response.status).toBe(invalid.status);
      expect(response.body.code).toBe(invalid.code);
      expect(await savedRows(id)).toEqual(before);
    }
    expect((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [first])).stock).toBe(5);
  });

  test("duplicate products, duplicate expiry sources, invalid IDs and oversized batches write nothing", async () => {
    const pid = await product();
    const id = await openCount();
    const duplicate = await save(id, [entry(pid), entry(pid)]);
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.code).toBe("DUPLICATE_PRODUCT");
    const repeatedSource = await save(id, [{ product_id: pid, sources: [
      { counted_qty: 2, batch_source: "dated", expiry_date: "2030-12-01" },
      { counted_qty: 3, batch_source: "dated", expiry_date: "2030-12-01" },
    ] }]);
    expect(repeatedSource.status).toBe(400);
    expect(repeatedSource.body.code).toBe("DUPLICATE_SOURCE");
    for (const invalidId of [0, -1, 1.5, true, [pid], "abc"]) {
      expect((await save(id, [entry(invalidId)])).status).toBe(400);
      expect((await sources([invalidId])).status).toBe(400);
    }
    expect((await save(id, Array.from({ length: 1001 }, (_, index) => entry(index + 1)))).status).toBe(400);
    expect((await save(id, [{ product_id: pid,
      sources: Array.from({ length: 5001 }, () => ({ counted_qty: 1 })) }])).status).toBe(400);
    expect((await sources(Array.from({ length: 101 }, (_, index) => index + 1))).status).toBe(400);
    expect((await sources([pid, 999999999])).status).toBe(404);
    expect(await savedRows(id)).toEqual([]);
  });

  test("empty sources remove only the requested product and preserve untouched rows", async () => {
    const first = await product();
    const second = await product();
    const third = await product();
    const id = await openCount();
    expect((await save(id, [entry(first), entry(second), entry(third)])).status).toBe(200);
    const untouched = (await savedRows(id)).find((row) => row.product_id === third);
    // A product moved to another catalog department can still be removed from
    // this old draft, matching the established single-product endpoint.
    await ctx.db.run("UPDATE products SET inventory_scope = 'bakery' WHERE id = ?", [first]);
    const response = await save(id, [{ product_id: first, sources: [] }, entry(second, 12)]);
    expect(response.status).toBe(200);
    expect(unwrap(response.body).lines.map((row) => row.product_id).sort((a, b) => a - b)).toEqual([second, third]);
    expect((await savedRows(id)).find((row) => row.product_id === third)).toEqual(untouched);
    expect((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [first])).stock).toBe(5);
  });

  test("both batch APIs enforce authentication and count department permissions", async () => {
    const pid = await product();
    const id = await openCount();
    expect((await request(ctx.app).post("/api/v1/inventory/stock-sources/batch")
      .send({ product_ids: [pid] })).status).toBe(401);
    expect((await request(ctx.app).post(`/api/v1/inventory/counts/${id}/lines/bulk`)
      .send({ department: "retail", products: [entry(pid)] })).status).toBe(401);
    expect((await sources([pid], cashierToken)).status).toBe(403);
    expect((await save(id, [entry(pid)], "retail", cashierToken)).status).toBe(403);
    const mismatch = await save(id, [entry(pid)], "bakery");
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe("COUNT_DEPARTMENT_MISMATCH");
    expect((await save(id, [entry(pid)], "invalid-department")).status).toBe(400);
    const accountant = await createAccountantUser(ctx.db, {
      username: "bulk-bakery-accountant", permissions: { stock_count: false, bakery_supplies: true },
    });
    const token = (await login(ctx.app, accountant.username, accountant.password)).body.token;
    expect((await save(id, [entry(pid)], "retail", token)).status).toBe(403);
    expect(await savedRows(id)).toEqual([]);
  });

  test("an overlapping open count rolls back the whole save batch", async () => {
    const first = await product();
    const shared = await product();
    const id = await openCount();
    const other = await request(ctx.app).post("/api/v1/inventory/counts")
      .set(authHeader(adminToken)).send({ department: "bakery" });
    expect(other.status).toBe(201);
    // Model a stale/migrated row whose product was reassigned to retail after
    // entering a bakery count. The overlap guard must still reject it.
    await ctx.db.run(
      "INSERT INTO stock_count_lines (session_id, product_id, system_qty, counted_qty, variance) VALUES (?, ?, 5, 6, 1)",
      [unwrap(other.body).id, shared]
    );
    const response = await save(id, [entry(first), entry(shared)]);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("COUNT_PRODUCT_OVERLAP");
    expect(await savedRows(id)).toEqual([]);
  });

  test("bulk save keeps unit snapshots and entered expiry replacement semantics", async () => {
    const pid = await product("retail", 10);
    const carton = await ctx.db.run(
      "INSERT INTO product_units (product_id, unit_name, conversion_to_base, price, cost) VALUES (?, 'كرتونة', 6, 60, 12)", [pid]
    );
    await ctx.db.run("INSERT INTO product_batches (product_id, expiry_date, quantity) VALUES (?, '2030-01-01', 10)", [pid]);
    await withTransaction(ctx.db, () => ensureMaterialized(ctx.db, pid));
    const id = await openCount();
    const response = await save(id, [{ product_id: pid, sources: [{
      counted_qty: 12, batch_source: "dated", expiry_date: "2030-12-01",
      expiry_verified: true, count_unit_snapshot: { unit_id: carton.lastID, conversion_to_base: 6 },
    }] }]);
    expect(response.status).toBe(200);
    const [line] = unwrap(response.body).lines;
    expect(JSON.parse(line.count_unit_snapshot)).toEqual({ unit_id: carton.lastID, unit_name: "كرتونة", conversion_to_base: 6 });
    expect(JSON.parse(line.stock_source_snapshot)).toEqual([["2030-01-01", 10]]);
    expect(line.expiry_verified).toBe(1);
    expect((await post(id)).status).toBe(200);
    expect((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [pid])).stock).toBe(12);
    const batches = await ctx.db.all("SELECT expiry_date, quantity FROM product_batches WHERE product_id = ? ORDER BY expiry_date", [pid]);
    expect(batches).toEqual([{ expiry_date: "2030-01-01", quantity: 0 }, { expiry_date: "2030-12-01", quantity: 12 }]);
  });

  test("a later stale dated product rolls back earlier stock application", async () => {
    const first = await product();
    const dated = await product("retail", 10);
    await ctx.db.run("INSERT INTO product_batches (product_id, expiry_date, quantity) VALUES (?, '2030-01-01', 10)", [dated]);
    await withTransaction(ctx.db, () => ensureMaterialized(ctx.db, dated));
    const id = await openCount();
    expect((await save(id, [entry(first, 9), { product_id: dated,
      sources: [{ counted_qty: 8, batch_source: "dated", expiry_date: "2030-01-01" }] }])).status).toBe(200);
    await ctx.db.run("UPDATE warehouse_batch_stock SET quantity = 9 WHERE product_id = ?", [dated]);
    await ctx.db.run("UPDATE products SET stock = 9 WHERE id = ?", [dated]);
    const before = await savedRows(id);
    const response = await post(id);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("STALE_COUNT");
    expect((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [first])).stock).toBe(5);
    expect(await savedRows(id)).toEqual(before);
    expect((await ctx.db.get("SELECT status FROM stock_count_sessions WHERE id = ?", [id])).status).toBe("open");
    expect((await ctx.db.get(
      "SELECT COUNT(*) AS total FROM inventory_ledger WHERE reference_type = 'stock_count_session' AND reference_id = ?", [id]
    )).total).toBe(0);
  });
});
