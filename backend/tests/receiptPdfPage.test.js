import {
  applyReceiptPageSize,
  assembleReceiptHeightMeasure,
  computeReceiptHeightFromBoxes,
  cssPxToMm,
  injectReceiptMeasureHook,
  parseReceiptHeightPxFromDom,
  parseReceiptMeasureFromDom,
  receiptMeasurePageSource,
  receiptPageHeightMmFromContentPx,
} from "../utils/receiptPdfPage.js";
import {
  buildReceiptHtml,
  getReceiptBottomMarginMm,
  getReceiptContentWidthMm,
  getReceiptHorizontalOffsetMm,
  getReceiptSideMarginMm,
} from "../utils/receipt.js";

describe("receipt PDF page sizing", () => {
  const prevMargin = process.env.RECEIPT_BOTTOM_MARGIN_MM;
  const prevSide = process.env.RECEIPT_SIDE_MARGIN_MM;
  const prevOffset = process.env.RECEIPT_HORIZONTAL_OFFSET_MM;
  const prevWidth = process.env.RECEIPT_WIDTH_MM;

  afterEach(() => {
    if (prevMargin == null) delete process.env.RECEIPT_BOTTOM_MARGIN_MM;
    else process.env.RECEIPT_BOTTOM_MARGIN_MM = prevMargin;
    if (prevSide == null) delete process.env.RECEIPT_SIDE_MARGIN_MM;
    else process.env.RECEIPT_SIDE_MARGIN_MM = prevSide;
    if (prevOffset == null) delete process.env.RECEIPT_HORIZONTAL_OFFSET_MM;
    else process.env.RECEIPT_HORIZONTAL_OFFSET_MM = prevOffset;
    if (prevWidth == null) delete process.env.RECEIPT_WIDTH_MM;
    else process.env.RECEIPT_WIDTH_MM = prevWidth;
  });

  test("bottom margin defaults to 5mm", () => {
    delete process.env.RECEIPT_BOTTOM_MARGIN_MM;
    expect(getReceiptBottomMarginMm()).toBe(5);
  });

  test("RECEIPT_BOTTOM_MARGIN_MM overrides the cutter gap", () => {
    process.env.RECEIPT_BOTTOM_MARGIN_MM = "5";
    expect(getReceiptBottomMarginMm()).toBe(5);
    process.env.RECEIPT_BOTTOM_MARGIN_MM = "8";
    expect(getReceiptBottomMarginMm()).toBe(8);
  });

  test("page height is content plus the cutter margin, not a fixed A4", () => {
    delete process.env.RECEIPT_BOTTOM_MARGIN_MM;
    const oneItem = receiptPageHeightMmFromContentPx(360);
    const fiveItem = receiptPageHeightMmFromContentPx(520);
    const twentyItem = receiptPageHeightMmFromContentPx(1400);
    expect(oneItem).toBeCloseTo(cssPxToMm(360) + 5, 2);
    expect(fiveItem).toBeGreaterThan(oneItem);
    expect(twentyItem).toBeGreaterThan(fiveItem);
    expect(oneItem).toBeLessThan(200);
    expect(twentyItem).toBeLessThan(400);
    expect(oneItem).not.toBe(297);
  });

  test("max of rect and scrollHeight ignores a single zero", () => {
    expect(
      computeReceiptHeightFromBoxes({
        rectHeight: 0,
        receiptScrollHeight: 412,
        bodyScrollHeight: 0,
      })
    ).toBe(412);
    expect(
      computeReceiptHeightFromBoxes({
        rectHeight: 200,
        receiptScrollHeight: 0,
        bodyScrollHeight: 180,
      })
    ).toBe(200);
    expect(
      computeReceiptHeightFromBoxes({
        rectHeight: 0,
        receiptScrollHeight: 0,
        bodyScrollHeight: 0,
      })
    ).toBeNull();
  });

  test("missing .receipt still uses body scroll height", () => {
    const diag = assembleReceiptHeightMeasure({
      receiptSelectorFound: false,
      rectHeight: 0,
      receiptScrollHeight: 0,
      bodyScrollHeight: 388,
    });
    expect(diag.receiptSelectorFound).toBe(false);
    expect(diag.calculatedHeightPx).toBe(388);
    expect(diag.calculatedHeightMm).toBeCloseTo(cssPxToMm(388) + 5, 2);
  });

  test("1-item measure is shorter than 5-item and 20-item", () => {
    const one = assembleReceiptHeightMeasure({
      receiptSelectorFound: true,
      rectHeight: 360,
      receiptScrollHeight: 360,
      bodyScrollHeight: 360,
    });
    const five = assembleReceiptHeightMeasure({
      receiptSelectorFound: true,
      rectHeight: 520,
      receiptScrollHeight: 520,
      bodyScrollHeight: 520,
    });
    const twenty = assembleReceiptHeightMeasure({
      receiptSelectorFound: true,
      rectHeight: 1400,
      receiptScrollHeight: 1400,
      bodyScrollHeight: 1400,
    });
    expect(one.calculatedHeightMm).toBeLessThan(five.calculatedHeightMm);
    expect(five.calculatedHeightMm).toBeLessThan(twenty.calculatedHeightMm);
    expect(one.calculatedHeightMm).toBeCloseTo((360 * 25.4) / 96 + 5, 2);
  });

  test("parseReceiptHeightPxFromDom reads the measured attribute", () => {
    const dom = `<html data-receipt-height-px="412"><body><!--RECEIPT_HEIGHT_PX:412--></body></html>`;
    expect(parseReceiptHeightPxFromDom(dom)).toBe(412);
  });

  test("dump-dom without the attribute still returns diagnostics instead of throwing", () => {
    const diag = parseReceiptMeasureFromDom("<html><body><div>إيصال</div></body></html>");
    expect(diag.receiptSelectorFound).toBe(false);
    expect(diag.calculatedHeightPx).toBeNull();
    expect(diag.calculatedHeightMm).toBeNull();
  });

  test("parseReceiptMeasureFromDom prefers RECEIPT_MEASURE and ignores a zero box", () => {
    const raw = {
      receiptSelectorFound: true,
      rectHeight: 0,
      receiptScrollHeight: 480,
      bodyScrollHeight: 0,
    };
    const dom = `<html><!--RECEIPT_MEASURE:${JSON.stringify(raw)}--></html>`;
    const diag = parseReceiptMeasureFromDom(dom);
    expect(diag.calculatedHeightPx).toBe(480);
    expect(diag.calculatedHeightMm).toBeCloseTo((480 * 25.4) / 96 + 5, 2);
  });

  test("in-page measure source waits for fonts/images and uses fallback selectors", () => {
    const src = receiptMeasurePageSource();
    expect(src).toContain("document.images");
    expect(src).toContain("document.fonts.ready");
    expect(src).toContain('.receipt');
    expect(src).toContain("#receipt");
    expect(src).toContain("[data-receipt]");
    expect(src).toContain("document.body");
  });

  test("applyReceiptPageSize writes the measured MediaBox size into @page", () => {
    const html = `<style>@page { size: 80mm; margin: 0; }</style>`;
    const out = applyReceiptPageSize(html, 80, 103.25);
    expect(out).toContain("@page { size: 80mm 103.25mm; margin: 0; }");
    expect(out).not.toContain("297mm");
  });

  test("side margins default to 3mm so 80mm pages get 74mm content", () => {
    delete process.env.RECEIPT_SIDE_MARGIN_MM;
    delete process.env.RECEIPT_WIDTH_MM;
    expect(getReceiptSideMarginMm()).toBe(3);
    expect(getReceiptContentWidthMm()).toBe(74);
    expect(getReceiptHorizontalOffsetMm()).toBe(0);
  });

  test("RECEIPT_SIDE_MARGIN_MM changes content width", () => {
    process.env.RECEIPT_WIDTH_MM = "80";
    process.env.RECEIPT_SIDE_MARGIN_MM = "4";
    expect(getReceiptContentWidthMm()).toBe(72);
  });

  test("RECEIPT_HORIZONTAL_OFFSET_MM adds a physical left shift only when set", () => {
    process.env.RECEIPT_HORIZONTAL_OFFSET_MM = "1";
    expect(getReceiptHorizontalOffsetMm()).toBe(1);
    const html = buildReceiptHtml({
      transactionId: 1,
      timestamp: "2026-09-08 12:00:00",
      lines: [{ name: "خبز", quantity: 1, price: 1, lineTotal: 1 }],
      subtotal: 1,
      tax: 0,
      total: 1,
      paymentMethod: "cash",
      settings: {},
    });
    expect(html).toContain("left: 1mm");
  });

  test("measure hook is injected once before </body>", () => {
    const html = `<html><body><div class="thanks">شكراً لزيارتكم</div></body></html>`;
    const once = injectReceiptMeasureHook(html);
    const twice = injectReceiptMeasureHook(once);
    expect(once).toContain('data-abo-receipt-measure="1"');
    expect(once.match(/data-abo-receipt-measure="1"/g)).toHaveLength(1);
    expect(twice.match(/data-abo-receipt-measure="1"/g)).toHaveLength(1);
    expect(once.indexOf("data-abo-receipt-measure")).toBeLessThan(once.lastIndexOf("</body>"));
  });
});
