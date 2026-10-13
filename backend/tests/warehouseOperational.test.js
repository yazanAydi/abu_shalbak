import request from "supertest";
import { initDatabase } from "../database/init.js";
import { closeSqliteConnection } from "../database/sqliteDriver.js";
import { createTestContext, destroyTestContext, login, authHeader } from "./helpers.js";

function unwrap(body) {
  return body?.data ?? body;
}

describe("operational warehouses", () => {
  test("a fresh database has the main warehouse and returns, and a second init adds none", async () => {
    const ctx = await createTestContext();
    try {
      const admin = (await login(ctx.app, "testadmin", "adminpass123")).body.token;
      const first = unwrap((await request(ctx.app).get("/api/v1/warehouses").set(authHeader(admin))).body);
      expect(first.map((row) => row.name)).toEqual(["المخزن الرئيسي", "مرتجعات"]);
      expect(first.map((row) => row.type)).toEqual(["main", "returns"]);
      const ids = first.map((row) => row.id);

      await closeSqliteConnection(ctx.db);
      ctx.db = await initDatabase(ctx.dbPath);
      const rows = await ctx.db.all(
        "SELECT id, name, type, active FROM warehouses ORDER BY id"
      );
      expect(rows.map((row) => row.id)).toEqual(ids);
      expect(rows.filter((row) => Number(row.active) === 1).map((row) => row.type)).toEqual(["main", "returns"]);
    } finally {
      await destroyTestContext(ctx);
    }
  });

  test("an older store quantity and its transfer stay in place while selectors offer two warehouses", async () => {
    const ctx = await createTestContext();
    try {
      const before = await ctx.db.all("SELECT id, type FROM warehouses ORDER BY id");
      const main = before.find((row) => row.type === "main");
      const returnsWh = before.find((row) => row.type === "returns");
      const store = await ctx.db.run(
        "INSERT INTO warehouses (name, code, type, active) VALUES ('مستودع المتجر', 'STORE', 'store', 1)"
      );
      const damaged = await ctx.db.run(
        "INSERT INTO warehouses (name, code, type, active) VALUES ('مستودع التالف', 'DMG', 'damaged', 1)"
      );
      const product = await ctx.db.get("SELECT id, stock, cost FROM products WHERE id = ?", [ctx.productId]);
      const companyBefore = Number(product.stock);
      await ctx.db.run(
        "INSERT INTO warehouse_stock (warehouse_id, product_id, quantity) VALUES (?, ?, 2)",
        [store.lastID, product.id]
      );
      await ctx.db.run(
        "INSERT INTO warehouse_stock (warehouse_id, product_id, quantity) VALUES (?, ?, -2)",
        [main.id, product.id]
      );
      const transfer = await ctx.db.run(
        `INSERT INTO warehouse_transfers
           (transfer_no, from_warehouse_id, to_warehouse_id, transfer_date, status)
         VALUES (1, ?, ?, '2026-10-01', 'posted')`,
        [main.id, store.lastID]
      );
      await ctx.db.run(
        "INSERT INTO warehouse_transfer_items (transfer_id, product_id, quantity) VALUES (?, ?, 2)",
        [transfer.lastID, product.id]
      );

      await closeSqliteConnection(ctx.db);
      ctx.db = await initDatabase(ctx.dbPath);

      const rows = await ctx.db.all("SELECT id, name, type, active FROM warehouses ORDER BY id");
      expect(rows.find((row) => row.id === main.id)).toMatchObject({
        name: "المخزن الرئيسي",
        type: "main",
        active: 1,
      });
      expect(rows.find((row) => row.id === returnsWh.id)).toMatchObject({
        name: "مرتجعات",
        type: "returns",
        active: 1,
      });
      expect(rows.find((row) => row.id === store.lastID)).toMatchObject({
        name: "مستودع المتجر",
        type: "store",
        active: 0,
      });
      expect(rows.find((row) => row.id === damaged.lastID).active).toBe(0);
      const kept = await ctx.db.get(
        "SELECT quantity FROM warehouse_stock WHERE warehouse_id = ? AND product_id = ?",
        [store.lastID, product.id]
      );
      expect(Number(kept.quantity)).toBe(2);
      const company = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id]);
      expect(Number(company.stock)).toBe(companyBefore);
      const doc = await ctx.db.get(
        `SELECT wf.name AS from_name, wt.name AS to_name, i.quantity
           FROM warehouse_transfers t
           JOIN warehouses wf ON wf.id = t.from_warehouse_id
           JOIN warehouses wt ON wt.id = t.to_warehouse_id
           JOIN warehouse_transfer_items i ON i.transfer_id = t.id
          WHERE t.id = ?`,
        [transfer.lastID]
      );
      expect(doc.from_name).toBe("المخزن الرئيسي");
      expect(doc.to_name).toBe("مستودع المتجر");
      expect(Number(doc.quantity)).toBe(2);

      const { createApp } = await import("../app.js");
      const app = createApp(ctx.db, ctx.dbPath);
      const admin = (await login(app, "testadmin", "adminpass123")).body.token;
      const offered = unwrap((await request(app).get("/api/v1/warehouses").set(authHeader(admin))).body);
      expect(offered.map((row) => row.name)).toEqual(["المخزن الرئيسي", "مرتجعات"]);
      const bakery = unwrap((await request(app).get("/api/v1/warehouses").query({ membership: "bakery" }).set(authHeader(admin))).body);
      expect(bakery.map((row) => row.id)).toEqual(offered.map((row) => row.id));
      const created = await request(app).post("/api/v1/warehouses").set(authHeader(admin)).send({
        name: "مستودع جديد",
        type: "store",
      });
      expect(created.status).toBe(400);
      const blocked = await request(app).post("/api/v1/warehouses/transfers").set(authHeader(admin)).send({
        from_warehouse_id: main.id,
        to_warehouse_id: store.lastID,
        items: [{ product_id: product.id, quantity: 1 }],
      });
      expect(blocked.status).toBe(400);
      const allowed = await request(app).post("/api/v1/warehouses/transfers").set(authHeader(admin)).send({
        from_warehouse_id: main.id,
        to_warehouse_id: returnsWh.id,
        items: [{ product_id: product.id, quantity: 1 }],
      });
      expect(allowed.status).toBe(201);
    } finally {
      await destroyTestContext(ctx);
    }
  });
});
