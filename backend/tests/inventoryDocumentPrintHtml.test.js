import { buildInventoryDocumentPrintHtml } from "../utils/inventoryDocumentPrintHtml.js";
import { DATED_BATCH_LABEL, UNDATED_BATCH_LABEL } from "../utils/batchSourceLabel.js";

describe("inventory document print HTML", () => {
  test("uses compact A4 sizing and keeps the barcode column", () => {
    const html = buildInventoryDocumentPrintHtml(
      {
        document_type: "receipt",
        document_number: "IN-9",
        document_date: "2026-09-17",
        created_by_name: "admin",
        items: [
          {
            product_name: "طحين",
            sku: "1001",
            barcode: "6291000001",
            unit_name: "كغم",
            quantity: 25,
            conversion_used: 1,
            base_quantity: 25,
          },
        ],
      },
      { print_show_logo: false, print_show_address: false }
    );
    expect(html).toContain("الباركود");
    expect(html).toContain("6291000001");
    expect(html).toMatch(/@page\s*\{\s*size:\s*A4;\s*margin:\s*9mm;/);
    expect(html).toMatch(/max-height:\s*58px/);
    expect(html).toMatch(/font-size:\s*10\.5pt/);
    expect(html).toMatch(/thead\s*\{\s*display:\s*table-header-group/);
    expect(html).not.toMatch(/page-break-(?:before|after)\s*:\s*always/);
  });

  test("prints Arabic batch-source labels and keeps the stored source off the page", () => {
    const html = buildInventoryDocumentPrintHtml({
      document_type: "issue",
      document_number: "GOUT-2",
      reason: "damaged",
      reason_label: "تالف",
      items: [
        { product_name: "حليب", batch_source: "undated", quantity: 1, base_quantity: 1 },
        { product_name: "لبن", batch_source: "dated", expiry_date: "2026-12-01", quantity: 2, base_quantity: 2 },
      ],
    });
    expect(html).toContain(UNDATED_BATCH_LABEL);
    expect(html).toContain(`${DATED_BATCH_LABEL} — 2026-12-01`);
    expect(html).not.toContain(">undated<");
    expect(html).not.toContain(">dated<");
  });
});
