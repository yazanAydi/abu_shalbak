import {
  csvBufferToRecords,
  normalizeProductRow,
  MAX_IMPORT_ROWS,
} from "../utils/productImport.js";

/**
 * Stage 6 — import hardening.
 */
describe("Product import hardening", () => {
  test("strips prototype-pollution keys from CSV records", () => {
    const csv = "barcode,name,price,__proto__\n123,Item,5,polluted";
    const records = csvBufferToRecords(Buffer.from(csv, "utf8"));
    expect(records.length).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(records[0], "__proto__")).toBe(false);
    // Global Object prototype must remain clean.
    expect({}.polluted).toBeUndefined();
  });

  test("rejects files exceeding the row cap", () => {
    const header = "barcode,name,price\n";
    const body = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `${i},Item${i},5`).join(
      "\n"
    );
    expect(() => csvBufferToRecords(Buffer.from(header + body, "utf8"))).toThrow();
  });

  test("a normal row still imports correctly after hardening", () => {
    const records = csvBufferToRecords(
      Buffer.from("barcode,name,price\n9990001,Milk,4.5", "utf8")
    );
    const norm = normalizeProductRow(records[0]);
    expect(norm.ok).toBe(true);
    expect(norm.row.barcode).toBe("9990001");
    expect(norm.row.price).toBe(4.5);
  });
});
