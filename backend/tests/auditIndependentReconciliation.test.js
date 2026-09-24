/**
 * Independent audit fixtures. Expected amounts are derived from the documented
 * business rules (round2, POS tax 0, KG whole-shekel charge, inventory_ledger
 * as stock truth, historical COGS from unit_cost_at_sale) — not by copying
 * production report SQL.
 *
 * Isolated temp DB via createTestContext. Never opens ./data/supermarket.db.
 */
import path from "path";
import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
} from "./helpers.js";
import { round2, roundScaleSaleTotal } from "../utils/money.js";
import { computePurchaseInvoiceTotals } from "../utils/tax.js";
import { deriveStockFromLedger } from "../utils/inventoryLedger.js";
import { wacAfterInbound } from "../utils/purchaseInventoryCost.js";
import { invalidatePromotionsCache } from "../utils/promotions.js";
import { shopTodayYmd, shopYmdFromTimestamp } from "../utils/shopTime.js";
import { businessDayFromTimestamp, shopBusinessDayYmd } from "../utils/businessDay.js";
import { shiftHours, shiftPay } from "../services/cashierPayrollService.js";
import { updateAppSettings } from "../utils/settings.js";
import { buildReceiptPayload } from "../utils/receipt.js";
import { getWarehouseValuation } from "../utils/warehouseInventory.js";
import { buildSupplierLedger } from "../utils/supplierLedger.js";

function unwrap(resOrBody) {
  const body = resOrBody?.body ?? resOrBody;
  return body?.data ?? body;
}

/** Independent VAT-inclusive extraction: VAT = round2(gross * rate / (1 + rate)). */
function independentInclusiveVat(gross, rate) {
  const g = Number(gross) || 0;
  const r = Number(rate) || 0;
  if (r <= 0) return { vat: 0, net: round2(g), total: round2(g) };
  const vat = round2((g * r) / (1 + r));
  const net = round2(g - vat);
  return { vat, net, total: round2(g) };
}

