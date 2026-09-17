import { supplierPurchasePriceHint } from "../utils/productSearch";

describe("supplier purchase price hint", () => {
  test("formats last-purchase source for the return form", () => {
    expect(
      supplierPurchasePriceHint({ invoice_date: "2026-09-01", invoice_no: 44 })
    ).toBe("آخر شراء: 2026-09-01 — #44");
  });
});
