import {
  calendarDaysBetween,
  normalizeExpiryDate,
  parsePreferredExpiry,
  PREFERRED_AUTO,
  PREFERRED_UNKNOWN,
} from "../utils/expiryDate.js";
import { planOutboundAllocations } from "../services/stockBatchService.js";

describe("expiryDate", () => {
  test("stores calendar dates without time-zone parsing", () => {
    expect(normalizeExpiryDate("2026-03-01")).toBe("2026-03-01");
    expect(normalizeExpiryDate("2026-03-01T23:00:00.000Z")).toBe("2026-03-01");
    expect(normalizeExpiryDate("")).toBeNull();
    expect(normalizeExpiryDate(null)).toBeNull();
  });

  test("calendar day difference does not use local Date parse", () => {
    expect(calendarDaysBetween("2026-01-01", "2026-01-08")).toBe(7);
    expect(calendarDaysBetween("2026-01-10", "2026-01-01")).toBe(-9);
  });

  test("preferred expiry parsing", () => {
    expect(parsePreferredExpiry(null)).toBe(PREFERRED_AUTO);
    expect(parsePreferredExpiry("auto")).toBe(PREFERRED_AUTO);
    expect(parsePreferredExpiry(PREFERRED_UNKNOWN)).toBe(PREFERRED_UNKNOWN);
    expect(parsePreferredExpiry("2026-06-15")).toBe("2026-06-15");
  });
});

describe("planOutboundAllocations FEFO", () => {
  test("takes earliest dated lot first then unknown", () => {
    const plan = planOutboundAllocations({
      stock: 100,
      datedBatches: [
        { expiry_date: "2026-06-01", quantity: 10 },
        { expiry_date: "2026-08-01", quantity: 20 },
      ],
      quantity: 25,
    });
    expect(plan).toEqual([
      { expiry_date: "2026-06-01", quantity: 10 },
      { expiry_date: "2026-08-01", quantity: 15 },
    ]);
  });

  test("unknown remainder has no invented date", () => {
    const plan = planOutboundAllocations({
      stock: 50,
      datedBatches: [{ expiry_date: "2026-06-01", quantity: 10 }],
      quantity: 40,
    });
    expect(plan).toEqual([
      { expiry_date: "2026-06-01", quantity: 10 },
      { expiry_date: null, quantity: 30 },
    ]);
  });

  test("overflow beyond stock stays unknown (negative stock)", () => {
    const plan = planOutboundAllocations({
      stock: 5,
      datedBatches: [{ expiry_date: "2026-06-01", quantity: 5 }],
      quantity: 12,
    });
    expect(plan).toEqual([
      { expiry_date: "2026-06-01", quantity: 5 },
      { expiry_date: null, quantity: 7, overflow: true },
    ]);
  });

  test("preferred dated lot is taken first", () => {
    const plan = planOutboundAllocations({
      stock: 30,
      datedBatches: [
        { expiry_date: "2026-06-01", quantity: 10 },
        { expiry_date: "2026-12-01", quantity: 10 },
      ],
      quantity: 12,
      preferred: "2026-12-01",
    });
    expect(plan).toEqual([
      { expiry_date: "2026-12-01", quantity: 10 },
      { expiry_date: "2026-06-01", quantity: 2 },
    ]);
  });
});
