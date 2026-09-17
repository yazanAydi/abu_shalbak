import { purchaseDocDetailColumns } from "./PurchaseDocDetailItems";

describe("purchaseDocDetailColumns", () => {
  it("keeps every existing document item field", () => {
    expect(purchaseDocDetailColumns().map((column) => column.key)).toEqual([
      "name",
      "unit_name",
      "quantity",
      "expiry_date",
      "base_quantity",
      "total_cost",
      "discount_pct",
      "bonus_quantity",
      "unit_cost",
      "effective_unit_cost",
      "line_total",
    ]);
  });

  it("renders existing values without dropping discount or bonus", () => {
    const item = {
      name: "حليب طويل الأمد كامل الدسم علبة كبيرة جداً",
      unit_name: "كرتونة",
      quantity: 24,
      expiry_date: "2026-12-31",
      base_quantity: 24,
      total_cost: 1234567.89,
      discount_pct: 10,
      bonus_quantity: 2,
      unit_cost: 50,
      line_total: 1111111.1,
    };
    const byKey = Object.fromEntries(
      purchaseDocDetailColumns().map((column) => [column.key, column.render ? column.render(item) : item[column.key]])
    );
    expect(byKey.name).toBe(item.name);
    expect(byKey.unit_name).toBe("كرتونة");
    expect(byKey.discount_pct).toBe("10%");
    expect(byKey.bonus_quantity).toBe("2");
    expect(String(byKey.total_cost)).toContain("1,234,567.89");
    expect(byKey.effective_unit_cost).not.toBe("—");
  });
});
