import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import {
  partyBalanceAroundMove,
  partyBalanceForPurchaseInvoice,
  partyBalanceForSale,
  partyBalanceForVoucher,
} from "../utils/partyBalanceAroundMove.js";
import { buildReceiptHtml, buildReceiptText } from "../utils/receipt.js";

function unwrapData(body) {
  return body?.data ?? body;
}

describe("partyBalanceAroundMove", () => {
  let ctx;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("draft purchase previews current balance plus this invoice", async () => {
    const sup = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, balance, opening_balance)
       VALUES ('Draft Sup', 'PB1', 60, 0)`
    );
    const pb = await partyBalanceAroundMove(ctx.db, {
      partyType: "supplier",
      partyId: sup.lastID,
      delta: 20,
      status: "draft",
      sourceType: "purchase",
      sourceId: 999,
    });
    expect(pb.projected).toBe(true);
    expect(pb.before).toBeCloseTo(60, 2);
    expect(pb.after).toBeCloseTo(80, 2);
    expect(pb.before_display).toBe("60.00");
    expect(pb.after_display).toBe("80.00");
  });

  test("posted purchase reprint stays historical after a later payment", async () => {
    const sup = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, balance, opening_balance)
       VALUES ('Hist Sup', 'PB2', 100, 0)`
    );
    const inv = await ctx.db.run(
      `INSERT INTO purchase_invoices (supplier_id, invoice_date, total, status)
       VALUES (?, '2026-01-01', 100, 'posted')`,
      [sup.lastID]
    );
    const first = await partyBalanceForPurchaseInvoice(ctx.db, {
      id: inv.lastID,
      supplier_id: sup.lastID,
      supplier_name: "Hist Sup",
      total: 100,
      status: "posted",
    });
    expect(first.projected).toBe(false);
    expect(first.before).toBeCloseTo(0, 2);
    expect(first.after).toBeCloseTo(100, 2);

    const voucher = await ctx.db.run(
      `INSERT INTO vouchers (voucher_type, voucher_date, status, total_amount)
       VALUES ('payment', '2026-02-01', 'posted', 40)`
    );
    await ctx.db.run(
      `INSERT INTO voucher_lines (voucher_id, line_type, amount, amount_nis, supplier_id)
       VALUES (?, 'cash', 40, 40, ?)`,
      [voucher.lastID, sup.lastID]
    );
    await ctx.db.run("UPDATE suppliers SET balance = 60 WHERE id = ?", [sup.lastID]);

    const reprint = await partyBalanceForPurchaseInvoice(ctx.db, {
      id: inv.lastID,
      supplier_id: sup.lastID,
      supplier_name: "Hist Sup",
      total: 100,
      status: "posted",
    });
    expect(reprint.before).toBeCloseTo(0, 2);
    expect(reprint.after).toBeCloseTo(100, 2);
    expect(reprint.after).not.toBeCloseTo(60, 2);
  });

  test("cash-only sale omits a party balance", async () => {
    const cust = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance)
       VALUES ('Cash Cust', 'PB3', 0, 0)`
    );
    const pb = await partyBalanceForSale(ctx.db, {
      customerId: cust.lastID,
      payments: [{ method: "cash", nis_equivalent: 10 }],
      transactionId: 1,
      status: "posted",
    });
    expect(pb).toBeNull();
  });

  test("posted supplier receipt voucher includes before/after", async () => {
    const sup = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, balance, opening_balance)
       VALUES ('Receipt Sup', 'PB6', 80, 60)`
    );
    const voucher = await ctx.db.run(
      `INSERT INTO vouchers (voucher_type, voucher_no, voucher_date, status, total_amount)
       VALUES ('receipt', 9, '2026-04-01', 'posted', 20)`
    );
    await ctx.db.run(
      `INSERT INTO voucher_lines (voucher_id, line_type, amount, amount_nis, supplier_id)
       VALUES (?, 'cash', 20, 20, ?)`,
      [voucher.lastID, sup.lastID]
    );
    const pb = await partyBalanceForVoucher(
      ctx.db,
      { id: voucher.lastID, voucher_type: "receipt", status: "posted" },
      [{ supplier_id: sup.lastID, supplier_name: "Receipt Sup", amount_nis: 20 }]
    );
    expect(pb).toBeTruthy();
    expect(pb.before).toBeCloseTo(60, 2);
    expect(pb.after).toBeCloseTo(80, 2);
  });

  test("draft customer receipt voucher previews a lower balance", async () => {
    const cust = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance)
       VALUES ('Receipt Cust', 'PB4', 50, 0)`
    );
    const pb = await partyBalanceForVoucher(
      ctx.db,
      { id: 1, voucher_type: "receipt", status: "draft" },
      [{ customer_id: cust.lastID, customer_name: "Receipt Cust", amount_nis: 10 }]
    );
    expect(pb.projected).toBe(true);
    expect(pb.before).toBeCloseTo(50, 2);
    expect(pb.after).toBeCloseTo(40, 2);
    expect(pb.after_display).toBe("40.00");
  });
});

describe("party_balance APIs and receipts", () => {
  let ctx;
  let adminToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = adminLogin.body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("GET purchase invoice includes historical party_balance", async () => {
    const sup = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, balance, opening_balance)
       VALUES ('Api Sup', 'PB5', 80, 0)`
    );
    const inv = await ctx.db.run(
      `INSERT INTO purchase_invoices (supplier_id, invoice_date, total, status)
       VALUES (?, '2026-03-01', 80, 'posted')`,
      [sup.lastID]
    );
    const res = await request(ctx.app)
      .get(`/api/v1/purchases/invoices/${inv.lastID}`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const row = unwrapData(res.body);
    expect(row.party_balance.before).toBeCloseTo(0, 2);
    expect(row.party_balance.after).toBeCloseTo(80, 2);
    expect(row.party_balance.projected).toBe(false);
  });

  test("POS receipt HTML includes before/after only when a balance moved", () => {
    const cashHtml = buildReceiptHtml({
      transactionId: 1,
      timestamp: "2026-07-06 12:00:00",
      cashierName: "test",
      lines: [{ name: "خبز", quantity: 1, price: 5, lineTotal: 5 }],
      subtotal: 5,
      tax: 0,
      total: 5,
      paymentMethod: "cash",
      settings: {},
    });
    expect(cashHtml).not.toContain("الرصيد قبل");

    const onAccountHtml = buildReceiptHtml({
      transactionId: 2,
      timestamp: "2026-07-06 12:00:00",
      cashierName: "test",
      lines: [{ name: "خبز", quantity: 1, price: 5, lineTotal: 5 }],
      subtotal: 5,
      tax: 0,
      total: 5,
      paymentMethod: "on_account",
      settings: {},
      partyBalance: {
        before_display: "0.00",
        after_display: "5.00",
      },
    });
    expect(onAccountHtml).toContain("الرصيد قبل: 0.00");
    expect(onAccountHtml).toContain("الرصيد بعد: 5.00");
    expect(onAccountHtml).not.toContain("علينا للمورد");
    expect(onAccountHtml).not.toContain("على العميل");
    expect(onAccountHtml).toMatch(/<div class="thanks">شكراً لزيارتكم<\/div>\s*<\/div>\s*<\/body>/);

    const text = buildReceiptText({
      transactionId: 2,
      timestamp: "2026-07-06 12:00:00",
      cashierName: "test",
      lines: [{ name: "خبز", quantity: 1, price: 5, lineTotal: 5 }],
      subtotal: 5,
      tax: 0,
      total: 5,
      paymentMethod: "on_account",
      settings: {},
      partyBalance: {
        before_display: "0.00",
        after_display: "5.00",
      },
    });
    expect(text).toContain("الرصيد قبل:");
    expect(text).toContain("الرصيد بعد:");
  });
});