describe("audit independent reconciliation", () => {
  describe("isolation", () => {
    let ctx;
    afterAll(async () => {
      await destroyTestContext(ctx);
    });

    test("uses a disposable temp database, not the live shop file", async () => {
      ctx = await createTestContext();
      const resolved = path.resolve(ctx.dbPath);
      expect(resolved).toMatch(/abo-shalbak-test-/);
      expect(resolved.toLowerCase()).not.toMatch(/[/\\]data[/\\]supermarket\.db$/);
      expect(process.env.NODE_ENV).toBe("test");
      expect(process.env.DISABLE_AUTO_BACKUP).toBe("1");
    });
  });

  describe("purchase VAT vs independent inclusive 16%", () => {
    test("documented VAT-inclusive split should extract rate/(1+rate), not gross*rate", () => {
      const gross = 50;
      const rate = 0.16;
      const independent = independentInclusiveVat(gross, rate);
      expect(independent.vat).toBe(6.9);
      expect(independent.net).toBe(43.1);

      const actual = computePurchaseInvoiceTotals([{ total_cost: gross, vat_rate: rate }], rate);
      // Confirmed defect if this fails: tax.js subtracts gross*rate from an inclusive total.
      expect({
        vat: actual.lines[0].line_vat,
        net: actual.lines[0].line_net,
        payable: actual.total,
      }).toEqual({
        vat: independent.vat,
        net: independent.net,
        payable: independent.total,
      });
    });
  });

  describe("end-to-end dataset", () => {
    let ctx;
    let adminToken;
    let cashierToken;
    let cashierId;
    const today = shopTodayYmd();

    let milk;
    let bread;
    let cheese;
    let customerId;
    let supplierId;
    let shiftId;

    const ids = {};
    const expected = {
      milkSoldQty: 0,
      milkRefundQty: 0,
      breadSoldQty: 0,
      cheeseSoldKg: 0,
      posGross: 0,
      posDiscount: 0,
      refunds: 0,
      onAccountPosted: 0,
      purchasePayable: 0,
      supplierPaid: 0,
      opex: 0,
    };

    beforeAll(async () => {
      ctx = await createTestContext();
      adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
      const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
      cashierToken = cashierLogin.body.token;
      cashierId = cashierLogin.body.user.id;

      const shiftRes = await request(ctx.app)
        .post("/api/v1/shifts/start")
        .set(authHeader(cashierToken))
        .send({ opening_cash: 200 });
      expect(shiftRes.status).toBe(201);
      shiftId = unwrap(shiftRes).shift_id;

      async function createProduct(body) {
        const res = await request(ctx.app)
          .post("/api/v1/products")
          .set(authHeader(adminToken))
          .send(body);
        expect(res.status).toBe(201);
        const row = unwrap(res);
        const unit = await ctx.db.get(
          "SELECT * FROM product_units WHERE product_id = ? ORDER BY is_default DESC, id ASC",
          [row.id]
        );
        return { ...row, unit };
      }

      milk = await createProduct({
        barcode: "7701000001",
        name: "حليب تدقيق",
        price: 8,
        cost: 5,
        stock: 50,
        category: "ألبان",
        unit: "حبة",
      });
      bread = await createProduct({
        barcode: "7701000002",
        name: "خبز تدقيق",
        price: 4,
        cost: 1,
        stock: 20,
        category: "مخبز",
        unit: "حبة",
      });
      cheese = await createProduct({
        barcode: "7701000003",
        name: "جبنة ميزان",
        price: 20,
        cost: 10,
        stock: 10,
        category: "ألبان",
        unit: "كغم",
        is_weighed: true,
      });

      const bakeryCat = await ctx.db.get("SELECT id FROM product_categories WHERE name = ?", ["مخبز"]);
      expect(bakeryCat).toBeTruthy();
      const saveCats = await request(ctx.app)
        .put("/api/v1/reports/bakery/categories")
        .set(authHeader(adminToken))
        .send({ category_ids: [bakeryCat.id] });
      expect(saveCats.status).toBe(200);

      const cust = await ctx.db.run(
        `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
         VALUES ('زبون تدقيق', 'AUD-C1', 0, 0, 0)`
      );
      customerId = cust.lastID;
      const sup = await ctx.db.run("INSERT INTO suppliers (name, supplier_code, balance) VALUES ('مورد تدقيق', 'AUD-S1', 0)");
      supplierId = sup.lastID;
    });

    afterAll(async () => {
      await destroyTestContext(ctx);
    });

    async function checkout(body) {
      const res = await request(ctx.app)
        .post("/api/v1/checkout")
        .set(authHeader(cashierToken))
        .send(withCheckoutKey(body));
      return res;
    }

    async function approveOnAccount(requestId) {
      const res = await request(ctx.app)
        .put(`/api/v1/on-account-requests/${requestId}`)
        .set(authHeader(adminToken))
        .send({ status: "approved" });
      expect(res.status).toBe(200);
      return unwrap(res);
    }

    test("cash 2× milk: qty × price, tax 0, stock and ledger", async () => {
      const independent = round2(2 * 8);
      const res = await checkout({
        items: [{ product_id: milk.id, quantity: 2, price: 8, unit_id: milk.unit.id }],
        payment_method: "cash",
      });
      expect(res.status).toBe(201);
      const body = unwrap(res);
      expect(body.tax).toBe(0);
      expect(body.total).toBe(independent);
      expect(body.subtotal).toBe(independent);
      ids.cashMilk = body.transaction_id;
      expected.posGross = round2(expected.posGross + independent);
      expected.milkSoldQty += 2;

      const stock = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [milk.id]);
      expect(Number(stock.stock)).toBe(48);
      const ledger = await deriveStockFromLedger(ctx.db, milk.id);
      expect(ledger).toBe(48);

      const item = await ctx.db.get(
        "SELECT unit_cost_at_sale, gross_profit, line_gross, line_net FROM transaction_items WHERE transaction_id = ?",
        [body.transaction_id]
      );
      expect(Number(item.unit_cost_at_sale)).toBe(5);
      expect(Number(item.line_gross)).toBe(16);
      expect(Number(item.gross_profit)).toBe(6);
    });

    test("visa 1× bread counts in bakery subset and overall", async () => {
      const res = await checkout({
        items: [{ product_id: bread.id, quantity: 1, price: 4, unit_id: bread.unit.id }],
        payment_method: "visa",
      });
      expect(res.status).toBe(201);
      expect(unwrap(res).total).toBe(4);
      ids.visaBread = unwrap(res).transaction_id;
      expected.posGross = round2(expected.posGross + 4);
      expected.breadSoldQty += 1;
    });

    test("weighed 0.255 kg at ₪20 charges whole shekels independently", async () => {
      const raw = round2(0.255 * 20);
      expect(raw).toBe(5.1);
      const charged = roundScaleSaleTotal(raw);
      expect(charged).toBe(5);

      const res = await checkout({
        items: [{ product_id: cheese.id, quantity: 0.255, price: 20, unit_id: cheese.unit.id }],
        payment_method: "cash",
      });
      expect(res.status).toBe(201);
      const body = unwrap(res);
      expect(body.total).toBe(charged);
      ids.weighed = body.transaction_id;
      expected.posGross = round2(expected.posGross + charged);
      expected.cheeseSoldKg += 0.255;

      const stock = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [cheese.id]);
      expect(Number(stock.stock)).toBeCloseTo(9.745, 3);
    });

    test("mixed cash+visa covers the due amount; change is cash only", async () => {
      const res = await checkout({
        items: [{ product_id: milk.id, quantity: 1, price: 8, unit_id: milk.unit.id }],
        payments: [
          { method: "cash", amount: 3 },
          { method: "visa", amount: 5 },
        ],
      });
      expect(res.status).toBe(201);
      const body = unwrap(res);
      expect(body.total).toBe(8);
      const pays = await ctx.db.all(
        "SELECT payment_method, amount FROM sale_payments WHERE transaction_id = ? ORDER BY id",
        [body.transaction_id]
      );
      expect(pays.map((p) => p.payment_method).sort()).toEqual(["cash", "visa"]);
      const sum = round2(pays.reduce((s, p) => s + Number(p.amount), 0));
      expect(sum).toBe(8);
      expected.posGross = round2(expected.posGross + 8);
      expected.milkSoldQty += 1;
      ids.mixed = body.transaction_id;
    });

    test("10% promotion is allocated as money on the line, not a percent leftover", async () => {
      await ctx.db.run(
        `INSERT INTO promotions (name, offer_type, product_id, discount_value, limit_qty, used_qty, active)
         VALUES ('تدقيق 10', 'percentage', ?, 10, 0, 0, 1)`,
        [milk.id]
      );
      invalidatePromotionsCache();
      try {
        const res = await checkout({
          items: [{ product_id: milk.id, quantity: 1, price: 8, unit_id: milk.unit.id }],
          payment_method: "cash",
        });
        expect(res.status).toBe(201);
        const body = unwrap(res);
        const independentDiscount = round2(8 * 0.1);
        const beforeRounding = round2(8 - independentDiscount);
        expect(Number(body.discount)).toBe(independentDiscount);
        expect(Number(body.amount_before_rounding)).toBe(beforeRounding);
        expect(Number(body.rounding_adjustment)).toBe(-0.2);
        expect(Number(body.total)).toBe(7);
        const item = await ctx.db.get(
          "SELECT discount_at_sale, line_gross, line_net FROM transaction_items WHERE transaction_id = ?",
          [body.transaction_id]
        );
        expect(Number(item.discount_at_sale)).toBe(independentDiscount);
        expect(Number(item.line_net)).toBe(beforeRounding);
        expected.posGross = round2(expected.posGross + Number(body.total));
        expected.posDiscount = round2(expected.posDiscount + independentDiscount);
        expected.milkSoldQty += 1;
        ids.promoMilk = body.transaction_id;
      } finally {
        await ctx.db.run("UPDATE promotions SET active = 0 WHERE product_id = ?", [milk.id]);
        invalidatePromotionsCache();
      }
    });

    test("pending ذمة does not move stock or customer balance until approval", async () => {
      const stockBefore = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [bread.id])).stock);
      const balBefore = Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance);
      const res = await checkout({
        items: [{ product_id: bread.id, quantity: 1, price: 4, unit_id: bread.unit.id }],
        payment_method: "on_account",
        customer_id: customerId,
      });
      expect(res.status).toBe(202);
      const pending = unwrap(res);
      expect(pending.pending_approval).toBe(true);
      ids.oaRequest = pending.request_id;

      const stockMid = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [bread.id])).stock);
      const balMid = Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance);
      expect(stockMid).toBe(stockBefore);
      expect(balMid).toBe(balBefore);

      const approved = await approveOnAccount(pending.request_id);
      const txId = approved.transaction_id || approved.request?.transaction_id || unwrap(approved)?.checkout?.transaction_id;
      const row = await ctx.db.get("SELECT transaction_id FROM on_account_requests WHERE id = ?", [pending.request_id]);
      ids.oaSale = Number(txId || row.transaction_id);
      expected.posGross = round2(expected.posGross + 4);
      expected.breadSoldQty += 1;
      expected.onAccountPosted = round2(expected.onAccountPosted + 4);

      const stockAfter = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [bread.id])).stock);
      const balAfter = Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance);
      expect(stockAfter).toBe(stockBefore - 1);
      expect(balAfter).toBe(balBefore + 4);
    });

    test("rejected ذمة never posts money or stock", async () => {
      const stockBefore = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [bread.id])).stock);
      const balBefore = Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance);
      const txBefore = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM transactions")).n);
      const res = await checkout({
        items: [{ product_id: bread.id, quantity: 1, price: 4, unit_id: bread.unit.id }],
        payment_method: "on_account",
        customer_id: customerId,
      });
      expect(res.status).toBe(202);
      const reject = await request(ctx.app)
        .put(`/api/v1/on-account-requests/${unwrap(res).request_id}`)
        .set(authHeader(adminToken))
        .send({ status: "rejected" });
      expect(reject.status).toBe(200);
      expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [bread.id])).stock)).toBe(stockBefore);
      expect(Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId])).balance)).toBe(
        balBefore
      );
      expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM transactions")).n)).toBe(txBefore);
    });

    test("mixed cash + on_account posts only the ذمة share to the customer", async () => {
      const res = await checkout({
        items: [{ product_id: milk.id, quantity: 1, price: 8, unit_id: milk.unit.id }],
        payments: [
          { method: "cash", amount: 3 },
          { method: "on_account", amount: 5 },
        ],
        customer_id: customerId,
      });
      expect(res.status).toBe(202);
      await approveOnAccount(unwrap(res).request_id);
      const row = await ctx.db.get("SELECT transaction_id FROM on_account_requests WHERE id = ?", [
        unwrap(res).request_id,
      ]);
      ids.mixedOa = row.transaction_id;
      expected.posGross = round2(expected.posGross + 8);
      expected.milkSoldQty += 1;
      expected.onAccountPosted = round2(expected.onAccountPosted + 5);

      const cust = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId]);
      expect(Number(cust.balance)).toBe(9);

      const tx = await ctx.db.get("SELECT payment_method, total FROM transactions WHERE id = ?", [ids.mixedOa]);
      expect(tx.payment_method).toBe("mixed");
      expect(Number(tx.total)).toBe(8);
    });

    test("customer ledger debit for mixed ذمة must equal the on_account payment, not omit the sale", async () => {
      const led = await request(ctx.app)
        .get(`/api/v1/customers/${customerId}/ledger`)
        .set(authHeader(adminToken));
      expect(led.status).toBe(200);
      const body = unwrap(led);
      const saleDebits = (body.rows || body.events || []).filter(
        (r) => r.ev_type === "sale" || r.ev_type === "sale_invoice"
      );
      const debitSum = round2(saleDebits.reduce((s, r) => s + Number(r.debit || 0), 0));
      // Independent: 4 (pure ذمة bread) + 5 (mixed milk) = 9, matching customers.balance.
      expect(debitSum).toBe(9);
      expect(Number(body.closing ?? body.closing_balance ?? body.customer?.balance)).toBe(9);
    });

    test("replaying a mixed ذمة checkout does not add debt, cash, or stock again", async () => {
      const cust = await ctx.db.run(
        `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
         VALUES ('إعادة ذمة', 'AUD-REPLAY', 0, 0, 0)`
      );
      const stockBefore = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [milk.id])).stock);
      const body = {
        idempotency_key: "audit-mixed-replay",
        items: [{ product_id: milk.id, quantity: 1, price: 8, unit_id: milk.unit.id }],
        payments: [
          { method: "cash", amount: 3 },
          { method: "on_account", amount: 5 },
        ],
        customer_id: cust.lastID,
      };
      const first = await request(ctx.app).post("/api/v1/checkout").set(authHeader(cashierToken)).send(body);
      expect(first.status).toBe(202);
      await approveOnAccount(unwrap(first).request_id);
      const replay = await request(ctx.app).post("/api/v1/checkout").set(authHeader(cashierToken)).send(body);
      expect([200, 202]).toContain(replay.status);
      const balance = Number((await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [cust.lastID])).balance);
      const stock = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [milk.id])).stock);
      const sales = await ctx.db.get(
        "SELECT COUNT(*) AS n FROM transactions WHERE customer_id = ?",
        [cust.lastID]
      );
      expect(balance).toBe(5);
      expect(stock).toBe(stockBefore - 1);
      expect(Number(sales.n)).toBe(1);
      expected.posGross = round2(expected.posGross + 8);
      expected.milkSoldQty += 1;
    });

    test("partial cash refund restores one milk and reduces net sales", async () => {
      const stockBefore = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [milk.id])).stock);
      const reqRes = await request(ctx.app)
        .post("/api/v1/refund-requests")
        .set(authHeader(cashierToken))
        .send({
          original_transaction_id: ids.cashMilk,
          lines: [{ product_id: milk.id, quantity: 1, unit_id: milk.unit.id }],
          reason: "تدقيق مرتجع جزئي",
          payment_method: "cash",
        });
      expect(reqRes.status).toBe(201);
      const requestId = unwrap(reqRes).request_id;

      const cashierApprove = await request(ctx.app)
        .put(`/api/v1/refund-requests/${requestId}`)
        .set(authHeader(cashierToken))
        .send({ status: "approved" });
      expect(cashierApprove.status).toBe(403);

      const approve = await request(ctx.app)
        .put(`/api/v1/refund-requests/${requestId}`)
        .set(authHeader(adminToken))
        .send({ status: "approved" });
      expect(approve.status).toBe(200);

      const stockAfter = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [milk.id])).stock);
      expect(stockAfter).toBe(stockBefore + 1);
      expected.milkRefundQty += 1;
      expected.refunds = round2(expected.refunds + 8);
      ids.refund = requestId;
    });

    test("purchase 10 milk at 60 with 10% discount updates WAC from payable gross", async () => {
      const stockBefore = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [milk.id])).stock);
      const costBefore = Number((await ctx.db.get("SELECT cost FROM products WHERE id = ?", [milk.id])).cost);
      const payable = round2(60 * 0.9);
      expect(payable).toBe(54);
      const inboundUnit = round2(payable / 10);
      const independentWac = wacAfterInbound(stockBefore, costBefore, 10, inboundUnit);

      const create = await request(ctx.app)
        .post("/api/v1/purchases/invoices")
        .set(authHeader(adminToken))
        .send({
          supplier_id: supplierId,
          invoice_date: today,
          items: [
            {
              product_id: milk.id,
              quantity: 10,
              total_cost: 60,
              discount_pct: 10,
              vat_rate: 0.16,
            },
          ],
        });
      expect(create.status).toBe(201);
      const inv = unwrap(create);
      const post = await request(ctx.app)
        .post(`/api/v1/purchases/invoices/${inv.id}/post`)
        .set(authHeader(adminToken))
        .send({});
      expect(post.status).toBe(200);
      expected.purchasePayable = payable;

      const after = await ctx.db.get("SELECT stock, cost FROM products WHERE id = ?", [milk.id]);
      expect(Number(after.stock)).toBe(stockBefore + 10);
      expect(Number(after.cost)).toBe(independentWac);

      const posted = await ctx.db.get("SELECT total, status FROM purchase_invoices WHERE id = ?", [inv.id]);
      expect(posted.status).toBe("posted");
      expect(Number(posted.total)).toBe(payable);

      const del = await request(ctx.app)
        .delete(`/api/v1/purchases/invoices/${inv.id}`)
        .set(authHeader(adminToken));
      expect(del.status).toBe(400);

      const sup = await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId]);
      expect(Number(sup.balance)).toBe(payable);
    });

    test("سند صرف 20 reduces supplier balance; receipt does not double-count purchases", async () => {
      const create = await request(ctx.app)
        .post("/api/v1/vouchers")
        .set(authHeader(adminToken))
        .send({
          voucher_type: "payment",
          voucher_date: today,
          lines: [{ line_type: "cash", amount: 20, currency: "NIS", supplier_id: supplierId }],
        });
      expect(create.status).toBe(201);
      const voucher = unwrap(create);
      const post = await request(ctx.app)
        .post(`/api/v1/vouchers/${voucher.id}/post`)
        .set(authHeader(adminToken))
        .send({});
      expect(post.status).toBe(200);
      expected.supplierPaid = 20;
      const sup = await ctx.db.get("SELECT balance FROM suppliers WHERE id = ?", [supplierId]);
      expect(Number(sup.balance)).toBe(round2(expected.purchasePayable - 20));
    });

    test("operating expense 15 is period opex and is not a supplier purchase", async () => {
      const rent = await ctx.db.get("SELECT id FROM expense_categories WHERE name = 'rent'");
      const res = await request(ctx.app)
        .post("/api/v1/expenses")
        .set(authHeader(adminToken))
        .send({
          category_id: rent.id,
          amount: 15,
          paid_on: today,
          payment_method: "cash",
          reference_note: "تدقيق إيجار",
        });
      expect(res.status).toBe(201);
      expected.opex = 15;
    });

    test("finance overview, daily report, bakery, and stock reconcile to independent totals", async () => {
      const milkSoldNet = expected.milkSoldQty - expected.milkRefundQty;
      const independentCogsSales = round2(
        expected.milkSoldQty * 5 + expected.breadSoldQty * 1 + expected.cheeseSoldKg * 10
      );
      const independentCogsRefunds = round2(expected.milkRefundQty * 5);
      const independentNetCogs = round2(independentCogsSales - independentCogsRefunds);
      const independentNetSales = round2(expected.posGross - expected.refunds);
      const independentGrossProfit = round2(independentNetSales - independentNetCogs);
      const independentOpProfit = round2(independentGrossProfit - expected.opex);

      const finRes = await request(ctx.app)
        .get("/api/v1/finance/overview")
        .query({ from: today, to: today })
        .set(authHeader(adminToken));
      expect(finRes.status).toBe(200);
      const fin = unwrap(finRes);

      expect(Number(fin.sales.gross)).toBe(expected.posGross);
      expect(Number(fin.sales.refunds)).toBe(expected.refunds);
      expect(Number(fin.sales.net)).toBe(independentNetSales);
      expect(fin.cogs_unknown).toBe(false);
      expect(Number(fin.profit.cogs)).toBe(independentNetCogs);
      expect(Number(fin.profit.grossProfit)).toBe(independentGrossProfit);
      expect(Number(fin.profit.operatingExpenses)).toBe(expected.opex);
      expect(Number(fin.profit.operatingNetProfit)).toBe(independentOpProfit);
      expect(Number(fin.purchases.net)).toBe(expected.purchasePayable);
      expect(Number(fin.supplierPayments.voucherTotal)).toBe(expected.supplierPaid);
      expect(fin.supplierPayments.total).toBe(expected.supplierPaid);

      const dailyRes = await request(ctx.app)
        .get("/api/v1/reports/daily")
        .query({ date: today })
        .set(authHeader(adminToken));
      expect(dailyRes.status).toBe(200);
      const daily = unwrap(dailyRes);
      expect(Number(daily.total_sales)).toBe(expected.posGross);
      expect(Number(daily.refunds_total)).toBe(expected.refunds);
      expect(Number(daily.net_sales)).toBe(independentNetSales);

      const bakeryRes = await request(ctx.app)
        .get("/api/v1/reports/bakery")
        .query({ from: today, to: today })
        .set(authHeader(adminToken));
      expect(bakeryRes.status).toBe(200);
      const bakery = unwrap(bakeryRes);
      const independentBakery = round2(expected.breadSoldQty * 4);
      expect(Number(bakery.kpis.net_revenue)).toBe(independentBakery);
      expect(independentBakery).toBeLessThan(independentNetSales);

      const milkStock = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [milk.id])).stock);
      const milkLedger = await deriveStockFromLedger(ctx.db, milk.id);
      expect(milkStock).toBe(milkLedger);
      expect(milkStock).toBe(50 - milkSoldNet + 10);

      const cust = await ctx.db.get("SELECT balance FROM customers WHERE id = ?", [customerId]);
      expect(Number(cust.balance)).toBe(expected.onAccountPosted);
    });

    test("daily report item revenue plus rounding equals billed invoice totals", async () => {
      const daily = unwrap(
        await request(ctx.app)
          .get("/api/v1/reports/daily")
          .query({ date: today })
          .set(authHeader(adminToken))
      );
      // The 10% milk line stays 7.20. Payable rounding removes 0.20 on the invoice only.
      expect(Number(daily.rounding_adjustment)).toBe(-0.2);
      expect(round2(Number(daily.item_revenue) + Number(daily.rounding_adjustment))).toBe(
        Number(daily.total_sales)
      );
    });

    test("reprint and print-receipt do not insert another sale or stock movement", async () => {
      const txBefore = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM transactions")).n);
      const stockBefore = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [milk.id])).stock);
      const print1 = await request(ctx.app)
        .post("/api/v1/print-receipt")
        .set(authHeader(cashierToken))
        .send({ transaction_id: ids.cashMilk });
      const print2 = await request(ctx.app)
        .post("/api/v1/print-receipt")
        .set(authHeader(cashierToken))
        .send({ transaction_id: ids.cashMilk });
      expect(print1.status).toBe(200);
      expect(print2.status).toBe(200);
      expect(print1.body.receipt_html || unwrap(print1).receipt_html).toBeTruthy();
      expect(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM transactions")).n)).toBe(txBefore);
      expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [milk.id])).stock)).toBe(stockBefore);
    });

    test("identical idempotency key replays; changed payload is rejected", async () => {
      const key = `audit-idem-${Date.now()}`;
      const payload = {
        items: [{ product_id: milk.id, quantity: 1, price: 8, unit_id: milk.unit.id }],
        payment_method: "cash",
        idempotency_key: key,
      };
      const first = await request(ctx.app).post("/api/v1/checkout").set(authHeader(cashierToken)).send(payload);
      expect(first.status).toBe(201);
      const replay = await request(ctx.app).post("/api/v1/checkout").set(authHeader(cashierToken)).send(payload);
      expect(replay.status).toBe(200);
      expect(unwrap(replay).transaction_id).toBe(unwrap(first).transaction_id);
      const changed = await request(ctx.app)
        .post("/api/v1/checkout")
        .set(authHeader(cashierToken))
        .send({ ...payload, items: [{ product_id: milk.id, quantity: 2, price: 8, unit_id: milk.unit.id }] });
      expect(changed.status).toBe(409);
    });

    test("changing bread category after sale moves historical bakery totals", async () => {
      const before = unwrap(
        await request(ctx.app)
          .get("/api/v1/reports/bakery")
          .query({ from: today, to: today })
          .set(authHeader(adminToken))
      );
      expect(Number(before.kpis.net_revenue)).toBeGreaterThan(0);
      await ctx.db.run("UPDATE products SET category = 'ألبان' WHERE id = ?", [bread.id]);
      const after = unwrap(
        await request(ctx.app)
          .get("/api/v1/reports/bakery")
          .query({ from: today, to: today })
          .set(authHeader(adminToken))
      );
      expect(Number(after.kpis.net_revenue)).toBe(0);
      await ctx.db.run("UPDATE products SET category = 'مخبز' WHERE id = ?", [bread.id]);
    });
  });

  describe("targeted defects", () => {
    let ctx;
    let adminToken;
    let cashierToken;

    beforeAll(async () => {
      ctx = await createTestContext();
      adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
      cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
      await request(ctx.app)
        .post("/api/v1/shifts/start")
        .set(authHeader(cashierToken))
        .send({ opening_cash: 50 });
    });

    afterAll(async () => {
      await destroyTestContext(ctx);
    });

    test("piece quantity 0.5 is rejected instead of silently becoming 1", async () => {
      const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
      const stockBefore = Number(product.stock);
      const res = await request(ctx.app)
        .post("/api/v1/checkout")
        .set(authHeader(cashierToken))
        .send(
          withCheckoutKey({
            items: [{ product_id: ctx.productId, quantity: 0.5, price: product.price }],
            payment_method: "cash",
          })
        );
      expect(res.status).toBeGreaterThanOrEqual(400);
      const stockAfter = Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId])).stock);
      expect(stockAfter).toBe(stockBefore);
    });

    test("office invoice discount_pct is stored as money on transaction_items.discount_at_sale", async () => {
      const cust = await ctx.db.run(
        `INSERT INTO customers (name, customer_code, balance, opening_balance) VALUES ('مشتري مكتب', 'AUD-INV', 0, 0)`
      );
      const create = await request(ctx.app)
        .post("/api/v1/sales/invoices")
        .set(authHeader(adminToken))
        .send({
          customer_id: cust.lastID,
          invoice_date: shopTodayYmd(),
          items: [{ product_id: ctx.productId, quantity: 2, discount_pct: 10 }],
        });
      expect(create.status).toBe(201);
      const inv = unwrap(create);
      expect(Number(inv.total)).toBe(18);
      const post = await request(ctx.app)
        .post(`/api/v1/sales/invoices/${inv.id}/post`)
        .set(authHeader(adminToken))
        .send({ payment_method: "cash" });
      expect(post.status).toBe(200);
      const posted = unwrap(post);
      const item = await ctx.db.get(
        "SELECT discount_at_sale, line_gross, line_net FROM transaction_items WHERE transaction_id = ?",
        [posted.transaction_id]
      );
      const independentDiscountMoney = round2(20 * 0.1);
      expect(Number(item.discount_at_sale)).toBe(independentDiscountMoney);
      expect(Number(item.line_gross)).toBe(18);
      const refund = await request(ctx.app)
        .post("/api/v1/refund-requests")
        .set(authHeader(cashierToken))
        .send({
          original_transaction_id: posted.transaction_id,
          lines: [{ product_id: ctx.productId, quantity: 1 }],
          reason: "مرتجع جزئي بعد الخصم",
          payment_method: "cash",
        });
      expect(refund.status).toBe(201);
      const pending = await ctx.db.get(
        "SELECT total_amount FROM refund_requests WHERE transaction_id = ?",
        [posted.transaction_id]
      );
      expect(Number(pending.total_amount)).toBe(9);
    });

    test("office posted invoice is not labeled as a POS sale in finance.pos_sales_total", async () => {
      const today = shopTodayYmd();
      const fin = unwrap(
        await request(ctx.app)
          .get("/api/v1/finance/overview")
          .query({ from: today, to: today })
          .set(authHeader(adminToken))
      );
      const officeTx = await ctx.db.get(
        `SELECT COALESCE(SUM(total), 0) AS s FROM transactions WHERE shift_id IS NULL`
      );
      const posTx = await ctx.db.get(
        `SELECT COALESCE(SUM(total), 0) AS s FROM transactions WHERE shift_id IS NOT NULL`
      );
      // Independent: POS-named metric should match POS (shift) sales, not office invoices.
      expect(Number(fin.pos_sales_total)).toBe(round2(Number(posTx.s)));
      expect(Number(officeTx.s)).toBeGreaterThan(0);
    });

    test("cost 0 is not treated as a fully known COGS snapshot", async () => {
      const ins = await request(ctx.app)
        .post("/api/v1/products")
        .set(authHeader(adminToken))
        .send({
          barcode: "7701990001",
          name: "صنف بلا تكلفة",
          price: 10,
          cost: 0,
          stock: 5,
          unit: "حبة",
        });
      expect(ins.status).toBe(201);
      const product = unwrap(ins);
      const sale = await request(ctx.app)
        .post("/api/v1/checkout")
        .set(authHeader(cashierToken))
        .send(
          withCheckoutKey({
            items: [{ product_id: product.id, quantity: 1, price: 10 }],
            payment_method: "cash",
          })
        );
      expect(sale.status).toBe(201);
      const today = shopTodayYmd();
      const fin = unwrap(
        await request(ctx.app)
          .get("/api/v1/finance/overview")
          .query({ from: today, to: today })
          .set(authHeader(adminToken))
      );
      // Independent: missing cost must not produce a complete 100% margin.
      expect(fin.cogs_unknown || fin.profit.cogsKnown === false).toBe(true);
    });

    test("POS allows negative stock; office sales invoice does not silently oversell", async () => {
      const p = await request(ctx.app)
        .post("/api/v1/products")
        .set(authHeader(adminToken))
        .send({
          barcode: "7701990002",
          name: "صنف نفذ",
          price: 3,
          cost: 1,
          stock: 0,
          unit: "حبة",
        });
      const product = unwrap(p);
      const pos = await request(ctx.app)
        .post("/api/v1/checkout")
        .set(authHeader(cashierToken))
        .send(
          withCheckoutKey({
            items: [{ product_id: product.id, quantity: 1, price: 3 }],
            payment_method: "cash",
          })
        );
      expect(pos.status).toBe(201);
      expect(Number((await ctx.db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock)).toBe(-1);

      const cust = await ctx.db.run(
        `INSERT INTO customers (name, customer_code, balance) VALUES ('مشتري مخزون', 'AUD-NEG', 0)`
      );
      const inv = unwrap(
        await request(ctx.app)
          .post("/api/v1/sales/invoices")
          .set(authHeader(adminToken))
          .send({
            customer_id: cust.lastID,
            invoice_date: shopTodayYmd(),
            items: [{ product_id: product.id, quantity: 1 }],
          })
      );
      const post = await request(ctx.app)
        .post(`/api/v1/sales/invoices/${inv.id}/post`)
        .set(authHeader(adminToken))
        .send({ payment_method: "cash" });
      expect(post.status).toBe(400);
    });

    test("cashier payroll uses the captured shift rate and leaves a missing snapshot incomplete", async () => {
      const cashier = await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'");
      await request(ctx.app)
        .patch(`/api/v1/payroll/cashiers/${cashier.id}`)
        .set(authHeader(adminToken))
        .send({ hourly_rate: 20 });
      await ctx.db.run(
        `INSERT INTO cashier_shifts (cashier_id, start_time, end_time, opening_cash, status, hourly_rate_snapshot)
         VALUES (?, '2026-08-01 08:00:00', '2026-08-01 16:00:00', 100, 'closed', 20)`,
        [cashier.id]
      );
      await ctx.db.run(
        `INSERT INTO cashier_shifts (cashier_id, start_time, end_time, opening_cash, status, hourly_rate_snapshot)
         VALUES (?, '2026-08-02 08:00:00', '2026-08-02 16:00:00', 100, 'closed', NULL)`,
        [cashier.id]
      );
      await request(ctx.app)
        .patch(`/api/v1/payroll/cashiers/${cashier.id}`)
        .set(authHeader(adminToken))
        .send({ hourly_rate: 40 });

      const independentHours = shiftHours("2026-08-01 08:00:00", "2026-08-01 16:00:00");
      expect(independentHours).toBe(8);
      const capturedPay = shiftPay(20, 8);
      const livePay = shiftPay(40, 8);

      const captured = unwrap(
        await request(ctx.app)
          .get("/api/v1/payroll/report")
          .query({ date_from: "2026-08-01", date_to: "2026-08-01", cashier_id: cashier.id })
          .set(authHeader(adminToken))
      );
      const capturedEmp = (captured.employees || []).find(
        (e) => Number(e.cashier_id || e.id) === Number(cashier.id)
      );
      expect(Number(capturedEmp?.total_hours)).toBe(independentHours);
      expect(Number(capturedEmp?.total_pay)).toBe(capturedPay);
      expect(Number(capturedEmp?.total_pay)).not.toBe(livePay);

      const missing = unwrap(
        await request(ctx.app)
          .get("/api/v1/payroll/report")
          .query({ date_from: "2026-08-02", date_to: "2026-08-02", cashier_id: cashier.id })
          .set(authHeader(adminToken))
      );
      const missingEmp = (missing.employees || []).find(
        (e) => Number(e.cashier_id || e.id) === Number(cashier.id)
      );
      // The 20 rate was never stored on this shift, so it is not evidence.
      expect(Number(missingEmp?.total_hours)).toBe(independentHours);
      expect(missingEmp?.total_pay ?? null).toBeNull();
      expect(missingEmp?.missing_rate).toBe(true);
      expect(missing.pay_incomplete).toBe(true);
      expect(missing.grand_total_pay ?? null).toBeNull();
    });
  });

  describe("follow-up operational gaps", () => {
    let ctx;
    let adminToken;
    let cashierToken;

    beforeAll(async () => {
      ctx = await createTestContext();
      adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
      cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
      const shiftRes = await request(ctx.app)
        .post("/api/v1/shifts/start")
        .set(authHeader(cashierToken))
        .send({ opening_cash: 100 });
      expect(shiftRes.status).toBe(201);
    });

    afterAll(async () => {
      await destroyTestContext(ctx);
    });

    test("receipt omits the discount even when the sale total is net of it", async () => {
      await ctx.db.run(
        `INSERT INTO promotions (name, offer_type, product_id, discount_value, limit_qty, used_qty, active)
         VALUES ('إيصال خصم', 'percentage', ?, 10, 0, 0, 1)`,
        [ctx.productId]
      );
      invalidatePromotionsCache();
      const unit = await ctx.db.get(
        "SELECT id FROM product_units WHERE product_id = ? AND is_default = 1",
        [ctx.productId]
      );
      const res = await request(ctx.app)
        .post("/api/v1/checkout")
        .set(authHeader(cashierToken))
        .send(
          withCheckoutKey({
            items: [{ product_id: ctx.productId, quantity: 1, price: 10, unit_id: unit.id }],
            payment_method: "cash",
          })
        );
      expect(res.status).toBe(201);
      const body = unwrap(res);
      const independentDiscount = round2(10 * 0.1);
      expect(Number(body.discount)).toBe(independentDiscount);
      expect(Number(body.total)).toBe(round2(10 - independentDiscount));
      const html = String(body.receipt_html || "");
      const text = String(body.receipt_text || "");
      const printed = `${html}\n${text}`;
      expect(printed).toContain("10.00");
      expect(printed).toContain("9.00");
      expect(printed).toMatch(/خصم/);
      const reprint = await request(ctx.app)
        .get(`/api/v1/shifts/transactions/${body.transaction_id}/receipt`)
        .set(authHeader(adminToken));
      expect(reprint.status).toBe(200);
      const again = `${unwrap(reprint).receipt_html || ""}\n${unwrap(reprint).receipt_text || ""}`;
      expect(again).toContain("10.00");
      expect(again).toContain("9.00");
      expect(again).toMatch(/خصم/);
      await ctx.db.run("UPDATE promotions SET active = 0 WHERE product_id = ?", [ctx.productId]);
      invalidatePromotionsCache();
    });

    test("buildReceiptPayload ignores discount even when the caller supplies it", () => {
      const payload = buildReceiptPayload({
        transactionId: 1,
        receiptNumber: "R-1",
        timestamp: "2026-08-01 10:00:00",
        cashierName: "test",
        lines: [{ name: "صنف", sku: "1", quantity: 1, price: 10, lineTotal: 10 }],
        subtotal: 10,
        tax: 0,
        discount: 2,
        total: 8,
        paymentMethod: "cash",
      });
      const printed = `${payload.receipt_html}\n${payload.receipt_text}`;
      expect(printed).toContain("8.00");
      expect(printed).toMatch(/خصم/);
    });

    test("ذمة request is accepted over credit_limit; only approval enforces the cap", async () => {
      const cust = await ctx.db.run(
        `INSERT INTO customers (name, customer_code, balance, opening_balance, credit_limit)
         VALUES ('حد ائتمان', 'CL-1', 0, 0, 5)`
      );
      const unit = await ctx.db.get(
        "SELECT id FROM product_units WHERE product_id = ? AND is_default = 1",
        [ctx.productId]
      );
      const stockBefore = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
      const reqSale = await request(ctx.app)
        .post("/api/v1/checkout")
        .set(authHeader(cashierToken))
        .send(
          withCheckoutKey({
            items: [{ product_id: ctx.productId, quantity: 1, price: 10, unit_id: unit.id }],
            payment_method: "on_account",
            customer_id: cust.lastID,
          })
        );
      expect(reqSale.status).toBe(202);
      const requestId = unwrap(reqSale).request_id || unwrap(reqSale).id;
      const stockAfter = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
      expect(Number(stockAfter.stock)).toBe(Number(stockBefore.stock));
      const balance = await ctx.db.get("SELECT balance, credit_limit FROM customers WHERE id = ?", [cust.lastID]);
      expect(Number(balance.balance)).toBe(0);
      const refused = await request(ctx.app)
        .put(`/api/v1/on-account-requests/${requestId}`)
        .set(authHeader(adminToken))
        .send({ status: "approved" });
      expect(refused.status).toBe(400);
      expect(refused.body?.code || unwrap(refused)?.code).toBe("CREDIT_LIMIT_EXCEEDED");
      const still = await ctx.db.get("SELECT status, on_account_amount FROM on_account_requests WHERE id = ?", [requestId]);
      expect(still.status).toBe("pending");
      const charged = Number(still.on_account_amount);
      expect(charged).toBeGreaterThan(5);
      const granted = await request(ctx.app)
        .put(`/api/v1/on-account-requests/${requestId}`)
        .set(authHeader(adminToken))
        .send({ status: "approved", override_credit_limit: true });
      expect(granted.status).toBe(200);
      const after = await ctx.db.get("SELECT balance, credit_limit FROM customers WHERE id = ?", [cust.lastID]);
      expect(Number(after.balance)).toBe(charged);
      expect(Number(after.credit_limit)).toBe(5);
      const again = await request(ctx.app)
        .put(`/api/v1/on-account-requests/${requestId}`)
        .set(authHeader(adminToken))
        .send({ status: "approved", override_credit_limit: true });
      expect(again.status).toBe(400);
      const stockPosted = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
      expect(Number(stockPosted.stock)).toBe(Number(stockBefore.stock) - 1);
    });

    test("supplier ledger double-counts a voucher payment plus a legacy supplier_payments row", async () => {
      const today = shopTodayYmd();
      const created = await request(ctx.app)
        .post("/api/v1/suppliers")
        .set(authHeader(adminToken))
        .send({ name: "مورد دفتر مزدوج", opening_balance: 100 });
      expect([200, 201]).toContain(created.status);
      const supplier = unwrap(created);
      const draft = await request(ctx.app)
        .post("/api/v1/vouchers")
        .set(authHeader(adminToken))
        .send({
          voucher_type: "payment",
          voucher_date: today,
          lines: [{ line_type: "cash", amount: 20, currency: "NIS", supplier_id: supplier.id }],
        });
      expect(draft.status).toBe(201);
      const posted = await request(ctx.app)
        .post(`/api/v1/vouchers/${unwrap(draft).id}/post`)
        .set(authHeader(adminToken));
      expect(posted.status).toBe(200);
      const liveAfterVoucher = await ctx.db.get("SELECT * FROM suppliers WHERE id = ?", [supplier.id]);
      expect(Number(liveAfterVoucher.balance)).toBe(80);

      const legacy = await request(ctx.app)
        .post("/api/v1/finance/payments")
        .set(authHeader(adminToken))
        .send({
          supplier_id: supplier.id,
          amount: 20,
          paid_on: today,
          payment_method: "cash",
        });
      expect([200, 201]).toContain(legacy.status);
      const liveAfterLegacy = await ctx.db.get("SELECT * FROM suppliers WHERE id = ?", [supplier.id]);
      const ledger = await buildSupplierLedger(ctx.db, liveAfterLegacy);
      // Two unlinked posts are two payments: 100 - 20 - 20. Same amount and date do not merge them.
      const independentClosing = 60;
      expect(Number(liveAfterLegacy.balance)).toBe(independentClosing);
      expect(Number(ledger.closing_balance)).toBe(independentClosing);
      const paymentEvents = (ledger.events || []).filter((row) => row.ev_type === "payment");
      expect(paymentEvents).toHaveLength(2);

      await ctx.db.run(
        `INSERT INTO supplier_payments (supplier_id, amount, paid_on, payment_method)
         VALUES (?, 7, ?, 'cash')`,
        [supplier.id, today]
      );
      const afterHistory = await ctx.db.get("SELECT * FROM suppliers WHERE id = ?", [supplier.id]);
      const withLegacy = await buildSupplierLedger(ctx.db, afterHistory);
      expect(Number(afterHistory.balance)).toBe(independentClosing);
      expect(Number(withLegacy.closing_balance)).toBe(53);
      expect(withLegacy.legacy_payments.count).toBe(1);
      expect(withLegacy.legacy_payments.note).toBeTruthy();
    });

    test("warehouse valuation grand_total stays unchanged after an internal transfer", async () => {
      const warehouses = unwrap(
        await request(ctx.app).get("/api/v1/warehouses").set(authHeader(adminToken))
      );
      const main = warehouses.find((w) => w.type === "main");
      const store = warehouses.find((w) => w.type === "store");
      expect(main && store).toBeTruthy();
      const product = await ctx.db.get("SELECT stock, cost FROM products WHERE id = ?", [ctx.productId]);
      const before = await getWarehouseValuation(ctx.db);
      const draft = await request(ctx.app)
        .post("/api/v1/warehouses/transfers")
        .set(authHeader(adminToken))
        .send({
          from_warehouse_id: main.id,
          to_warehouse_id: store.id,
          items: [{ product_id: ctx.productId, quantity: 10 }],
        });
      expect(draft.status).toBe(201);
      const posted = await request(ctx.app)
        .post(`/api/v1/warehouses/transfers/${unwrap(draft).id}/post`)
        .set(authHeader(adminToken));
      expect(posted.status).toBe(200);
      const afterProduct = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
      expect(Number(afterProduct.stock)).toBe(Number(product.stock));
      const ledgerMoves = await ctx.db.get(
        `SELECT COUNT(*) AS c FROM inventory_ledger
          WHERE product_id = ? AND movement_type IN ('warehouse_transfer_in', 'warehouse_transfer_out')`,
        [ctx.productId]
      );
      expect(Number(ledgerMoves.c)).toBe(0);
      const after = await getWarehouseValuation(ctx.db);
      const independentGrand = round2(Number(before.grand_total));
      expect(round2(Number(after.grand_total))).toBe(independentGrand);
    });

    test("manual batch assigns expiry to unassigned stock and does not receive goods", async () => {
      const before = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
      const ledgerBefore = await ctx.db.get(
        "SELECT COUNT(*) AS c FROM inventory_ledger WHERE product_id = ?",
        [ctx.productId]
      );
      const datedBefore = await ctx.db.get(
        `SELECT COALESCE(SUM(quantity), 0) AS q FROM product_batches
          WHERE product_id = ? AND expiry_date IS NOT NULL AND TRIM(expiry_date) != ''`,
        [ctx.productId]
      );
      const unknown = round2(Number(before.stock) - Number(datedBefore.q));
      expect(unknown).toBeGreaterThan(0);
      const res = await request(ctx.app)
        .post("/api/v1/inventory/batches")
        .set(authHeader(adminToken))
        .send({
          product_id: ctx.productId,
          batch_no: "AUDIT-LOT",
          expiry_date: "2026-12-01",
          quantity: 1,
          cost: 5,
        });
      expect(res.status).toBe(201);
      const after = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
      const ledgerAfter = await ctx.db.get(
        "SELECT COUNT(*) AS c FROM inventory_ledger WHERE product_id = ?",
        [ctx.productId]
      );
      const datedAfter = await ctx.db.get(
        `SELECT COALESCE(SUM(quantity), 0) AS q FROM product_batches
          WHERE product_id = ? AND expiry_date IS NOT NULL AND TRIM(expiry_date) != ''`,
        [ctx.productId]
      );
      expect(Number(after.stock)).toBe(Number(before.stock));
      expect(Number(ledgerAfter.c)).toBe(Number(ledgerBefore.c));
      expect(round2(Number(datedAfter.q))).toBe(round2(Number(datedBefore.q) + 1));

      const over = await request(ctx.app)
        .post("/api/v1/inventory/batches")
        .set(authHeader(adminToken))
        .send({
          product_id: ctx.productId,
          batch_no: "AUDIT-OVER",
          expiry_date: "2027-01-01",
          quantity: unknown + 5,
          cost: 5,
        });
      expect(over.status).toBe(400);
      expect(over.body?.code || unwrap(over)?.code).toBe("BATCH_EXCEEDS_UNASSIGNED");
      const stockStill = await ctx.db.get("SELECT stock FROM products WHERE id = ?", [ctx.productId]);
      expect(Number(stockStill.stock)).toBe(Number(before.stock));
    });

    test("business day cutoff assigns the previous local date before the hour", async () => {
      await updateAppSettings(ctx.db, { business_day_cutoff_hour: 6 });
      const ts = "2026-08-01 01:00:00";
      const calendarYmd = shopYmdFromTimestamp(ts);
      const hourFmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Hebron",
        hour: "2-digit",
        hourCycle: "h23",
      });
      const localHour = Number(hourFmt.format(new Date("2026-08-01T01:00:00Z")));
      expect(localHour).toBeLessThan(6);
      const [y, m, d] = calendarYmd.split("-").map(Number);
      const prev = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
      expect(businessDayFromTimestamp(ts, 6)).toBe(prev);
      expect(shopBusinessDayYmd({ business_day: prev, start_time: ts })).toBe(prev);
      // No stored day: historical rows keep the calendar date and ignore today's cutoff.
      expect(shopBusinessDayYmd({ created_at: ts })).toBe(calendarYmd);
    });

    test("finance overview AR includes employee ذمم that /customers/balances excludes", async () => {
      const empRes = await request(ctx.app)
        .post("/api/v1/employees")
        .set(authHeader(adminToken))
        .send({ name: "موظف ذمة نظرة", start_on: "2026-01-01" });
      expect(empRes.status).toBe(201);
      const emp = unwrap(empRes);
      const account = await request(ctx.app)
        .post(`/api/v1/employees/${emp.id}/debt-account`)
        .set(authHeader(adminToken))
        .send({});
      expect([200, 201]).toContain(account.status);
      const linked = unwrap(account);
      await ctx.db.run("UPDATE customers SET balance = 40 WHERE id = ?", [linked.customer_id]);
      const overview = unwrap(
        await request(ctx.app)
          .get("/api/v1/finance/overview")
          .query({ from: shopTodayYmd(), to: shopTodayYmd() })
          .set(authHeader(adminToken))
      );
      const balances = unwrap(
        await request(ctx.app).get("/api/v1/customers/balances").set(authHeader(adminToken))
      );
      const listRows = Array.isArray(balances.customers) ? balances.customers : [];
      const listed = listRows.some((r) => Number(r.id) === Number(linked.customer_id));
      expect(listed).toBe(false);
      // /customers/balances is ordinary customers. Finance receivables add employee debt once.
      const ordinary = round2(Number(balances.total_due));
      const combined = round2(Number(overview.currentPosition.customerReceivables));
      expect(combined).toBe(round2(ordinary + 40));
    });
  });
});
