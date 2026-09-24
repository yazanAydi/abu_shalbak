import request from "supertest";
import bcrypt from "bcrypt";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
  withCheckoutKey,
  createAccountantUser,
} from "./helpers.js";
import { allAccountantPermissionsDisabled } from "../utils/accountantPermissions.js";
import {
  computeShiftVisa,
  saleAllocationIncomplete,
  saleCashAllocationIncomplete,
  refundAllocationIncomplete,
  VISA_RECORDED_NOTE,
  SHIFT_VISA_LABELS,
} from "../utils/salePayments.js";
import { roundScaleSaleTotal, round2 } from "../utils/money.js";

function unwrap(res) {
  return res.body?.data !== undefined ? res.body.data : res.body;
}

function expectRecordedVisa(visa, sales, refunds, net, incomplete = false) {
  expect(visa.visa_sales).toBe(sales);
  expect(visa.visa_refunds).toBe(refunds);
  expect(visa.visa_net).toBe(net);
  expect(visa.visa_incomplete).toBe(incomplete);
  expect(visa.visa_note).toBe(VISA_RECORDED_NOTE);
  expect(visa.visa_labels).toEqual(SHIFT_VISA_LABELS);
  expect(visa.visa_note).toContain("ليست تسوية بنكية");
  expect(visa.visa_note).toContain("ولا مطابقة لجهاز البطاقة");
}

function csvVisa(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r\n/);
  const headers = lines[0].split(",");
  const values = lines[1].split(",");
  const at = (name) => Number(values[headers.indexOf(name)]);
  const labeled = (label) => {
    const line = lines.find((row) => row.startsWith(label));
    expect(line).toBeTruthy();
    return Number(line.slice(label.length + 1));
  };
  return {
    visa_sales: at("visa_sales"),
    visa_refunds: at("visa_refunds"),
    visa_net: at("visa_net"),
    visa_incomplete: at("visa_incomplete"),
    labeledSales: labeled(SHIFT_VISA_LABELS.sales),
    labeledRefunds: labeled(SHIFT_VISA_LABELS.refunds),
    labeledNet: labeled(SHIFT_VISA_LABELS.net),
    text,
  };
}

describe("sale and refund allocation completeness", () => {
  test("does not treat a missing or single-line mixed allocation as visa", () => {
    expect(
      saleAllocationIncomplete({
        payment_method: "visa",
        pay_count: 0,
        visa_count: 0,
        visa_paid: 0,
        total: 100,
      })
    ).toBe(true);
    expect(
      saleAllocationIncomplete({
        payment_method: "mixed",
        pay_count: 1,
        visa_count: 0,
        visa_paid: 0,
        total: 80,
      })
    ).toBe(true);
    expect(
      saleAllocationIncomplete({
        payment_method: "mixed",
        pay_count: 2,
        visa_count: 1,
        visa_paid: 30,
        total: 80,
      })
    ).toBe(false);
    expect(
      saleAllocationIncomplete({
        payment_method: "visa",
        pay_count: 1,
        visa_count: 1,
        visa_paid: 100,
        total: 100,
      })
    ).toBe(false);
    expect(
      saleAllocationIncomplete({
        payment_method: "cash",
        pay_count: 1,
        visa_count: 0,
        visa_paid: 0,
        total: 10,
      })
    ).toBe(false);
  });

  test("does not invent a missing cash split", () => {
    expect(
      saleCashAllocationIncomplete({
        payment_method: "cash",
        pay_count: 0,
        cash_count: 0,
        cash_paid: 0,
        total: 100,
      })
    ).toBe(true);
    expect(
      saleCashAllocationIncomplete({
        payment_method: "mixed",
        pay_count: 1,
        cash_count: 1,
        cash_paid: 80,
        total: 80,
      })
    ).toBe(true);
    expect(
      saleCashAllocationIncomplete({
        payment_method: "mixed",
        pay_count: 2,
        cash_count: 1,
        cash_paid: 100,
        total: 150,
      })
    ).toBe(false);
    expect(
      saleCashAllocationIncomplete({
        payment_method: "visa",
        pay_count: 1,
        cash_count: 0,
        cash_paid: 0,
        total: 40,
      })
    ).toBe(false);
  });

  test("ignores pending refunds and unknown approved methods", () => {
    expect(refundAllocationIncomplete({ status: "pending", payment_method: "visa" })).toBe(false);
    expect(refundAllocationIncomplete({ status: "rejected", payment_method: "visa" })).toBe(false);
    expect(refundAllocationIncomplete({ status: "approved", payment_method: "visa" })).toBe(false);
    expect(refundAllocationIncomplete({ status: "approved", payment_method: "cash" })).toBe(false);
    expect(refundAllocationIncomplete({ status: "approved", payment_method: null })).toBe(true);
    expect(refundAllocationIncomplete({ status: "approved", payment_method: "mixed" })).toBe(true);
  });
});

