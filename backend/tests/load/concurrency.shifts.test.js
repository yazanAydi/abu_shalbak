import request from "supertest";
import { authHeader } from "../helpers.js";
import { insertCashier } from "./factories.js";
import { login } from "../helpers.js";
import { setupLoadContext, teardownLoadContext } from "./harness.js";

describe("C15a concurrent shift start", () => {
  let h;

  beforeEach(async () => {
    h = await setupLoadContext();
  });

  afterEach(async () => {
    await teardownLoadContext(h);
  });

  test(
    "C15a: concurrent POST /shifts/start cannot create two open shifts",
    async () => {
      const user = await insertCashier(h.db, { username: "shiftrace01" });
      const token = (await login(h.app, user.username, user.password, "pos")).body.token;

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          request(h.app).post("/api/v1/shifts/start").set(authHeader(token)).send({})
        )
      );

      expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
      const created = results.filter((r) => r.status === 201);
      expect(created.length).toBe(1);

      const open = await h.db.all(
        "SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'",
        [user.id]
      );
      expect(open).toHaveLength(1);
    },
    20000
  );

  test("C15a diagnostic: records how many open shifts the TOCTOU actually produced", async () => {
    const user = await insertCashier(h.db, { username: "shiftrace02" });
    const token = (await login(h.app, user.username, user.password, "pos")).body.token;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(h.app).post("/api/v1/shifts/start").set(authHeader(token)).send({})
      )
    );
    const open = await h.db.all(
      "SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'",
      [user.id]
    );
    // eslint-disable-next-line no-console
    console.log(
      `[C15a] statuses=${results.map((r) => r.status).join(",")} open_shifts=${open.length} ${
        open.length > 1 ? "BUG_REPRODUCED" : "not_reproduced_this_run"
      }`
    );
    expect(results.every((r) => r.status < 500)).toBe(true);
    expect(open.length).toBeGreaterThanOrEqual(1);
  }, 20000);

  test("different cashiers can start open shifts concurrently", async () => {
    const a = await insertCashier(h.db, { username: "shiftcashA" });
    const b = await insertCashier(h.db, { username: "shiftcashB" });
    const tokenA = (await login(h.app, a.username, a.password, "pos")).body.token;
    const tokenB = (await login(h.app, b.username, b.password, "pos")).body.token;

    const results = await Promise.all([
      ...Array.from({ length: 4 }, () =>
        request(h.app).post("/api/v1/shifts/start").set(authHeader(tokenA)).send({})
      ),
      ...Array.from({ length: 4 }, () =>
        request(h.app).post("/api/v1/shifts/start").set(authHeader(tokenB)).send({})
      ),
    ]);

    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);

    const openA = await h.db.all(
      "SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'",
      [a.id]
    );
    const openB = await h.db.all(
      "SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'",
      [b.id]
    );
    expect(openA).toHaveLength(1);
    expect(openB).toHaveLength(1);
    expect(openA[0].id).not.toBe(openB[0].id);
  }, 20000);

  test("closing a shift (pending_count) allows the cashier to start a new one", async () => {
    const user = await insertCashier(h.db, { username: "shiftclose01" });
    const token = (await login(h.app, user.username, user.password, "pos")).body.token;

    const first = await request(h.app).post("/api/v1/shifts/start").set(authHeader(token)).send({});
    expect(first.status).toBe(201);
    const firstId = first.body.data?.shift_id ?? first.body.shift_id;

    const ended = await request(h.app)
      .post(`/api/v1/shifts/${firstId}/end`)
      .set(authHeader(token))
      .send({});
    expect(ended.status).toBe(200);
    expect(ended.body.data?.status ?? ended.body.status).toBe("pending_count");

    const second = await request(h.app).post("/api/v1/shifts/start").set(authHeader(token)).send({});
    expect(second.status).toBe(201);
    const secondId = second.body.data?.shift_id ?? second.body.shift_id;
    expect(secondId).not.toBe(firstId);

    const open = await h.db.all(
      "SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'",
      [user.id]
    );
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(secondId);

    const prior = await h.db.get("SELECT status FROM cashier_shifts WHERE id = ?", [firstId]);
    expect(prior.status).toBe("pending_count");
  }, 20000);

  test("partial unique index rejects a second open row for the same cashier", async () => {
    const user = await insertCashier(h.db, { username: "shiftidx01" });
    const token = (await login(h.app, user.username, user.password, "pos")).body.token;
    const first = await request(h.app).post("/api/v1/shifts/start").set(authHeader(token)).send({});
    expect(first.status).toBe(201);

    const idx = await h.db.get(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_cashier_shifts_one_open'`
    );
    expect(idx).toBeTruthy();

    await expect(
      h.db.run(
        `INSERT INTO cashier_shifts (cashier_id, opening_cash, status) VALUES (?, 0, 'open')`,
        [user.id]
      )
    ).rejects.toMatchObject({ code: expect.stringMatching(/^SQLITE_CONSTRAINT/) });

    const other = await insertCashier(h.db, { username: "shiftidx02" });
    await h.db.run(
      `INSERT INTO cashier_shifts (cashier_id, opening_cash, status) VALUES (?, 0, 'open')`,
      [other.id]
    );
    await h.db.run(
      `INSERT INTO cashier_shifts (cashier_id, opening_cash, status) VALUES (?, 0, 'pending_count')`,
      [user.id]
    );

    const open = await h.db.all(
      "SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'",
      [user.id]
    );
    expect(open).toHaveLength(1);
  }, 20000);

  test("sequential second start returns 409 without creating another open shift", async () => {
    const user = await insertCashier(h.db, { username: "shiftseq01" });
    const token = (await login(h.app, user.username, user.password, "pos")).body.token;

    const first = await request(h.app).post("/api/v1/shifts/start").set(authHeader(token)).send({});
    expect(first.status).toBe(201);

    const second = await request(h.app).post("/api/v1/shifts/start").set(authHeader(token)).send({});
    expect(second.status).toBe(409);
    expect(second.body.error || second.body.data?.error).toBe("لديك وردية مفتوحة بالفعل");

    const open = await h.db.all(
      "SELECT id FROM cashier_shifts WHERE cashier_id = ? AND status = 'open'",
      [user.id]
    );
    expect(open).toHaveLength(1);
  }, 20000);
});
