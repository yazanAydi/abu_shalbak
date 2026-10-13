import { buildInventoryDocumentPrintHtml } from "./inventoryDocumentPrint";
import {
  ADJUSTMENT_TYPE_LABELS,
  LEDGER_MOVEMENT_LABELS,
  REFERENCE_TYPE_LABELS,
  movementLabel,
  referenceDisplay,
  warehouseChoiceLabel,
  warehouseDisplayName,
  warehouseTypeLabel,
} from "./inventoryLabels";
import { DATED_BATCH_LABEL, UNDATED_BATCH_LABEL, batchSourceLabel } from "./stockBatchLabels";

const RAW_TOKEN = /^(main|returns|store|damaged|dated|undated|manual_adjustment|stock_count_correction|purchase_receive|supplier_return|warehouse_transfer_in|warehouse_transfer_out|expiry_writeoff|sale|refund)$/;

describe("inventory display labels", () => {
  test("labels every ledger movement and keeps the filter value internal", () => {
    expect(LEDGER_MOVEMENT_LABELS.manual_adjustment).toBe("تعديل مخزون");
    expect(LEDGER_MOVEMENT_LABELS.stock_count_correction).toBe("تسوية جرد");
    expect(LEDGER_MOVEMENT_LABELS.expiry_writeoff).toBe("تالف");
    expect(LEDGER_MOVEMENT_LABELS.supplier_return).toBe("مرتجع مورد");
    for (const [value, label] of Object.entries(LEDGER_MOVEMENT_LABELS)) {
      expect(label).not.toBe(value);
      expect(label).not.toMatch(RAW_TOKEN);
      expect(movementLabel(value)).toBe(label);
    }
    expect(movementLabel("purchase")).toBe("استلام شراء");
    expect(movementLabel("count")).toBe("تسوية جرد");
    expect(movementLabel("not_a_type")).toBe("—");
  });

  test("adjustment choices keep internal values", () => {
    expect(Object.keys(ADJUSTMENT_TYPE_LABELS)).toEqual(["in", "out", "damage", "consumption", "correction"]);
    expect(ADJUSTMENT_TYPE_LABELS.damage).toBe("تالف");
  });

  test("reference history does not show the stored type", () => {
    expect(referenceDisplay({
      reference_type: "warehouse_transfer",
      reference_id: 4,
    })).toBe("تحويل مستودع #4");
    expect(referenceDisplay({
      reference_type: "shop_consumption",
      reference_id: 2,
    })).toBe("استهلاك المحل #2");
    expect(referenceDisplay({
      reference_label: "سند إدخال بضاعة #9",
      reference_type: "inventory_receipt",
    })).toBe("سند إدخال بضاعة #9");
    for (const label of Object.values(REFERENCE_TYPE_LABELS)) {
      expect(label).not.toMatch(RAW_TOKEN);
    }
    expect(referenceDisplay({ reference_type: "unknown_ref", reference_id: 1 })).toBe("—");
  });

  test("batch sources use one Arabic label and keep dated and undated as values", () => {
    expect(batchSourceLabel("dated", "2026-10-15")).toBe(`${DATED_BATCH_LABEL} — 15/10/26`);
    expect(batchSourceLabel("undated", null, { quantityText: "3" })).toBe(`${UNDATED_BATCH_LABEL} — 3`);
    expect(batchSourceLabel("dated", "2026-10-15")).not.toContain("dated");
    expect(batchSourceLabel("undated")).not.toContain("undated");
  });

  test("warehouse types and historical names stay readable", () => {
    expect(warehouseTypeLabel("main")).toBe("المخزن الرئيسي");
    expect(warehouseTypeLabel("returns")).toBe("مرتجعات");
    expect(warehouseTypeLabel("store")).toBe("مستودع المتجر");
    expect(warehouseTypeLabel("damaged")).toBe("تالف");
    expect(warehouseDisplayName("مستودع المتجر", "store")).toBe("مستودع المتجر");
    expect(warehouseDisplayName("store", "store")).toBe("مستودع المتجر");
    expect(warehouseDisplayName("main")).toBe("المخزن الرئيسي");
    expect(warehouseDisplayName("المخزن الرئيسي", "main")).toBe("المخزن الرئيسي");
    expect(warehouseChoiceLabel({ type: "main", name: "main" })).toBe("المخزن الرئيسي");
    expect(warehouseChoiceLabel({ type: "returns", name: "returns" })).toBe("مرتجعات");
  });

  test("printed inventory documents label the batch source", () => {
    const html = buildInventoryDocumentPrintHtml({
      document_type: "issue",
      document_number: "GOUT-1",
      document_date: "2026-10-05",
      reason: "damaged",
      items: [
        { product_name: "حليب", batch_source: "undated", quantity: 2, base_quantity: 2 },
        { product_name: "لبن", batch_source: "dated", expiry_date: "2026-12-01", quantity: 1, base_quantity: 1 },
      ],
    });
    expect(html).toContain(UNDATED_BATCH_LABEL);
    expect(html).toContain(DATED_BATCH_LABEL);
    expect(html).toContain("تالف");
    expect(html).not.toContain(">undated<");
    expect(html).not.toContain(">dated<");
    expect(html).not.toContain(">damaged<");
  });
});