describe("recorded visa per cashier shift", () => {
  let ctx;
  let cashierToken;
  let adminToken;
  let product;
  let shiftA;
  let visaSaleId;
  let mixedSaleId;

  beforeAll(async () => {
    process.env.TELEGRAM_BOT_TOKEN = "";
    process.env.TELEGRAM_CHAT_ID = "";
    ctx = await createTestContext();
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123", "office");
    cashierToken = cashierLogin.body.token;
    adminToken = adminLogin.body.token;
    product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function startShift(token, opening) {
    const res = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(token)).send({});
    expect(res.status).toBe(201);
    const id = unwrap(res).shift_id;
    await ctx.db.run("UPDATE cashier_shifts SET opening_cash = ? WHERE id = ?", [opening, id]);
    await ctx.db.run(
      "UPDATE shift_cash_movements SET amount = ? WHERE shift_id = ? AND movement_type = 'opening'",
      [opening, id]
    );
    return id;
  }

  async function sell(body, key) {
    const res = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(withCheckoutKey(body, key));
    return res;
  }

  async function approveRefund(transactionId, qty, paymentMethod) {
    const created = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: transactionId,
        lines: [{ product_id: ctx.productId, quantity: qty }],
        payment_method: paymentMethod,
        reason: "visa shift test",
      });
    expect(created.status).toBe(201);
    const requestId = unwrap(created).request_id;
    const approved = await request(ctx.app)
      .put(`/api/v1/refund-requests/${requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);
    return { requestId, approved: unwrap(approved) };
  }

  test("visa-only, mixed portion, cash, partial refund, replay, and later shift", async () => {
    shiftA = await startShift(cashierToken, 200);

    const visaKey = "visa-only-100";
    const visaBody = {
      items: [{ product_id: ctx.productId, quantity: 10, price: product.price }],
      payment_method: "visa",
    };
    const visaSale = await sell(visaBody, visaKey);
    expect(visaSale.status).toBe(201);
    visaSaleId = unwrap(visaSale).transaction_id;
    const replay = await sell(visaBody, visaKey);
    expect(replay.status).toBe(200);
    expect(unwrap(replay).idempotent_replay).toBe(true);
    expect(unwrap(replay).transaction_id).toBe(visaSaleId);
    const visaPayCount = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM sale_payments WHERE transaction_id = ? AND payment_method = 'visa'",
      [visaSaleId]
    );
    expect(Number(visaPayCount.n)).toBe(1);

    const mixed = await sell({
      items: [{ product_id: ctx.productId, quantity: 8, price: product.price }],
      payment_method: "mixed",
      payments: [
        { method: "cash", amount: 50 },
        { method: "visa", amount: 30 },
      ],
    });
    expect(mixed.status).toBe(201);
    mixedSaleId = unwrap(mixed).transaction_id;
    expect(unwrap(mixed).payment_method).toBe("mixed");
    const mixedPays = await ctx.db.all(
      "SELECT payment_method, amount FROM sale_payments WHERE transaction_id = ? ORDER BY payment_method",
      [mixedSaleId]
    );
    expect(mixedPays.map((p) => p.payment_method)).toEqual(["cash", "visa"]);
    expect(Number(mixedPays.find((p) => p.payment_method === "visa").amount)).toBe(30);

    const cashOnly = await sell({
      items: [{ product_id: ctx.productId, quantity: 1, price: product.price }],
      payment_method: "cash",
    });
    expect(cashOnly.status).toBe(201);

    const partial = await approveRefund(visaSaleId, 2, "visa");
    const replayApprove = await request(ctx.app)
      .put(`/api/v1/refund-requests/${partial.requestId}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(replayApprove.status).toBe(400);
    const approvedVisaRefunds = await ctx.db.get(
      "SELECT COUNT(*) AS n FROM refunds WHERE original_transaction_id = ? AND status = 'approved' AND payment_method = 'visa'",
      [visaSaleId]
    );
    expect(Number(approvedVisaRefunds.n)).toBe(1);

    const pending = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: visaSaleId,
        lines: [{ product_id: ctx.productId, quantity: 1 }],
        payment_method: "visa",
        reason: "still pending",
      });
    expect(pending.status).toBe(201);
    const pendingId = unwrap(pending).request_id;
    let whilePending = await computeShiftVisa(ctx.db, shiftA);
    expectRecordedVisa(whilePending, 130, 20, 110);

    const rejected = await request(ctx.app)
      .put(`/api/v1/refund-requests/${pendingId}`)
      .set(authHeader(adminToken))
      .send({ status: "rejected" });
    expect(rejected.status).toBe(200);

    const detailRes = await request(ctx.app)
      .get(`/api/v1/shifts/${shiftA}`)
      .set(authHeader(adminToken));
    expect(detailRes.status).toBe(200);
    const detail = unwrap(detailRes);
    expectRecordedVisa(detail.summary.visa, 130, 20, 110);
    expectRecordedVisa(detail.shift, 130, 20, 110);
    expect(detail.summary.expected).toBe(260);
    expect(detail.shift.expected_cash).toBe(260);

    const listRes = await request(ctx.app).get("/api/v1/shifts").set(authHeader(adminToken));
    expect(listRes.status).toBe(200);
    const listed = unwrap(listRes).find((row) => row.id === shiftA);
    expectRecordedVisa(listed, 130, 20, 110);

    const csvRes = await request(ctx.app)
      .get(`/api/v1/shifts/${shiftA}/export.csv`)
      .set(authHeader(adminToken));
    expect(csvRes.status).toBe(200);
    const exported = csvVisa(csvRes.text);
    expect(exported.visa_sales).toBe(130);
    expect(exported.visa_refunds).toBe(20);
    expect(exported.visa_net).toBe(110);
    expect(exported.visa_incomplete).toBe(0);
    expect(exported.labeledSales).toBe(130);
    expect(exported.labeledRefunds).toBe(20);
    expect(exported.labeledNet).toBe(110);
    expect(exported.text).toContain(VISA_RECORDED_NOTE);
    const partialRefund = await ctx.db.get(
      "SELECT id, original_transaction_id FROM refunds WHERE original_transaction_id = ? AND payment_method = 'visa'",
      [visaSaleId]
    );
    expect(exported.text).toContain(String(partialRefund.original_transaction_id));

    const endRes = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftA}/end`)
      .set(authHeader(cashierToken))
      .send({});
    expect(endRes.status).toBe(200);
    expectRecordedVisa(unwrap(endRes), 130, 20, 110);
    expect(unwrap(endRes).expected_cash).toBe(260);
    expect(unwrap(endRes).card_total).toBe(130);

    const pendingShifts = unwrap(
      await request(ctx.app).get("/api/v1/shifts/pending").set(authHeader(adminToken))
    );
    expectRecordedVisa(
      pendingShifts.find((row) => row.id === shiftA),
      130,
      20,
      110
    );

    const shiftB = await startShift(cashierToken, 100);
    const cross = await approveRefund(visaSaleId, 1, "visa");
    expect(cross.approved).toBeTruthy();

    const fullSale = await sell({
      items: [{ product_id: ctx.productId, quantity: 4, price: product.price }],
      payment_method: "visa",
    });
    expect(fullSale.status).toBe(201);
    const fullSaleId = unwrap(fullSale).transaction_id;
    await approveRefund(fullSaleId, 4, "visa");

    const mixedRefund = await approveRefund(mixedSaleId, 1, "visa");
    expect(mixedRefund.approved).toBeTruthy();

    const afterA = unwrap(
      await request(ctx.app).get(`/api/v1/shifts/${shiftA}`).set(authHeader(adminToken))
    );
    expectRecordedVisa(afterA.summary.visa, 130, 20, 110);
    expect(afterA.summary.expected).toBe(260);

    const afterB = unwrap(
      await request(ctx.app).get(`/api/v1/shifts/${shiftB}`).set(authHeader(cashierToken))
    );
    expectRecordedVisa(afterB.summary.visa, 40, 60, -20);
    const crossRow = afterB.refunds.find((row) => row.original_transaction_id === visaSaleId);
    expect(crossRow).toBeTruthy();
    expect(crossRow.payment_method).toBe("visa");
    expect(Number(crossRow.total)).toBe(10);
    expect(Number(crossRow.original_shift_id)).toBe(shiftA);
    expect(Number(crossRow.shift_id)).toBe(shiftB);
    const mixedRow = afterB.refunds.find((row) => row.original_transaction_id === mixedSaleId);
    expect(Number(mixedRow.total)).toBe(10);
    expect(mixedRow.payment_method).toBe("visa");

    const csvAfter = csvVisa(
      (
        await request(ctx.app)
          .get(`/api/v1/shifts/${shiftA}/export.csv`)
          .set(authHeader(adminToken))
      ).text
    );
    expect(csvAfter.visa_sales).toBe(detail.summary.visa.visa_sales);
    expect(csvAfter.visa_refunds).toBe(detail.summary.visa.visa_refunds);
    expect(csvAfter.visa_net).toBe(detail.summary.visa.visa_net);

    const reconciled = await request(ctx.app)
      .post(`/api/v1/shifts/${shiftA}/reconcile`)
      .set(authHeader(adminToken))
      .send({ closing_cash: 260 });
    expect([200, 202]).toContain(reconciled.status);
    expectRecordedVisa(unwrap(reconciled), 130, 20, 110);
    expect(unwrap(reconciled).expected_cash).toBe(260);
  });
});

describe("visa stays with the cashier who posted it", () => {
  let ctx;
  let adminToken;
  let cashierAToken;
  let cashierBToken;
  let shiftA;
  let shiftB;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierAToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    const hash = await bcrypt.hash("cashpass123", 4);
    await ctx.db.run(
      "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'cashier', 0)",
      ["cashierb", hash]
    );
    cashierBToken = (await login(ctx.app, "cashierb", "cashpass123", "pos")).body.token;
    const product = await ctx.db.get("SELECT * FROM products WHERE id = ?", [ctx.productId]);

    const startA = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierAToken));
    shiftA = unwrap(startA).shift_id;
    const startB = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierBToken));
    shiftB = unwrap(startB).shift_id;

    const saleA = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierAToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 10, price: product.price }],
          payment_method: "visa",
        })
      );
    expect(saleA.status).toBe(201);
    const saleB = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierBToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 4, price: product.price }],
          payment_method: "visa",
        })
      );
    expect(saleB.status).toBe(201);

    const admin = await ctx.db.get("SELECT id FROM users WHERE username = 'testadmin'");
    const office = await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, payment_method, shift_id, status, store_id)
       VALUES (?, '[]', 70, 0, 70, 'visa', NULL, 'completed', 1)`,
      [admin.id]
    );
    await ctx.db.run(
      `INSERT INTO sale_payments (transaction_id, payment_method, amount, original_amount, exchange_rate_used, nis_equivalent)
       VALUES (?, 'visa', 70, 70, 1, 70)`,
      [office.lastID]
    );
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("each shift keeps its own visa and office sales stay out", async () => {
    const list = unwrap(await request(ctx.app).get("/api/v1/shifts").set(authHeader(adminToken)));
    expectRecordedVisa(
      list.find((row) => row.id === shiftA),
      100,
      0,
      100
    );
    expectRecordedVisa(
      list.find((row) => row.id === shiftB),
      40,
      0,
      40
    );

    const other = await request(ctx.app)
      .get(`/api/v1/shifts/${shiftB}`)
      .set(authHeader(cashierAToken));
    expect(other.status).toBe(403);
    const own = unwrap(
      await request(ctx.app).get(`/api/v1/shifts/${shiftA}`).set(authHeader(cashierAToken))
    );
    expectRecordedVisa(own.summary.visa, 100, 0, 100);

    const deniedPerms = allAccountantPermissionsDisabled();
    const allowedPerms = { ...deniedPerms, shift_audit: true };
    const deniedUser = await createAccountantUser(ctx.db, {
      username: "novisa",
      permissions: deniedPerms,
    });
    const allowedUser = await createAccountantUser(ctx.db, {
      username: "yesvisa",
      permissions: allowedPerms,
    });
    const deniedToken = (await login(ctx.app, deniedUser.username, deniedUser.password, "office")).body
      .token;
    const allowedToken = (await login(ctx.app, allowedUser.username, allowedUser.password, "office"))
      .body.token;
    expect((await request(ctx.app).get("/api/v1/shifts").set(authHeader(deniedToken))).status).toBe(403);
    expect(
      (await request(ctx.app).get(`/api/v1/shifts/${shiftA}`).set(authHeader(deniedToken))).status
    ).toBe(403);
    const allowed = unwrap(
      await request(ctx.app).get(`/api/v1/shifts/${shiftB}`).set(authHeader(allowedToken))
    );
    expectRecordedVisa(allowed.summary.visa, 40, 0, 40);
  });
});

