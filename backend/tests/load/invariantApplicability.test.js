import { setupLoadContext, teardownLoadContext, captureBaseline, checkInvariants } from "./harness.js";

describe("workload-aware receipt invariants", () => {
  let h;

  beforeEach(async () => {
    h = await setupLoadContext();
  });

  afterEach(async () => {
    await teardownLoadContext(h);
  });

  test("without expectSales, zero receipts stay unique (Jest default, not weakened)", async () => {
    const baseline = await captureBaseline(h.db);
    const results = await checkInvariants(h.db, baseline, {});
    const row = results.find((r) => r.name === "receipt_numbers_unique");
    expect(row.ok).toBe(true);
    expect(row.applicable).not.toBe(false);
  });

  test("expectSales true and zero receipts is FAIL, not a vacuous pass", async () => {
    const baseline = await captureBaseline(h.db);
    const results = await checkInvariants(h.db, baseline, { expectSales: true });
    const row = results.find((r) => r.name === "receipt_numbers_unique");
    expect(row.ok).toBe(false);
    expect(row.status).toBe("fail");
    expect(String(row.detail)).toMatch(/expected sales/);
  });

  test("expectSales false and zero receipts is N/A", async () => {
    const baseline = await captureBaseline(h.db);
    const results = await checkInvariants(h.db, baseline, { expectSales: false });
    const row = results.find((r) => r.name === "receipt_numbers_unique");
    expect(row.ok).toBe(true);
    expect(row.applicable).toBe(false);
    expect(row.status).toBe("na");
  });
});
