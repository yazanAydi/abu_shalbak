import { completeInvoiceLines, findDuplicateProductLine, validateInvoiceLine } from "./invoiceLineEntry";

describe("invoiceLineEntry", () => {
  test("requires a product then a positive quantity", () => {
    expect(validateInvoiceLine({}).field).toBe("product");
    expect(validateInvoiceLine({ product_id: 1, quantity: 0 }).field).toBe("qty");
    expect(validateInvoiceLine({ product_id: 1, quantity: 2 })).toBeNull();
  });

  test("completeInvoiceLines drops empty rows but keeps duplicate products", () => {
    const lines = completeInvoiceLines([
      { product_id: 4, quantity: 1, expiry_date: "2027-01-01" },
      { product_id: "", quantity: 1 },
      { product_id: 4, quantity: 2, expiry_date: "2028-06-01" },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.expiry_date)).toEqual(["2027-01-01", "2028-06-01"]);
  });

  test("duplicate detection uses product id and skips the line being edited", () => {
    const items = [
      { product_id: 4, name: "حليب" },
      { product_id: 9, name: "خبز" },
    ];
    expect(findDuplicateProductLine(items, 4, 0)).toBeNull();
    expect(findDuplicateProductLine(items, "4", 1)?.name).toBe("حليب");
    expect(findDuplicateProductLine(items, 9, 1)).toBeNull();
    expect(findDuplicateProductLine(items, "nope", 0)).toBeNull();
  });
});