describe("rounded visa allocations", () => {
  let ctx;
  let adminToken;
  let cashierToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken));
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("uses persisted allocations after payable rounding, not the pre-round total", async () => {
    await ctx.db.run("UPDATE products SET price = 10.3 WHERE id = ?", [ctx.productId]);
    await ctx.db.run("UPDATE product_units SET price = 10.3 WHERE product_id = ?", [ctx.productId]);

    const visaOnly = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 1, price: 10.3 }],
          payment_method: "visa",
        })
      );
    expect(visaOnly.status).toBe(201);
    const visaBody = unwrap(visaOnly);
    expect(visaBody.total).toBe(10);
    expect(visaBody.rounding_adjustment).toBe(-0.3);
    const visaLine = await ctx.db.get(
      "SELECT amount FROM sale_payments WHERE transaction_id = ? AND payment_method = 'visa'",
      [visaBody.transaction_id]
    );
    expect(Number(visaLine.amount)).toBe(10);

    const mixed = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 1, price: 10.3 }],
          payments: [
            { method: "cash", amount: 4 },
            { method: "visa", amount: 6 },
          ],
        })
      );
    expect(mixed.status).toBe(201);
    const mixedBody = unwrap(mixed);
    expect(mixedBody.total).toBe(10);
    const mixedVisa = await ctx.db.get(
      "SELECT amount FROM sale_payments WHERE transaction_id = ? AND payment_method = 'visa'",
      [mixedBody.transaction_id]
    );
    expect(Number(mixedVisa.amount)).toBe(6);

    const shiftId = (
      await ctx.db.get("SELECT shift_id FROM transactions WHERE id = ?", [visaBody.transaction_id])
    ).shift_id;
    const beforeRefund = await computeShiftVisa(ctx.db, shiftId);
    expect(beforeRefund.visa_sales).toBe(16);
    expect(beforeRefund.visa_sales).not.toBe(round2(10.3 + 10.3));
    expect(beforeRefund.visa_sales).not.toBe(20);

    const created = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: visaBody.transaction_id,
        payment_method: "visa",
        lines: [{ product_id: ctx.productId, quantity: 1 }],
        reason: "rounded visa refund",
      });
    expect(created.status).toBe(201);
    expect(Number(unwrap(created).request.total_amount)).toBe(10);
    const adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    const approved = await request(ctx.app)
      .put(`/api/v1/refund-requests/${unwrap(created).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);
    const afterRefund = await computeShiftVisa(ctx.db, shiftId);
    expectRecordedVisa(afterRefund, 16, 10, 6);
  });

  test("uses the persisted rounded visa line, not the raw weight or the whole invoice", async () => {
    const created = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode: "6250001111111",
        name: "جبنة فيزا",
        sku: "visa-kg-1",
        price: 20,
        cost: 5,
        stock: 20,
        is_weighed: true,
      });
    expect(created.status).toBe(201);
    const productId = unwrap(created).id;
    const units = unwrap(
      await request(ctx.app).get(`/api/v1/products/${productId}/units`).set(authHeader(adminToken))
    ).units;
    const kg = units.find((unit) => unit.unit_name === "كغم");
    expect(kg).toBeTruthy();

    const raw = round2(0.255 * 20);
    expect(raw).toBe(5.1);
    const charged = roundScaleSaleTotal(raw);
    expect(charged).toBe(5);
    const before = await computeShiftVisa(
      ctx.db,
      (await ctx.db.get("SELECT id FROM cashier_shifts WHERE status = 'open'")).id
    );

    const visaOnly = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: productId, quantity: 0.255, price: 20, unit_id: kg.id }],
          payment_method: "visa",
        })
      );
    expect(visaOnly.status).toBe(201);
    const visaTx = unwrap(visaOnly).transaction_id;
    const visaLine = await ctx.db.get(
      "SELECT amount, nis_equivalent FROM sale_payments WHERE transaction_id = ? AND payment_method = 'visa'",
      [visaTx]
    );
    expect(Number(visaLine.amount)).toBe(5);
    expect(Number(visaLine.nis_equivalent)).toBe(5);

    const mixed = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: productId, quantity: 0.255, price: 20, unit_id: kg.id }],
          payment_method: "mixed",
          payments: [
            { method: "cash", amount: 2 },
            { method: "visa", amount: 3 },
          ],
        })
      );
    expect(mixed.status).toBe(201);
    const shiftId = (
      await ctx.db.get("SELECT shift_id FROM transactions WHERE id = ?", [unwrap(mixed).transaction_id])
    ).shift_id;
    const visa = await computeShiftVisa(ctx.db, shiftId);
    expect(round2(visa.visa_sales - before.visa_sales)).toBe(8);
    expect(round2(visa.visa_refunds - before.visa_refunds)).toBe(0);
    expect(visa.visa_incomplete).toBe(before.visa_incomplete);
  });
});

describe("historical visa records without a reliable split", () => {
  let ctx;
  let shiftId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const cashier = await login(ctx.app, "testcashier", "cashpass123", "pos");
    const started = await request(ctx.app)
      .post("/api/v1/shifts/start")
      .set(authHeader(cashier.body.token));
    shiftId = unwrap(started).shift_id;
    const cashierId = (await ctx.db.get("SELECT id FROM users WHERE username = 'testcashier'")).id;

    const mixed = await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, payment_method, shift_id, status, store_id)
       VALUES (?, '[]', 80, 0, 80, 'mixed', ?, 'completed', 1)`,
      [cashierId, shiftId]
    );
    await ctx.db.run(
      `INSERT INTO sale_payments (transaction_id, payment_method, amount, original_amount, exchange_rate_used, nis_equivalent)
       VALUES (?, 'cash', 80, 80, 1, 80)`,
      [mixed.lastID]
    );

    await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, payment_method, shift_id, status, store_id)
       VALUES (?, '[]', 50, 0, 50, 'visa', ?, 'completed', 1)`,
      [cashierId, shiftId]
    );

    const reliable = await ctx.db.run(
      `INSERT INTO transactions
         (cashier_id, items_json, subtotal, tax, total, payment_method, shift_id, status, store_id)
       VALUES (?, '[]', 25, 0, 25, 'visa', ?, 'completed', 1)`,
      [cashierId, shiftId]
    );
    await ctx.db.run(
      `INSERT INTO sale_payments (transaction_id, payment_method, amount, original_amount, exchange_rate_used, nis_equivalent)
       VALUES (?, 'visa', 25, 25, 1, 25)`,
      [reliable.lastID]
    );
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("counts only the recorded visa line and flags the shift incomplete", async () => {
    const visa = await computeShiftVisa(ctx.db, shiftId);
    expectRecordedVisa(visa, 25, 0, 25, true);
    expect(visa.visa_incomplete_note).toContain("لم يُخمَّن");
  });
});

describe("cash refund of a visa sale is not visa", () => {
  let ctx;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("leaves visa sales intact and reduces expected cash only", async () => {
    const cashierToken = (await login(ctx.app, "testcashier", "cashpass123", "pos")).body.token;
    const adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
    const started = await request(ctx.app).post("/api/v1/shifts/start").set(authHeader(cashierToken));
    const shiftId = unwrap(started).shift_id;
    await ctx.db.run("UPDATE cashier_shifts SET opening_cash = 100 WHERE id = ?", [shiftId]);
    const product = await ctx.db.get("SELECT price FROM products WHERE id = ?", [ctx.productId]);
    const sale = await request(ctx.app)
      .post("/api/v1/checkout")
      .set(authHeader(cashierToken))
      .send(
        withCheckoutKey({
          items: [{ product_id: ctx.productId, quantity: 10, price: product.price }],
          payment_method: "visa",
        })
      );
    expect(sale.status).toBe(201);
    const created = await request(ctx.app)
      .post("/api/v1/refund-requests")
      .set(authHeader(cashierToken))
      .send({
        original_transaction_id: unwrap(sale).transaction_id,
        lines: [{ product_id: ctx.productId, quantity: 1 }],
        payment_method: "cash",
        reason: "cash back",
      });
    expect(created.status).toBe(201);
    const approved = await request(ctx.app)
      .put(`/api/v1/refund-requests/${unwrap(created).request_id}`)
      .set(authHeader(adminToken))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);

    const detail = unwrap(
      await request(ctx.app).get(`/api/v1/shifts/${shiftId}`).set(authHeader(adminToken))
    );
    expectRecordedVisa(detail.summary.visa, 100, 0, 100);
    expect(detail.summary.expected).toBe(90);
  });
});
