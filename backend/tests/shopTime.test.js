import {
  SHOP_TZ,
  addShopDays,
  shopTodayYmd,
  shopYmdFromDate,
  shopYmdFromTimestamp,
  shopYmdInRange,
  shopYmdRangeToUtcBounds,
  shopYmdToUtcBounds,
} from "../utils/shopTime.js";

describe("shopTime", () => {
  test("uses Asia/Hebron (Ramallah) as default zone", () => {
    expect(SHOP_TZ).toBe("Asia/Hebron");
  });

  test("shopYmdFromTimestamp treats SQLite UTC strings as UTC", () => {
    // 2026-07-10 19:00 UTC = 2026-07-10 22:00 Ramallah (UTC+3)
    expect(shopYmdFromTimestamp("2026-07-10 19:00:00")).toBe("2026-07-10");
    // 2026-07-10 21:00 UTC = 2026-07-11 00:00 Ramallah
    expect(shopYmdFromTimestamp("2026-07-10 21:00:00")).toBe("2026-07-11");
  });

  test("shopYmdToUtcBounds covers full Ramallah calendar day", () => {
    const { startIso, endIso } = shopYmdToUtcBounds("2026-07-10");
    expect(shopYmdFromTimestamp(startIso)).toBe("2026-07-10");
    expect(shopYmdFromTimestamp(endIso)).toBe("2026-07-10");
    expect(Date.parse(endIso)).toBeGreaterThan(Date.parse(startIso));
  });

  test("shopYmdRangeToUtcBounds spans inclusive range", () => {
    const { startIso, endIso } = shopYmdRangeToUtcBounds("2026-07-10", "2026-07-11");
    expect(shopYmdFromTimestamp(startIso)).toBe("2026-07-10");
    expect(shopYmdFromTimestamp(endIso)).toBe("2026-07-11");
  });

  test("addShopDays moves calendar days in shop timezone", () => {
    expect(addShopDays("2026-07-10", 1)).toBe("2026-07-11");
    expect(addShopDays("2026-07-10", -1)).toBe("2026-07-09");
  });

  test("shopYmdInRange checks shop calendar dates", () => {
    expect(shopYmdInRange("2026-07-10 12:00:00", "2026-07-10", "2026-07-10")).toBe(true);
    expect(shopYmdInRange("2026-07-10 21:00:00", "2026-07-10", "2026-07-10")).toBe(false);
    expect(shopYmdInRange("2026-07-10 21:00:00", "2026-07-11", "2026-07-11")).toBe(true);
  });

  test("shopTodayYmd matches shopYmdFromDate(now)", () => {
    expect(shopTodayYmd()).toBe(shopYmdFromDate(new Date()));
  });
});
