import { buildPurchaseDocPrintHtml, PURCHASE_PRINT_COL_COUNT } from "./purchaseDocPrint";

function sampleItem(overrides = {}) {
  return {
    name: "حليب طويل الأمد",
    barcode: "1234567890123",
    unit_name: "كرتونة",
    quantity: 2,
    bonus_quantity: 1,
    base_quantity: 24,
    total_cost: 40,
    discount_pct: 10,
    unit_cost: 20,
    line_total: 36,
    ...overrides,
  };
}

function sampleInvoice(overrides = {}) {
  return {
    id: 6,
    invoice_no: 6,
    invoice_date: "2026-09-17",
    supplier_name: "مورد الاختبار",
    status: "posted",
    total: 36,
    vat: 4.97,
    items: [sampleItem()],
    ...overrides,
  };
}

function sampleReturn(overrides = {}) {
  return {
    id: 3,
    return_no: 3,
    return_date: "2026-09-17",
    supplier_name: "مورد الإرجاع",
    status: "posted",
    total: 36,
    items: [sampleItem({ name: "مرتجع دقيق أبيض" })],
    ...overrides,
  };
}

function parse(html) {
  return new DOMParser().parseFromString(html, "text/html");
}

function itemHeaders(doc) {
  return [...doc.querySelectorAll("table.items thead th")].map((th) => th.textContent.trim());
}

beforeEach(() => {
  localStorage.setItem("office.user", JSON.stringify({ username: "admin" }));
});

