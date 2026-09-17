import { printReport } from "../utils/printReport";
import {
  bakeryExportColumns,
  bakeryPrintMeta,
  bakerySummaryItems,
  categoryOptionLabel,
  emptySelectedCatalogCopy,
  formatQtyByUnit,
} from "../pages/bakeryReportView";

jest.mock("../utils/printDocument", () => ({
  printDocumentWhenReady: (_doc, opts) => opts?.onAfterPrint?.(),
}));

function fixtureReport() {
  return {
    stock_note: "المخزون الحالي — لا يتأثر بالفترة المختارة",
    classification_note:
      "التصنيف حسب التصنيف الحالي للمنتج (لا يُحفظ التصنيف عند البيع). تغيير تصنيف المنتج يغيّر نتائج تقرير المخبز للفترات السابقة.",
    invoice_count_note: "عدد الفواتير على مستوى الصنف لا يُجمع إلى إجمالي فواتير المخبز",
    kpis: {
      net_revenue: 48.5,
      finished_net_revenue: 32,
      material_net_revenue: 16.5,
      sold_quantity_by_unit: [
        { unit: "حبة", quantity: 9 },
        { unit: "كغم", quantity: 3.25 },
      ],
      refunded_quantity_by_unit: [{ unit: "حبة", quantity: 1 }],
      net_quantity_by_unit: [
        { unit: "حبة", quantity: 8 },
        { unit: "كغم", quantity: 3.25 },
      ],
      invoice_count: 4,
    },
    products: [
      {
        product_id: 1,
        name: "خبز عربي",
        barcode: "8802000001",
        unit: "حبة",
        stock: 11,
        sold_quantity: 9,
        refunded_quantity: 1,
        net_quantity: 8,
        net_revenue: 32,
        invoice_count: 3,
        revenue_kind: "finished",
      },
      {
        product_id: 2,
        name: "خبز كغم",
        barcode: "8802000004",
        unit: "كغم",
        stock: 4.75,
        sold_quantity: 3.25,
        refunded_quantity: 0,
        net_quantity: 3.25,
        net_revenue: 16.5,
        invoice_count: 1,
        revenue_kind: "material",
      },
      {
        product_id: 3,
        name: "كعك يابس",
        barcode: "8802000003",
        unit: "حبة",
        stock: -4,
        sold_quantity: 0,
        refunded_quantity: 0,
        net_quantity: 0,
        net_revenue: 0,
        invoice_count: 0,
      },
    ],
  };
}

describe("bakery report view helpers", () => {
  test("quantity KPIs stay labeled by unit instead of mixing حبة and كغم", () => {
    expect(
      formatQtyByUnit([
        { unit: "حبة", quantity: 9 },
        { unit: "كغم", quantity: 3.25 },
      ])
    ).toBe("9 حبة · 3.25 كغم");
    expect(categoryOptionLabel({ name: "مواد مخبز", product_count: 0, active: 1 })).toBe(
      "مواد مخبز — 0 صنف"
    );
  });

  test("empty selected categories explain the zero match and uncategorized products", () => {
    const copy = emptySelectedCatalogCopy({
      selected_categories: [{ name: "مواد مخبز", product_count: 0 }],
      uncategorized_product_count: 16,
    });
    expect(copy.title).toMatch(/لا توجد منتجات/);
    expect(copy.hint).toMatch(/مواد مخبز \(0 صنف\)/);
    expect(copy.hint).toMatch(/16/);
    expect(copy.hint).toMatch(/تنظيم المنتجات/);
  });

  test("print HTML includes the populated table, unit-separated totals, and classification note", () => {
    const written = [];
    const originalOpen = window.open;
    window.open = () => ({
      document: {
        write(html) {
          written.push(String(html));
        },
        close() {},
      },
      close() {},
      focus() {},
      print() {},
    });

    const report = fixtureReport();
    printReport({
      title: "المخبز",
      subtitle: "التصنيفات: مخبز",
      columns: bakeryExportColumns(),
      rows: report.products,
      summary: bakerySummaryItems(report.kpis),
      meta: bakeryPrintMeta({ from: "2026-09-17", to: "2026-09-17", report }),
    });

    window.open = originalOpen;
    expect(written).toHaveLength(1);
    const html = written[0];
    expect(html).toContain("المخبز");
    expect(html).toContain("خبز عربي");
    expect(html).toContain("خبز كغم");
    expect(html).toContain("كعك يابس");
    expect(html).toContain("8802000001");
    expect(html).toContain("9 حبة");
    expect(html).toContain("3.25 كغم");
    expect(html).toContain("-4 حبة");
    expect(html).toContain("إيرادات المخبز");
    expect(html).toContain("إيراد أصناف البيع");
    expect(html).toContain("إيراد بيع المواد");
    expect(html).toContain("صنف بيع");
    expect(html).toContain("مادة");
    expect(html).toContain("تغيير تصنيف المنتج");
    expect(html).toContain("المخزون الحالي");
  });

  test("material slice summary uses the material revenue label only", () => {
    const items = bakerySummaryItems(
      { net_revenue: 16.5, material_net_revenue: 16.5, invoice_count: 1 },
      { slice: "material" }
    );
    expect(items.some((item) => item.label === "إيراد بيع المواد")).toBe(true);
    expect(items.some((item) => item.label === "إيرادات المخبز")).toBe(false);
    expect(items.some((item) => item.label === "إيراد أصناف البيع")).toBe(false);
  });
});
