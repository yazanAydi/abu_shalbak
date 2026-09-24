import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createApp } from "../../app.js";
import { closeDemo, createEmptyDemoDatabase } from "./database.mjs";
import { assertWritableDemoPath, faultDbPath, reportDir } from "./guards.mjs";
import { call, checkMoney, checkQty, loadExpected, pushResult, snippet, unwrap } from "./lib.mjs";

/**
 * Hand ledger for the disposable fault database.
 * 10 units bought at 100 shekels → cost 10, stock 10.
 * Sell 3 at 15 → 45 charged, stock 7.
 * Refund 1 → stock 8.
 */
const BOOK = {
  buyQty: "10.000",
  buyTotal: "100.00",
  cost: "10.00",
  sellQty: "3",
  sellPrice: "15.00",
  sellTotal: "45.00",
  stockAfterSale: "7.000",
  stockAfterRefund: "8.000",
};

export async function runFaults({ expected, results }) {
  const dbPath = assertWritableDemoPath(faultDbPath);
  const db = await createEmptyDemoDatabase(dbPath, expected);
  const app = createApp(db, dbPath);
  const accounts = expected.accounts;
  try {
    async function login(account, portal) {
      const res = await call(app, {
        method: "post",
        path: "/api/v1/auth/login",
        body: { username: account.username, password: account.password, app: portal },
      });
      return { status: res.status, token: unwrap(res.body)?.token || null, body: res.body };
    }

    const admin = (await login(accounts.admin, "office")).token;
    const cashier1 = (await login(accounts.cashier1, "pos")).token;
    const cashier2 = (await login(accounts.cashier2, "pos")).token;
    if (!admin || !cashier1 || !cashier2) {
      pushResult(results, {
        scenario: "Fault database logins",
        feature: "fault",
        status: "FAIL",
        expected: "three tokens",
        actual: "login failed",
        classification: "test_infrastructure",
      });
      return;
    }

    const supplier = unwrap(
      (
        await call(app, {
          method: "post",
          path: "/api/v1/suppliers",
          token: admin,
          body: { name: "مورد الأعطال التجريبي" },
        })
      ).body
    );
    const product = unwrap(
      (
        await call(app, {
          method: "post",
          path: "/api/v1/products",
          token: admin,
          body: {
            barcode: "6281000000999",
            name: "صنف العطل التجريبي",
            price: 15,
            stock: 0,
            unit: "حبة",
          },
        })
      ).body
    );
    const units = unwrap(
      (await call(app, { method: "get", path: `/api/v1/products/${product.id}/units`, token: admin })).body
    );
    const unitList = Array.isArray(units) ? units : units?.units || [];
    const piece = unitList.find((unit) => unit.unit_name === "حبة") || unitList[0];
    const draft = unwrap(
      (
        await call(app, {
          method: "post",
          path: "/api/v1/purchases/invoices",
          token: admin,
          body: {
            supplier_id: supplier.id,
            invoice_date: "2026-09-15",
            ref_text: "عطل-شراء",
            items: [{ product_id: product.id, quantity: 10, total_cost: 100, vat_rate: 0 }],
          },
        })
      ).body
    );
    await call(app, {
      method: "post",
      path: `/api/v1/purchases/invoices/${draft.id}/post`,
      token: admin,
      body: {},
    });
    const bought = await db.get("SELECT stock, cost FROM products WHERE id = ?", [product.id]);
    checkQty(results, "Fault purchase stock", BOOK.buyQty, bought.stock, { feature: "fault", screen: "قاعدة الأعطال" });
    checkMoney(results, "Fault purchase cost", BOOK.cost, bought.cost, { feature: "fault", screen: "قاعدة الأعطال" });

    await call(app, {
      method: "patch",
      path: "/api/v1/settings",
      token: admin,
      body: { default_opening_cash: 100 },
    });
    const shift = unwrap(
      (await call(app, { method: "post", path: "/api/v1/shifts/start", token: cashier1, body: {} })).body
    );
    const shiftId = shift.shift_id || shift.id;

    const saleBody = {
      idempotency_key: "fault-sale-same-key",
      items: [{ product_id: product.id, quantity: 3, price: 15, unit_id: piece?.id }],
      payment_method: "cash",
    };
    const first = await call(app, { method: "post", path: "/api/v1/checkout", token: cashier1, body: saleBody });
    const replay = await call(app, { method: "post", path: "/api/v1/checkout", token: cashier1, body: saleBody });
    const txCount = await db.get(
      "SELECT COUNT(*) AS n FROM transactions WHERE idempotency_key = ?",
      ["fault-sale-same-key"]
    );
    const stockAfter = (await db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock;
    const replayOk = first.status === 201 && replay.status === 200 && Number(txCount.n) === 1;
    pushResult(results, {
      scenario: "Duplicate checkout replays the saved sale",
      feature: "fault",
      status: replayOk ? "PASS" : "FAIL",
      expected: "first 201, replay 200, one transaction, stock 7.000",
      actual: `first ${first.status}, replay ${replay.status}, rows ${txCount.n}, stock ${stockAfter}`,
      classification: replayOk ? "" : "application",
      screen: "نقطة البيع",
    });
    checkQty(results, "Duplicate checkout leaves stock at 7", BOOK.stockAfterSale, stockAfter, {
      feature: "fault",
      screen: "نقطة البيع",
    });

    const changed = await call(app, {
      method: "post",
      path: "/api/v1/checkout",
      token: cashier1,
      body: { ...saleBody, items: [{ product_id: product.id, quantity: 1, price: 15, unit_id: piece?.id }] },
    });
    const stockChanged = (await db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock;
    const changedOk = changed.status === 409 && Number(stockChanged) === Number(stockAfter);
    pushResult(results, {
      scenario: "Same idempotency key with a different cart is rejected",
      feature: "fault",
      status: changedOk ? "PASS" : "FAIL",
      expected: "409 and stock unchanged",
      actual: `HTTP ${changed.status} ${unwrap(changed.body)?.code || ""} stock ${stockChanged}`,
      classification: changedOk ? "" : "application",
      screen: "نقطة البيع",
    });

    const stolen = await call(app, {
      method: "post",
      path: "/api/v1/checkout",
      token: cashier2,
      body: saleBody,
    });
    const stockStolen = (await db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock;
    const stolenOk = stolen.status === 403 && Number(stockStolen) === Number(stockAfter);
    pushResult(results, {
      scenario: "Another cashier cannot replay the idempotency key",
      feature: "fault",
      status: stolenOk ? "PASS" : "FAIL",
      expected: "403 and stock unchanged",
      actual: `HTTP ${stolen.status} ${unwrap(stolen.body)?.code || ""} stock ${stockStolen}`,
      classification: stolenOk ? "" : "application",
      screen: "نقطة البيع",
    });

    const foreignEnd = await call(app, {
      method: "post",
      path: `/api/v1/shifts/${shiftId}/end`,
      token: cashier2,
      body: {},
    });
    const shiftStill = await db.get("SELECT status FROM cashier_shifts WHERE id = ?", [shiftId]);
    pushResult(results, {
      scenario: "Another cashier cannot close the shift",
      feature: "fault",
      status: foreignEnd.status === 403 && shiftStill.status === "open" ? "PASS" : "FAIL",
      expected: "403 and shift still open",
      actual: `HTTP ${foreignEnd.status}, status ${shiftStill.status}`,
      classification: foreignEnd.status === 403 ? "" : "application",
      screen: "الورديات",
    });

    const badQty = await call(app, {
      method: "post",
      path: "/api/v1/checkout",
      token: cashier1,
      body: {
        idempotency_key: "fault-bad-qty",
        items: [{ product_id: product.id, quantity: 0, price: 15, unit_id: piece?.id }],
        payment_method: "cash",
      },
    });
    const stockBad = (await db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock;
    pushResult(results, {
      scenario: "Zero quantity checkout is rejected",
      feature: "fault",
      status: badQty.status === 400 && Number(stockBad) === Number(stockAfter) ? "PASS" : "FAIL",
      expected: "400 and stock unchanged",
      actual: `HTTP ${badQty.status}, stock ${stockBad}`,
      classification: badQty.status === 400 ? "" : "application",
      screen: "نقطة البيع",
    });

    const originalId = unwrap(first.body).transaction_id || unwrap(first.body).id;
    const tooMuch = await call(app, {
      method: "post",
      path: "/api/v1/refund-requests",
      token: cashier1,
      body: {
        original_transaction_id: originalId,
        lines: [{ product_id: product.id, quantity: 4 }],
        reason: "كمية أكبر من المبيع",
        payment_method: "cash",
      },
    });
    const stockToo = (await db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock;
    pushResult(results, {
      scenario: "Refund larger than the sale is rejected",
      feature: "fault",
      status: tooMuch.status >= 400 && Number(stockToo) === Number(stockAfter) ? "PASS" : "FAIL",
      expected: "4xx and stock 7.000",
      actual: `HTTP ${tooMuch.status}, stock ${stockToo}`,
      classification: tooMuch.status >= 400 ? "" : "application",
      screen: "المرتجعات",
    });

    const partial = unwrap(
      (
        await call(app, {
          method: "post",
          path: "/api/v1/refund-requests",
          token: cashier1,
          body: {
            original_transaction_id: originalId,
            lines: [{ product_id: product.id, quantity: 1 }],
            reason: "إرجاع واحد",
            payment_method: "cash",
          },
        })
      ).body
    );
    const requestId = partial.id || partial.request_id;
    const approved = await call(app, {
      method: "put",
      path: `/api/v1/refund-requests/${requestId}`,
      token: admin,
      body: { status: "approved" },
    });
    const again = await call(app, {
      method: "put",
      path: `/api/v1/refund-requests/${requestId}`,
      token: admin,
      body: { status: "approved" },
    });
    const stockRefund = (await db.get("SELECT stock FROM products WHERE id = ?", [product.id])).stock;
    const refundOnce = approved.status === 200 && again.status >= 400 && Number(stockRefund) === 8;
    pushResult(results, {
      scenario: "Approving the same refund twice does not return stock twice",
      feature: "fault",
      status: refundOnce ? "PASS" : "FAIL",
      expected: "second approval rejected and stock 8.000",
      actual: `first ${approved.status}, second ${again.status}, stock ${stockRefund} ${snippet(again.body)}`,
      classification: refundOnce ? "" : "application",
      screen: "موافقات المرتجعات",
    });
    checkQty(results, "One approved refund restores one unit", BOOK.stockAfterRefund, stockRefund, {
      feature: "fault",
      screen: "المخزون",
    });

    const sessionUser = unwrap(
      (
        await call(app, {
          method: "post",
          path: "/api/v1/admin/users",
          token: admin,
          body: { username: "demo.session", password: "DemoSess#2026", role: "cashier" },
        })
      ).body
    );
    const sessionLogin = await login({ username: "demo.session", password: "DemoSess#2026" }, "pos");
    const logout = await call(app, { method: "post", path: "/api/v1/auth/logout", token: sessionLogin.token, body: {} });
    const afterLogout = await call(app, { method: "get", path: "/api/v1/shifts/current", token: sessionLogin.token });
    pushResult(results, {
      scenario: "Logout revokes the presented session",
      feature: "fault",
      status: sessionUser?.id && logout.status === 200 && afterLogout.status === 401 ? "PASS" : "FAIL",
      expected: "logout 200 then 401",
      actual: `user ${sessionUser?.id || sessionUser?.username}, logout ${logout.status}, next ${afterLogout.status}`,
      classification: afterLogout.status === 401 ? "" : "application",
      screen: "تسجيل الدخول",
    });

    const passUser = unwrap(
      (
        await call(app, {
          method: "post",
          path: "/api/v1/admin/users",
          token: admin,
          body: { username: "demo.password", password: "DemoPass#2026", role: "cashier" },
        })
      ).body
    );
    const oldLogin = await login({ username: "demo.password", password: "DemoPass#2026" }, "pos");
    const changedPassword = await call(app, {
      method: "post",
      path: "/api/v1/auth/change-password",
      token: oldLogin.token,
      body: { current_password: "DemoPass#2026", new_password: "DemoPass#2027" },
    });
    const oldToken = await call(app, { method: "get", path: "/api/v1/shifts/current", token: oldLogin.token });
    const newLogin = await login({ username: "demo.password", password: "DemoPass#2027" }, "pos");
    pushResult(results, {
      scenario: "Password change revokes the previous token",
      feature: "fault",
      status:
        passUser?.id && changedPassword.status === 200 && oldToken.status === 401 && newLogin.status === 200
          ? "PASS"
          : "FAIL",
      expected: "change 200, old token 401, new login 200",
      actual: `change ${changedPassword.status}, old ${oldToken.status}, new ${newLogin.status}`,
      classification: oldToken.status === 401 ? "" : "application",
      screen: "تسجيل الدخول",
    });

    await runPrintFailure({ app, db, cashier1, product, piece, results });
  } finally {
    await closeDemo(db);
  }
}

async function runPrintFailure({ app, db, cashier1, product, piece, results }) {
  const sale = await call(app, {
    method: "post",
    path: "/api/v1/checkout",
    token: cashier1,
    body: {
      idempotency_key: "fault-print-sale",
      items: [{ product_id: product.id, quantity: 1, price: 15, unit_id: piece?.id }],
      payment_method: "cash",
    },
  });
  const saved = await db.get("SELECT id, total FROM transactions WHERE idempotency_key = ?", ["fault-print-sale"]);
  const previousHook = process.env.RECEIPT_PRINT_FAULT_HOOK;
  const previousMode = process.env.RECEIPT_PRINT_TEST_MODE;
  process.env.RECEIPT_PRINT_FAULT_HOOK = "1";
  delete process.env.RECEIPT_PRINT_TEST_MODE;
  const { setPrintPipelineForTests, silentPrintErrorFromHelper } = await import(
    "../../services/windowsSilentPrint.js"
  );
  setPrintPipelineForTests({
    platform: "win32",
    htmlToPdf: async () => ({ pdfPath: "isolated-fault.pdf", tmp: null }),
    resolvePrinter: async () => "Missing Demo Printer",
    printPdfFile: async () => {
      throw silentPrintErrorFromHelper(
        new Error(
          'Command failed: SumatraPDF.exe -print-to "Missing Demo Printer" C:\\Users\\secret\\receipt.pdf: The printer doesn\'t exist'
        )
      );
    },
  });
  try {
    const silent = await call(app, {
      method: "post",
      path: "/api/v1/print-receipt/silent",
      token: cashier1,
      body: { transaction_id: saved.id },
    });
    const still = await db.get("SELECT id, total FROM transactions WHERE id = ?", [saved.id]);
    const saleKept = sale.status === 201 && still && Number(still.total) === 15;
    const body = silent.body?.data || silent.body || {};
    const message = String(body.error || "");
    const handled =
      silent.status === 409 &&
      body.code === "NO_PRINTER" &&
      message.includes("تم حفظ البيع") &&
      !message.includes("Sumatra") &&
      !message.includes("secret") &&
      !/at /.test(message);
    const count = await db.get("SELECT COUNT(*) AS n FROM transactions WHERE idempotency_key = ?", [
      "fault-print-sale",
    ]);
    pushResult(results, {
      scenario: "Print failure after a saved sale",
      feature: "fault",
      status: saleKept && handled && Number(count?.n) === 1 ? "PASS" : "FAIL",
      expected: "sale 15.00 remains once and missing printer returns 409 NO_PRINTER",
      actual: `sale ${sale.status}, print ${silent.status} ${body.code || ""}, total ${still?.total}, rows ${count?.n}`,
      classification: saleKept && handled ? "" : "application",
      screen: "الإيصال",
      detail: handled
        ? "A missing printer is a missing configured resource (409 NO_PRINTER). The sale stays saved. The isolated helper does not launch a print job, and the response omits the helper path."
        : message || `print HTTP ${silent.status}`,
    });
  } finally {
    setPrintPipelineForTests(null);
    if (previousHook == null) delete process.env.RECEIPT_PRINT_FAULT_HOOK;
    else process.env.RECEIPT_PRINT_FAULT_HOOK = previousHook;
    if (previousMode == null) delete process.env.RECEIPT_PRINT_TEST_MODE;
    else process.env.RECEIPT_PRINT_TEST_MODE = previousMode;
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  const expected = loadExpected(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "expected.json"));
  const results = [];
  try {
    await runFaults({ expected, results });
  } catch (error) {
    pushResult(results, {
      scenario: "Fault runner",
      feature: "fault",
      status: "FAIL",
      expected: "fault scenarios finish",
      actual: error.stack || error.message,
      classification: "test_infrastructure",
    });
  }
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "fault-results.json"), JSON.stringify(results, null, 2));
  process.exit(results.some((row) => row.status === "FAIL") ? 1 : 0);
}
