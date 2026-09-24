import { formatRefundTelegramItemLines, onAccountTelegramItems } from "../utils/telegram.js";

describe("formatRefundTelegramItemLines", () => {
  test("formats one product with name, qty, and line amount", () => {
    const lines = formatRefundTelegramItemLines([
      { name: "خبز عربي", quantity: 2, price: 3 },
    ]);
    expect(lines[0]).toBe("الأصناف:");
    expect(lines).toContain("• خبز عربي × 2 — ₪6.00");
  });

  test("formats several products", () => {
    const lines = formatRefundTelegramItemLines([
      { name: "خبز عربي", quantity: 2, price: 3 },
      { name: "حليب", quantity: 1, price: 7.5 },
    ]);
    expect(lines).toEqual([
      "الأصناف:",
      "• خبز عربي × 2 — ₪6.00",
      "• حليب × 1 — ₪7.50",
    ]);
  });

  test("includes unit name when set and keeps decimal qty", () => {
    const lines = formatRefundTelegramItemLines([
      { name: "جبنة بيضاء", quantity: 0.25, price: 34, unit_name: "كغ" },
    ]);
    expect(lines).toContain("• جبنة بيضاء × 0.25 كغ — ₪8.50");
  });

  test("accepts product_name fallback", () => {
    const lines = formatRefundTelegramItemLines([
      { product_name: "زيتون", quantity: 1, price: 4 },
    ]);
    expect(lines).toContain("• زيتون × 1 — ₪4.00");
  });

  test("omits empty or missing items so the message stays valid", () => {
    expect(formatRefundTelegramItemLines(null)).toEqual([]);
    expect(formatRefundTelegramItemLines(undefined)).toEqual([]);
    expect(formatRefundTelegramItemLines([])).toEqual([]);
    expect(formatRefundTelegramItemLines([null, {}, { quantity: 1 }])).toEqual([]);
  });

  test("truncates long lists with a remainder count", () => {
    const items = [
      { name: "صنف أ", quantity: 1, price: 1 },
      { name: "صنف ب", quantity: 1, price: 1 },
      { name: "صنف ج", quantity: 1, price: 1 },
    ];
    const full = formatRefundTelegramItemLines(items);
    const tight = formatRefundTelegramItemLines(items, {
      maxChars: full.join("\n").length - 5,
    });
    expect(tight[0]).toBe("الأصناف:");
    expect(tight.some((line) => line.includes("أصناف أخرى"))).toBe(true);
    expect(tight.join("\n").length).toBeLessThan(full.join("\n").length);
  });
});

describe("onAccountTelegramItems", () => {
  test("reads cart lines and charged totals from the sale snapshot", () => {
    const items = onAccountTelegramItems({
      normalized: [
        { name: "بندورة", quantity: 1.2, unit_name: "كغم", price: 5 },
        { name: "خبز", quantity: 2, unit_name: "حبة", price: 1 },
      ],
      detailed: [{ lineGross: 6 }, { lineGross: 2 }],
    });
    const lines = formatRefundTelegramItemLines(items);
    expect(lines).toEqual([
      "الأصناف:",
      "• بندورة × 1.2 كغم — ₪6.00",
      "• خبز × 2 حبة — ₪2.00",
    ]);
  });

  test("parses a JSON snapshot and falls back to itemsForJson", () => {
    const items = onAccountTelegramItems(
      JSON.stringify({
        itemsForJson: [{ name: "حليب", quantity: 1, price: 7.5 }],
      })
    );
    expect(formatRefundTelegramItemLines(items)).toContain("• حليب × 1 — ₪7.50");
  });

  test("returns no lines when the snapshot is missing or invalid", () => {
    expect(onAccountTelegramItems(null)).toEqual([]);
    expect(onAccountTelegramItems("not-json")).toEqual([]);
    expect(onAccountTelegramItems({})).toEqual([]);
  });
});
