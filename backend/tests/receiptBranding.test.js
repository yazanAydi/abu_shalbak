import {
  buildReceiptHtml,
  buildReceiptText,
  estimateReceiptPageHeightMm,
  getReceiptPageWidthMm,
} from "../utils/receipt.js";
import {
  STORE_LICENSE_LINE,
  STORE_NAME_AR,
  STORE_PHONE,
} from "../utils/storeBranding.js";

const baseReceiptOpts = {
  transactionId: 42,
  timestamp: "2026-07-06 12:00:00",
  cashierName: "test",
  lines: [{ name: "خبز", quantity: 2, price: 5, lineTotal: 10 }],
  subtotal: 10,
  tax: 0,
  total: 10,
  paymentMethod: "cash",
  settings: {},
};

describe("receipt store branding", () => {
  test("customer sale receipt shows store name and phone in English digits", () => {
    const text = buildReceiptText(baseReceiptOpts);

    expect(text).toContain(STORE_NAME_AR);
    expect(text).toContain(STORE_PHONE);
    expect(text).toContain("فاتورة مبيعات ضريبية");
    expect(text).toContain("مشتغل مرخص");
    expect(text).toContain(STORE_LICENSE_LINE);
  });
});

describe("receipt thermal page", () => {
  test("HTML uses an 80mm width and does not force a tall page", () => {
    const html = buildReceiptHtml(baseReceiptOpts);

    expect(html).toMatch(/@page\s*\{\s*size:\s*80mm;/);
    expect(html).not.toMatch(/min-height:\s*100vh/);
    expect(html).not.toMatch(/height:\s*100vh/);
    expect(html).not.toMatch(/297mm/);
    expect(html).toContain("height: auto !important");
    expect(html).toContain("min-height: 0 !important");
    expect(html).toContain("padding: 0");
    expect(html).toContain("box-sizing: border-box");
    expect(html).toContain("margin-left: auto");
    expect(html).toContain("margin-right: auto");
    expect(html).toContain("width: 74mm");
    expect(html).toMatch(/html,\s*body\s*\{[^}]*direction:\s*ltr/);
    expect(html).toMatch(/\.receipt\s*\{[^}]*direction:\s*rtl/);
    expect(html).not.toMatch(/RECEIPT_HORIZONTAL_OFFSET|left: [1-9]/);
    expect(html).toContain("شكراً لزيارتكم");
    expect(html).toContain("فاتورة مبيعات ضريبية");
    expect(html).toContain("المبلغ للدفع");
    expect(html).toMatch(/<div class="thanks">شكراً لزيارتكم<\/div>\s*<\/div>\s*<\/body>/);
  });

  test("script tags in product and cashier names are HTML-entity encoded", () => {
    const html = buildReceiptHtml({
      ...baseReceiptOpts,
      cashierName: `<script>alert("x")</script>`,
      lines: [
        {
          name: `<script>alert("p")</script>`,
          quantity: 1,
          price: 3,
          lineTotal: 3,
        },
      ],
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("المستخدم:");
  });

  test("a long product name stays within the height heuristic bounds", () => {
    const longName = "منتج طويل جداً ".repeat(20).trim();
    const opts = {
      ...baseReceiptOpts,
      lines: [{ name: longName, quantity: 1, price: 2, lineTotal: 2 }],
    };
    const mm = estimateReceiptPageHeightMm(opts);
    const html = buildReceiptHtml(opts);
    expect(mm).toBeGreaterThanOrEqual(70);
    expect(mm).toBeLessThanOrEqual(400);
    expect(html).toContain(longName.slice(0, 20));
  });

  test("receipt item table includes رقم المنتج", () => {
    const opts = {
      ...baseReceiptOpts,
      lines: [{ name: "خبز", sku: "42", quantity: 2, price: 5, lineTotal: 10 }],
    };
    const html = buildReceiptHtml(opts);
    expect(html).toContain(">الرقم<");
    expect(html).toContain(">42<");
    expect(buildReceiptText(opts)).toMatch(/42\s+خبز/);
  });

  test("settings store name and phone override branding defaults", () => {
    const text = buildReceiptText({
      ...baseReceiptOpts,
      settings: { store_name_ar: "سوبر ماركت الاختبار", store_phone: "0590000000" },
    });
    expect(text).toContain("سوبر ماركت الاختبار");
    expect(text).toContain("0590000000");
  });

  test("RECEIPT_WIDTH_MM=58 produces a 58mm page", () => {
    const prev = process.env.RECEIPT_WIDTH_MM;
    process.env.RECEIPT_WIDTH_MM = "58";
    try {
      expect(getReceiptPageWidthMm()).toBe(58);
      const html = buildReceiptHtml(baseReceiptOpts);
      expect(html).toMatch(/@page\s*\{\s*size:\s*58mm;/);
      expect(html).toContain("width: 52mm");
    } finally {
      if (prev == null) delete process.env.RECEIPT_WIDTH_MM;
      else process.env.RECEIPT_WIDTH_MM = prev;
    }
    expect(getReceiptPageWidthMm()).toBe(80);
  });

  test("more items produce a taller page than a one-line sale", () => {
    const manyLines = Array.from({ length: 12 }, (_, i) => ({
      name: `صنف ${i + 1}`,
      quantity: 1,
      price: 2,
      lineTotal: 2,
    }));
    const shortMm = estimateReceiptPageHeightMm(baseReceiptOpts);
    const tallMm = estimateReceiptPageHeightMm({
      ...baseReceiptOpts,
      lines: manyLines,
      subtotal: 24,
      total: 24,
    });
    expect(tallMm).toBeGreaterThan(shortMm);
    expect(shortMm).toBeGreaterThanOrEqual(70);
    expect(tallMm).toBeLessThanOrEqual(400);
  });
});
