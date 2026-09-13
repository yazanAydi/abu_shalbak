import request from "supertest";
import {
  authHeader,
  createTestContext,
  destroyTestContext,
  login,
  withCheckoutKey,
} from "./helpers.js";
import {
  setSilentPrintTestAdapter,
  SilentPrintError,
} from "../services/windowsSilentPrint.js";
import { STORE_NAME_AR } from "../utils/storeBranding.js";

describe("silent receipt print", () => {
  let ctx;
  let cashierToken;
  let transactionId;
  let saleTotal;

  beforeAll(async () => {
    ctx = await createTestContext();
    const loginRes = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = loginRes.body.token;
    await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashierToken))
      .send({ opening_cash: 50 });
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey({
        items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
        payment_method: "cash",
      }));
    transactionId = sale.body.data.transaction_id;
    saleTotal = Number(sale.body.data.total);
  });

  afterEach(() => {
    setSilentPrintTestAdapter(null);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("rejects missing transaction_id", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/print-receipt/silent")
      .set(authHeader(cashierToken))
      .send({});
    expect(res.status).toBe(400);
  });

  test("returns 404 for unknown sale", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/print-receipt/silent")
      .set(authHeader(cashierToken))
      .send({ transaction_id: 999999 });
    expect(res.status).toBe(404);
  });

  test("LAN POS origin can call silent print on the same host", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/print-receipt/silent")
      .set(authHeader(cashierToken))
      .set("Host", "192.168.1.40:3000")
      .set("Origin", "http://192.168.1.40:3000")
      .send({ transaction_id: transactionId });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://192.168.1.40:3000");
    expect(res.body.data?.printed ?? res.body.printed).toBe(true);
  });

  test("dry-runs print in test env", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/print-receipt/silent")
      .set(authHeader(cashierToken))
      .send({ transaction_id: transactionId });
    expect(res.status).toBe(200);
    expect(res.body.data?.printed ?? res.body.printed).toBe(true);
    expect(res.body.data?.dry_run ?? res.body.dry_run).toBe(true);
  });

  test("agent unavailable returns 503 and keeps the sale", async () => {
    setSilentPrintTestAdapter(async () => {
      throw new SilentPrintError(
        "AGENT_UNAVAILABLE",
        "تعذر الاتصال بطابعة الإيصالات. تأكد من تشغيل خدمة الطباعة ثم حاول مرة أخرى."
      );
    });
    const res = await request(ctx.app)
      .post("/api/v1/print-receipt/silent")
      .set(authHeader(cashierToken))
      .send({ transaction_id: transactionId });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("AGENT_UNAVAILABLE");

    const row = await ctx.db.get("SELECT id, total FROM transactions WHERE id = ?", [
      transactionId,
    ]);
    expect(row).toBeTruthy();
    expect(Number(row.total)).toBe(saleTotal);
  });

  test("printer unavailable returns Arabic error and keeps the sale", async () => {
    setSilentPrintTestAdapter(async () => {
      throw new SilentPrintError("NO_PRINTER", "لا توجد طابعة افتراضية في ويندوز");
    });
    const res = await request(ctx.app)
      .post("/api/v1/print-receipt/silent")
      .set(authHeader(cashierToken))
      .send({ transaction_id: transactionId });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("طابعة");
    expect(res.body.code).toBe("NO_PRINTER");

    const row = await ctx.db.get("SELECT id, total FROM transactions WHERE id = ?", [
      transactionId,
    ]);
    expect(row).toBeTruthy();
    expect(Number(row.total)).toBe(saleTotal);
  });

  test("retry after printer failure then succeeds for the same sale", async () => {
    let calls = 0;
    setSilentPrintTestAdapter(async () => {
      calls += 1;
      if (calls === 1) {
        throw new SilentPrintError("NO_PRINTER", "لا توجد طابعة افتراضية في ويندوز");
      }
      return { printed: true, dryRun: true };
    });

    const fail = await request(ctx.app)
      .post("/api/v1/print-receipt/silent")
      .set(authHeader(cashierToken))
      .send({ transaction_id: transactionId });
    expect(fail.status).toBe(409);

    const ok = await request(ctx.app)
      .post("/api/v1/print-receipt/silent")
      .set(authHeader(cashierToken))
      .send({ transaction_id: transactionId });
    expect(ok.status).toBe(200);
    expect(ok.body.data?.printed ?? ok.body.printed).toBe(true);
    expect(ok.body.data?.transaction_id ?? ok.body.transaction_id).toBe(transactionId);
  });

  test("reprint of the same sale is allowed", async () => {
    const first = await request(ctx.app)
      .post("/api/v1/print-receipt/silent")
      .set(authHeader(cashierToken))
      .send({ transaction_id: transactionId });
    const second = await request(ctx.app)
      .post("/api/v1/print-receipt/silent")
      .set(authHeader(cashierToken))
      .send({ transaction_id: transactionId });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  test("PDF_FAILED in save mode includes measure diagnostics", async () => {
    const prev = process.env.RECEIPT_PRINT_TEST_MODE;
    process.env.RECEIPT_PRINT_TEST_MODE = "save";
    const details = {
      receiptSelectorFound: false,
      rectHeight: 0,
      receiptScrollHeight: 0,
      bodyScrollHeight: 0,
      calculatedHeightPx: null,
      calculatedHeightMm: null,
    };
    setSilentPrintTestAdapter(async () => {
      throw new SilentPrintError("PDF_FAILED", "تعذّر قياس ارتفاع محتوى الإيصال", details);
    });
    try {
      const res = await request(ctx.app)
        .post("/api/v1/print-receipt/silent")
        .set(authHeader(cashierToken))
        .send({ transaction_id: transactionId });
      expect(res.status).toBe(500);
      expect(res.body.code).toBe("PDF_FAILED");
      expect(res.body.details).toEqual(details);
      expect(res.body.error).toContain("تعذّر قياس");
    } finally {
      if (prev == null) delete process.env.RECEIPT_PRINT_TEST_MODE;
      else process.env.RECEIPT_PRINT_TEST_MODE = prev;
    }
  });

  test("save test mode returns measured PDF fields and HTTP 200", async () => {
    setSilentPrintTestAdapter(async () => ({
      printed: true,
      testMode: true,
      pdfPath: "C:\\abo_shalbak\\tmp\\receipt-test\\receipt.pdf",
      widthMm: 80.25,
      heightMm: 117.5,
    }));
    const res = await request(ctx.app)
      .post("/api/v1/print-receipt/silent")
      .set(authHeader(cashierToken))
      .send({ transaction_id: transactionId });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.testMode).toBe(true);
    expect(res.body.pdfPath).toContain("receipt-test");
    expect(res.body.widthMm).toBe(80.25);
    expect(res.body.heightMm).toBe(117.5);
    const data = res.body.data;
    expect(data.testMode).toBe(true);
    expect(data.pdfPath).toBe(res.body.pdfPath);
    expect(data.widthMm).toBe(80.25);
    expect(data.heightMm).toBe(117.5);
  });

  test("receipt HTML stays RTL Arabic with totals", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/print-receipt")
      .set(authHeader(cashierToken))
      .send({ transaction_id: transactionId });
    expect(res.status).toBe(200);
    const html = res.body.data?.receipt_html ?? res.body.receipt_html;
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(STORE_NAME_AR);
    expect(html).toContain("شكراً لزيارتكم");
    expect(html).toContain("المبلغ للدفع");
    expect(html).toContain(String(saleTotal.toFixed(2)));
    expect(html).toContain(">الرقم<");
  });
});