describe("purchase document print layout", () => {
  test("invoice and supplier return share the compact print columns and omit barcode", () => {
    const expected = [
      "#",
      "الصنف",
      "الوحدة",
      "الكمية",
      "بونص",
      "كمية الأساس",
      "إجمالي الكلفة",
      "خصم",
      "كلفة الوحدة",
      "الكلفة الفعلية",
      "الإجمالي",
    ];
    const invoice = parse(buildPurchaseDocPrintHtml(sampleInvoice(), "invoices", {}));
    const ret = parse(buildPurchaseDocPrintHtml(sampleReturn(), "returns", {}));
    expect(itemHeaders(invoice)).toEqual(expected);
    expect(itemHeaders(ret)).toEqual(expected);
    expect(itemHeaders(invoice)).toHaveLength(PURCHASE_PRINT_COL_COUNT);
    expect(invoice.body.innerHTML).not.toContain("الباركود");
    expect(ret.body.innerHTML).not.toContain("الباركود");
    expect(invoice.body.innerHTML).not.toContain("1234567890123");
    expect(ret.body.innerHTML).not.toContain("1234567890123");
  });

  test("reallocates width to the product name and keeps numeric values unclipped-ready", () => {
    const html = buildPurchaseDocPrintHtml(sampleInvoice(), "invoices", {});
    expect(html).toMatch(/col\.col-name\s*\{\s*width:\s*32%/);
    expect(html).toMatch(/th\.col-name,\s*td\.col-name\s*\{\s*width:\s*32%;\s*min-width:\s*42mm/);
    expect(html).toMatch(/td\.num\s*\{[^}]*white-space:\s*nowrap/);
    expect(html).toMatch(/font-size:\s*10\.5pt/);
  });

  test("preserves quantities, bonus, discount, VAT, and totals", () => {
    const html = buildPurchaseDocPrintHtml(sampleInvoice(), "invoices", { default_tax_rate: 0.16 });
    const doc = parse(html);
    const cells = [...doc.querySelectorAll("table.items tbody tr:first-child td")].map((td) => td.textContent.trim());
    expect(cells).toEqual([
      "1",
      "حليب طويل الأمد",
      "كرتونة",
      "2",
      "1",
      "24",
      "40.00",
      "10%",
      "20.00",
      "18.00",
      "36.00",
    ]);
    const totals = doc.querySelector(".totals").textContent;
    expect(totals).toContain("ضريبة 16%");
    expect(totals).toContain("4.97");
    expect(totals).toContain("الصافي");
    expect(totals).toContain("36.00");
    expect(html).toContain("بونص");
    expect(html).toContain("خصم");
  });

  test("keeps long Arabic names and large amounts in the print HTML", () => {
    const longName = "حليب طويل الأمد كامل الدسم مدعم بالفيتامينات علبة كبيرة جداً للعائلة";
    const html = buildPurchaseDocPrintHtml(
      sampleInvoice({
        total: 1234567.89,
        items: [
          sampleItem({
            name: longName,
            quantity: 10000,
            bonus_quantity: 250,
            base_quantity: 120000,
            total_cost: 1234567.89,
            unit_cost: 123.45,
            line_total: 1111111.1,
            discount_pct: 10,
          }),
        ],
      }),
      "invoices",
      {}
    );
    expect(html).toContain(longName);
    expect(html).toContain("10000");
    expect(html).toContain("1,234,567.89");
    expect(html).toContain("1,111,111.10");
  });

  test("compacts branding, metadata, and signature spacing without forcing one page", () => {
    const html = buildPurchaseDocPrintHtml(sampleInvoice(), "invoices", {});
    expect(html).toMatch(/@page\s*\{\s*size:\s*A4;/);
    expect(html).toMatch(/@page\s*\{\s*margin:\s*9mm;/);
    expect(html).toMatch(/\.print-branding__logo\s*\{[^}]*max-height:\s*58px/);
    expect(html).toMatch(/\.print-branding\s*\{[^}]*margin:\s*0 0 4px/);
    expect(html).toMatch(/\.printed-by\s*\{[^}]*margin:\s*8px 0 0/);
    expect(html).toMatch(/\.signatures\s*\{[^}]*margin-top:\s*28px/);
    expect(html).toMatch(/grid-template-columns:\s*1fr 1fr/);
    expect(html).toMatch(/p\s*\{\s*margin:\s*0/);
    expect(html).toContain('class="closing"');
    expect(html).toMatch(/\.totals-wrap\s*\{[^}]*margin-top:\s*4px/);
    expect(html).toMatch(/thead\s*\{\s*display:\s*table-header-group/);
    expect(html).toMatch(/table\s*\{[^}]*page-break-inside:\s*auto/);
    expect(html).toMatch(/tbody tr\s*\{\s*page-break-inside:\s*avoid/);
    expect(html).toMatch(/\.totals-wrap,\s*\.totals\s*\{\s*page-break-inside:\s*avoid/);
    expect(html).not.toMatch(/page-break-(?:before|after)\s*:\s*always/);
    expect(html).not.toMatch(/min-height\s*:\s*100(?:vh|%)/);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("المورد:");
    expect(html).toContain("التاريخ:");
    expect(html).toContain("الحالة:");
    expect(html).toContain("تاريخ الطباعة:");
    expect(html).toContain("طُبع بواسطة");
  });

  (process.env.DUMP_PURCHASE_PRINT === "1" ? test : test.skip)("dumps print HTML fixtures when DUMP_PURCHASE_PRINT=1", () => {
    const fs = require("fs");
    const path = require("path");
    const outDir = path.join(__dirname, "..", "..", "..", "tmp", "purchase-print");
    fs.mkdirSync(outDir, { recursive: true });
    const logoPath = path.join(__dirname, "..", "assets", "store-logo.png");
    const logoUrl = `data:image/png;base64,${fs.readFileSync(logoPath).toString("base64")}`;
    const store = {
      store_name_ar: "مخبز و سوبر ماركت الطيرة ابو شلبك",
      store_phone: "022980903",
      store_license: "مشتغل مرخص 562536680",
      logoUrl,
      print_show_address: false,
    };
    const shortHtml = buildPurchaseDocPrintHtml(
      sampleInvoice({
        items: [sampleItem({ name: "حليب طويل الأمد كامل الدسم علبة كبيرة" })],
      }),
      "invoices",
      store,
      { printedAt: "2026-09-17T05:30:00" }
    );
    const longName = "حليب طويل الأمد كامل الدسم مدعم بالفيتامينات علبة كبيرة جداً للعائلة";
    const largeHtml = buildPurchaseDocPrintHtml(
      sampleInvoice({
        items: [
          sampleItem({
            name: longName,
            quantity: 10000,
            bonus_quantity: 250,
            base_quantity: 120000,
            total_cost: 1234567.89,
            unit_cost: 123.45,
            line_total: 1111111.1,
          }),
        ],
        total: 1111111.1,
        vat: 153256.7,
      }),
      "invoices",
      store,
      { printedAt: "2026-09-17T05:30:00" }
    );
    const longHtml = buildPurchaseDocPrintHtml(
      sampleInvoice({
        items: Array.from({ length: 40 }, (_, i) =>
          sampleItem({
            name: `${longName} ${i + 1}`,
            quantity: 1000 + i,
            bonus_quantity: 12,
            base_quantity: 12000 + i,
            total_cost: 50000 + i * 111.11,
            unit_cost: 50.25,
            line_total: 45000 + i * 100.5,
          })
        ),
        total: 180000,
        vat: 24827.59,
      }),
      "invoices",
      store,
      { printedAt: "2026-09-17T05:30:00" }
    );
    const returnHtml = buildPurchaseDocPrintHtml(
      sampleReturn({
        items: [sampleItem({ name: longName, barcode: "5555555555555" })],
      }),
      "returns",
      store,
      { printedAt: "2026-09-17T05:30:00" }
    );
    fs.writeFileSync(path.join(outDir, "short-invoice.html"), shortHtml);
    fs.writeFileSync(path.join(outDir, "large-amounts.html"), largeHtml);
    fs.writeFileSync(path.join(outDir, "long-invoice.html"), longHtml);
    fs.writeFileSync(path.join(outDir, "supplier-return.html"), returnHtml);
  });

  test("long invoices keep a row per item so the table can paginate", () => {
    const items = Array.from({ length: 40 }, (_, i) =>
      sampleItem({
        name: `صنف طويل الاسم للطباعة متعددة الصفحات ${i + 1}`,
        barcode: `999000${String(i).padStart(6, "0")}`,
        quantity: 1000 + i,
        total_cost: 5000 + i,
        line_total: 4500 + i,
      })
    );
    const doc = parse(buildPurchaseDocPrintHtml(sampleInvoice({ items, total: 180000 }), "invoices", {}));
    expect(doc.querySelectorAll("table.items tbody tr")).toHaveLength(40);
    expect(doc.body.innerHTML).not.toContain("الباركود");
    expect(doc.body.innerHTML).not.toContain("999000000000");
    expect(doc.querySelector("table.items tbody").textContent).toContain("صنف طويل الاسم للطباعة متعددة الصفحات 40");
  });
});
