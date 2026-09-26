import { expect, test } from "@playwright/test";
import {
  CASH_SALE_QTY,
  DRAWER_SALE_QTY,
  OPENING_A,
  OPENING_B,
  PRODUCT,
  RETURN_DAY,
  SALE_DAY,
  USERS,
  VISA_CASH_SALE_DAY,
  VISA_QTY,
  VISA_SALE_DAY,
  dmy,
} from "./fixtures.mjs";
import { tempDb } from "./temp-db.mjs";

/**
 * Cross-shift customer return through the real POS and office UI.
 *
 * The POS shift screen has no opening-cash field. The test sets
 * app_settings.default_opening_cash, clicks بدء الوردية, and asserts the
 * opened shift's opening_cash.
 *
 * Approval uses the office refund screen. Telegram transport is covered by
 * the backend telegram tests; this server clears Telegram tokens so the
 * smoke test does not depend on a bot.
 *
 * There is no fake clock. After the UI opens a shift, the test labels that
 * shift's business day in the disposable database so the screen has to show
 * the sale day and the processing day as different values. Cutoff-boundary
 * math stays in the backend shop-time tests.
 */

const BANNED_KEYS = [
  "cost",
  "unit_cost",
  "unit_cost_at_sale",
  "gross_profit",
  "supplier",
  "supplier_id",
  "supplier_balance",
  "cost_known",
];

const db = tempDb(process.env.E2E_DB_PATH);

function payloadOf(json) {
  if (json && typeof json === "object" && json.data && typeof json.data === "object") return json.data;
  return json || {};
}

function brief(data) {
  const copy = { ...(data || {}) };
  delete copy.receipt_html;
  delete copy.receipt_text;
  delete copy.items_json;
  return JSON.stringify(copy).slice(0, 700);
}

function bannedKeys(value, path = "$", hits = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => bannedKeys(item, `${path}[${index}]`, hits));
    return hits;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (BANNED_KEYS.includes(key)) hits.push(`${path}.${key}`);
      bannedKeys(child, `${path}.${key}`, hits);
    }
  }
  return hits;
}

function assertNoSensitive(payload) {
  const hits = bannedKeys(payload);
  expect(hits, `cashier lookup exposed ${hits.join(", ")}`).toEqual([]);
}

function isRefundCreate(request) {
  if (request.method() !== "POST") return false;
  return /\/refund-requests\/?$/.test(new URL(request.url()).pathname);
}

function track(pages) {
  const bag = [];
  for (const page of pages) {
    page.on("pageerror", (err) => bag.push(`pageerror: ${err.message}`));
    page.on("dialog", async (dialog) => {
      bag.push(`dialog: ${dialog.message()}`);
      await dialog.dismiss();
    });
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (/TypeError|ReferenceError|NaN|Minified React error|Uncaught/i.test(text)) {
        bag.push(`console: ${text}`);
      }
    });
    page.on("response", (res) => {
      if (res.status() < 400) return;
      if (!res.url().includes("/api/")) return;
      bag.push(`api ${res.status()} ${res.request().method()} ${res.url()}`);
    });
  }
  return {
    bag,
    async assertClean(label) {
      if (!bag.length) return;
      const text = bag.join("\n");
      bag.length = 0;
      throw new Error(`${label}\n${text}`);
    },
  };
}

async function loginPos(page, user) {
  await page.goto("/pos/login");
  await page.getByLabel("اسم المستخدم", { exact: true }).fill(user.username);
  await page.getByLabel("كلمة المرور", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "دخول", exact: true }).click();
  await page.waitForURL(/\/pos\/checkout/);
  await expect(page.getByRole("button", { name: "بدء الوردية", exact: true })).toBeVisible();
}

async function loginOffice(page, user) {
  await page.goto("/admin/login");
  await page.getByLabel("اسم المستخدم", { exact: true }).fill(user.username);
  await page.getByLabel("كلمة المرور", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "دخول", exact: true }).click();
  await page.waitForURL(/\/admin\/(?!login)/);
}

async function startShift(page, opening) {
  const response = page.waitForResponse(
    (res) => res.request().method() === "POST" && /\/shifts\/start$/.test(new URL(res.url()).pathname),
    { timeout: 30_000 }
  );
  await page.getByRole("button", { name: "بدء الوردية", exact: true }).click();
  const res = await response;
  const data = payloadOf(await res.json());
  expect(res.status(), brief(data)).toBe(201);
  expect(Number(data.opening_cash)).toBeCloseTo(opening, 2);
  await expect(page.getByPlaceholder("امسح الباركود أو ابحث باسم المنتج أو رقمه")).toBeVisible();
  return data;
}

async function pinBusinessDay(page, shiftId, day) {
  await db.run("UPDATE cashier_shifts SET business_day = ? WHERE id = ?", [day, shiftId]);
  await page.getByRole("button", { name: "تحديث", exact: true }).click();
  await expect(page.locator(".pos-header")).toContainText(`يوم العمل ${dmy(day)}`);
}

async function sell(page, { qty, method, tender, total }) {
  const scan = page.getByPlaceholder("امسح الباركود أو ابحث باسم المنتج أو رقمه");
  await scan.click();
  await scan.fill(PRODUCT.barcode);
  await scan.press("Enter");
  const qtyInput = page.getByLabel("الكمية", { exact: true });
  await expect(qtyInput).toBeVisible();
  await qtyInput.fill(String(qty));
  await expect(qtyInput).toHaveValue(String(qty));
  await page.getByRole("button", { name: /إتمام البيع/ }).click();
  const dialog = page.locator(".pos-payment-modal");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: method === "visa" ? "فيزا" : "نقدي", exact: true }).click();
  if (method !== "visa") await dialog.getByLabel(/المستلم/).fill(String(tender));
  await expect(dialog).toContainText(total.toFixed(2));
  const response = page.waitForResponse(
    (res) => res.request().method() === "POST" && /\/checkout$/.test(new URL(res.url()).pathname),
    { timeout: 30_000 }
  );
  await dialog.getByRole("button", { name: "ترحيل", exact: true }).click();
  const res = await response;
  const data = payloadOf(await res.json());
  expect(res.status(), brief(data)).toBe(201);
  expect(String(data.receipt_number)).toMatch(/^INV-/);
  expect(data.payment_method).toBe(method);
  expect(Number(data.total)).toBeCloseTo(total, 2);
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  return data;
}

async function endShift(page) {
  await page.getByRole("button", { name: "إغلاق الوردية", exact: true }).click();
  const response = page.waitForResponse(
    (res) => res.request().method() === "POST" && /\/shifts\/\d+\/end$/.test(new URL(res.url()).pathname),
    { timeout: 30_000 }
  );
  await page.getByRole("button", { name: "إنهاء الوردية", exact: true }).click();
  const res = await response;
  expect(res.ok(), `end shift ${res.status()}`).toBeTruthy();
  await page.waitForURL(/\/pos\/login/, { timeout: 20_000 });
}

async function setOpening(office, amount) {
  const result = await office.evaluate(async (opening) => {
    const token = localStorage.getItem("office.token");
    const res = await fetch("/api/v1/settings", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ default_opening_cash: opening }),
    });
    const json = await res.json();
    const data = json.data ?? json;
    return { status: res.status, opening: data.default_opening_cash, error: data.error };
  }, amount);
  expect(result.status, JSON.stringify(result)).toBe(200);
  expect(Number(result.opening)).toBeCloseTo(amount, 2);
}

async function readShift(office, id) {
  const result = await office.evaluate(async (shiftId) => {
    const token = localStorage.getItem("office.token");
    const res = await fetch(`/api/v1/shifts/${shiftId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    return { status: res.status, json };
  }, id);
  expect(result.status, brief(payloadOf(result.json))).toBe(200);
  return payloadOf(result.json);
}

async function currentShift(page) {
  const result = await page.evaluate(async () => {
    const token = localStorage.getItem("pos.token");
    const res = await fetch("/api/v1/shifts/current", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    return { status: res.status, json };
  });
  expect(result.status, brief(payloadOf(result.json))).toBe(200);
  return payloadOf(result.json).shift;
}

function snapshotClosed(detail) {
  const shift = detail.shift;
  return {
    status: shift.status,
    opening_cash: Number(shift.opening_cash),
    expected_cash: Number(shift.expected_cash),
    closing_cash: Number(shift.closing_cash),
    actual_cash: shift.actual_cash == null ? null : Number(shift.actual_cash),
    variance: Number(shift.variance),
    counted_cash_json: shift.counted_cash_json,
    cash_refunds: Number(shift.cash_refunds || 0),
    visa_sales: Number(shift.visa_sales || 0),
    visa_refunds: Number(shift.visa_refunds || 0),
    refund_count: (detail.refunds || []).length,
  };
}

function expectSameSnapshot(actual, frozen) {
  expect(actual.status).toBe("closed");
  expect(actual.status).toBe(frozen.status);
  expect(actual.opening_cash).toBeCloseTo(frozen.opening_cash, 2);
  expect(actual.expected_cash).toBeCloseTo(frozen.expected_cash, 2);
  expect(actual.closing_cash).toBeCloseTo(frozen.closing_cash, 2);
  expect(actual.variance).toBeCloseTo(frozen.variance, 2);
  expect(actual.counted_cash_json).toBe(frozen.counted_cash_json);
  expect(actual.cash_refunds).toBeCloseTo(frozen.cash_refunds, 2);
  expect(actual.visa_sales).toBeCloseTo(frozen.visa_sales, 2);
  expect(actual.visa_refunds).toBeCloseTo(frozen.visa_refunds, 2);
  expect(actual.refund_count).toBe(frozen.refund_count);
  if (frozen.actual_cash != null) expect(actual.actual_cash).toBeCloseTo(frozen.actual_cash, 2);
}

async function finalizeShift(office, { shiftId, cashierName, expected }) {
  const pending = await readShift(office, shiftId);
  expect(pending.shift.status).toBe("pending_count");
  expect(Number(pending.shift.expected_cash)).toBeCloseTo(expected, 2);
  await office.goto("/admin/shift-audit");
  const row = office.locator("tr", { hasText: cashierName }).filter({ hasText: "عد النقد" });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "عد النقد", exact: true }).click();
  const dialog = office.getByRole("dialog");
  await dialog.locator(".ui-field", { hasText: "شيكل" }).locator("input").fill(Number(expected).toFixed(2));
  const foreign = dialog.locator(".ui-field").filter({ hasText: /دولار|دينار/ });
  const count = await foreign.count();
  for (let index = 0; index < count; index += 1) {
    await foreign.nth(index).locator("input").fill("0");
  }
  const response = office.waitForResponse(
    (res) => res.request().method() === "POST" && /\/shifts\/\d+\/reconcile$/.test(new URL(res.url()).pathname),
    { timeout: 30_000 }
  );
  await dialog.getByRole("button", { name: "تأكيد وإغلاق", exact: true }).click();
  const res = await response;
  const body = payloadOf(await res.json());
  expect(res.status(), brief(body)).toBe(200);
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  const closed = await readShift(office, shiftId);
  const snap = snapshotClosed(closed);
  expect(snap.status).toBe("closed");
  expect(snap.expected_cash).toBeCloseTo(expected, 2);
  expect(snap.variance).toBeCloseTo(0, 2);
  expect(snap.cash_refunds).toBeCloseTo(0, 2);
  expect(snap.refund_count).toBe(0);
  expect(snap.counted_cash_json).toBeTruthy();
  return snap;
}

async function dismissApprovalNotice(page) {
  const done = page.getByRole("button", { name: /^تم/ });
  if (!(await done.isVisible().catch(() => false))) return;
  const ack = page.waitForResponse(
    (res) => res.request().method() === "POST" && res.url().includes("/acknowledge"),
    { timeout: 20_000 }
  );
  await done.click();
  expect((await ack).ok()).toBeTruthy();
  await expect(done).toBeHidden({ timeout: 10_000 });
}

async function ensureRefundOpen(page) {
  await dismissApprovalNotice(page);
  const heading = page.getByRole("heading", { name: "استرجاع", exact: true });
  if (!(await heading.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "استرجاع", exact: true }).click();
  }
  await expect(heading).toBeVisible();
}

async function openReceipt(page, receipt) {
  await ensureRefundOpen(page);
  const past = page.getByRole("button", { name: "بحث في مبيعات سابقة", exact: true });
  if (!(await past.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "رجوع", exact: true }).click();
  }
  await past.click();
  await page.getByLabel("رقم الإيصال أو الفاتورة").fill(receipt);
  const search = page.waitForResponse(
    (res) => res.request().method() === "GET" && res.url().includes("/refunds/search"),
    { timeout: 30_000 }
  );
  await page.getByRole("button", { name: "بحث", exact: true }).click();
  expect((await search).ok()).toBeTruthy();
  const lookup = page.waitForResponse(
    (res) => res.request().method() === "GET" && res.url().includes("/refunds/lookup/"),
    { timeout: 30_000 }
  );
  await page.getByRole("button", { name: receipt }).click();
  const lookupRes = await lookup;
  expect(lookupRes.ok()).toBeTruthy();
  const data = payloadOf(await lookupRes.json());
  assertNoSensitive(data);
  const detail = page.locator(".rf-detail");
  await expect(detail).toContainText(receipt);
  const text = await detail.innerText();
  expect(text).not.toContain("NaN");
  expect(text).not.toMatch(/المبلغ المسترد:\s*undefined/);
  return data;
}

async function returnLine(page) {
  const row = page.locator(".rf-detail tbody tr", { hasText: PRODUCT.name });
  const cells = row.locator("td");
  return {
    row,
    sold: Number(await cells.nth(2).innerText()),
    refunded: Number(await cells.nth(3).innerText()),
    returnable: Number(await cells.nth(4).innerText()),
    returning: Number(await row.locator("input[type=number]").inputValue()),
  };
}

async function submitReturn(page, { qty, method, totalText, methodLabel }) {
  const detail = page.locator(".rf-detail");
  const before = await returnLine(page);
  await before.row.locator("input[type=number]").fill(String(qty));
  await detail.locator("select").selectOption(method);
  const line = await returnLine(page);
  expect(line.returning).toBeCloseTo(qty, 3);
  expect(line.returnable - line.returning).toBeCloseTo(before.returnable - qty, 3);
  const quote = detail.locator(".rf-quote");
  await expect(quote).toContainText(totalText);
  await expect(quote).toContainText(methodLabel);
  await expect(quote).not.toContainText("NaN");
  const reqPromise = page.waitForRequest(isRefundCreate, { timeout: 30_000 });
  const resPromise = page.waitForResponse((res) => isRefundCreate(res.request()), { timeout: 30_000 });
  await detail.getByRole("button", { name: "إرسال طلب الاسترجاع", exact: true }).click();
  const req = await reqPromise;
  const res = await resPromise;
  const created = payloadOf(await res.json());
  expect(res.status(), brief(created)).toBe(201);
  await expect(page.getByText("بانتظار موافقة المدير")).toBeVisible();
  return { url: req.url(), body: req.postDataJSON(), created, line };
}

async function replayRefund(page, captured) {
  const result = await page.evaluate(
    async ({ url, body }) => {
      const token = localStorage.getItem("pos.token");
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      return { status: res.status, json };
    },
    { url: captured.url, body: captured.body }
  );
  const data = payloadOf(result.json);
  expect(result.status, brief(data)).toBe(200);
  expect(data.replayed).toBe(true);
  return data;
}

async function approveRefund(office, amountRe) {
  await office.goto("/admin/refund-approvals");
  const row = office.locator("tr", { hasText: amountRe }).filter({ hasText: "موافقة" });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "موافقة", exact: true }).click();
  const dialog = office.getByRole("dialog");
  const response = office.waitForResponse(
    (res) =>
      res.request().method() === "PUT" && /\/refund-requests\/\d+$/.test(new URL(res.url()).pathname),
    { timeout: 30_000 }
  );
  await dialog.getByRole("button", { name: "تأكيد", exact: true }).click();
  const res = await response;
  const body = payloadOf(await res.json());
  expect(res.status(), brief(body)).toBe(200);
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

async function waitUntilRefundModalCloses(page) {
  await expect(page.getByRole("heading", { name: "استرجاع", exact: true })).toBeHidden({ timeout: 20_000 });
}

async function refundCounts(txId) {
  const requests = await db.get("SELECT COUNT(*) AS c FROM refund_requests WHERE transaction_id = ?", [txId]);
  const posted = await db.get("SELECT COUNT(*) AS c FROM refunds WHERE original_transaction_id = ?", [txId]);
  return { requests: Number(requests.c), posted: Number(posted.c) };
}

async function stock() {
  const row = await db.get("SELECT stock FROM products WHERE barcode = ?", [PRODUCT.barcode]);
  return Number(row.stock);
}

async function setCatalogPrice(price) {
  await db.run("UPDATE products SET price = ? WHERE barcode = ?", [price, PRODUCT.barcode]);
  await db.run("UPDATE product_units SET price = ? WHERE barcode = ?", [price, PRODUCT.barcode]);
}

function ledgerKey(rows) {
  return JSON.stringify(
    rows.map((row) => ({
      id: row.id,
      quantity_delta: Number(row.quantity_delta),
      business_day: String(row.business_day || "").slice(0, 10),
      user_id: row.user_id,
      reference_id: row.reference_id,
      notes: row.notes,
    }))
  );
}

test("cross-shift customer return smoke", async ({ browser }) => {
  test.skip(!process.env.E2E_BASE_URL || !process.env.E2E_DB_PATH, "start this spec with npm run test:e2e:return");
  expect(process.env.E2E_DB_PATH || "").not.toMatch(/supermarket\.db/i);

  const posAContext = await browser.newContext();
  const posBContext = await browser.newContext();
  const officeContext = await browser.newContext();
  for (const context of [posAContext, posBContext, officeContext]) {
    await context.addInitScript(() => {
      window.print = () => {};
    });
  }
  const posA = await posAContext.newPage();
  const posB = await posBContext.newPage();
  const office = await officeContext.newPage();
  const errors = track([posA, posB, office]);

  const state = {};

  async function stage(name, fn) {
    await test.step(name, async () => {
      const before = errors.bag.length;
      try {
        await fn();
      } catch (err) {
        if (errors.bag.length > before) {
          err.message += `\n${errors.bag.slice(before).join("\n")}`;
        }
        throw err;
      }
      await errors.assertClean(name);
      console.log(`PASS ${name}`);
    });
  }

  try {
    await stage("login", async () => {
      await Promise.all([loginPos(posA, USERS.cashierA), loginOffice(office, USERS.admin)]);
      await expect(posA.locator(".pos-header, .shift-modal-title").first()).toBeVisible();
    });

    await stage("Shift A sale", async () => {
      const opened = await startShift(posA, OPENING_A);
      state.shiftAId = Number(opened.shift_id);
      await pinBusinessDay(posA, state.shiftAId, SALE_DAY);
      const sale = await sell(posA, {
        qty: CASH_SALE_QTY,
        method: "cash",
        tender: PRODUCT.price * CASH_SALE_QTY,
        total: PRODUCT.price * CASH_SALE_QTY,
      });
      state.receipt = sale.receipt_number;
      state.txId = Number(sale.transaction_id);
      console.log(`INV ${state.receipt}`);
      expect(await stock()).toBeCloseTo(PRODUCT.stock - CASH_SALE_QTY, 3);
      state.saleLedger = ledgerKey(
        await db.all(
          `SELECT id, quantity_delta, business_day, user_id, reference_id, notes
           FROM inventory_ledger WHERE reference_type = 'transaction' AND reference_id = ?`,
          [state.txId]
        )
      );
      const cashierA = await db.get("SELECT id FROM users WHERE username = ?", [USERS.cashierA.username]);
      const moves = JSON.parse(state.saleLedger);
      expect(moves).toHaveLength(1);
      expect(moves[0].quantity_delta).toBeCloseTo(-CASH_SALE_QTY, 3);
      expect(moves[0].business_day).toBe(SALE_DAY);
      expect(Number(moves[0].user_id)).toBe(Number(cashierA.id));
    });

    await stage("Shift A finalize", async () => {
      await endShift(posA);
      state.shiftASnapshot = await finalizeShift(office, {
        shiftId: state.shiftAId,
        cashierName: USERS.cashierA.username,
        expected: OPENING_A + PRODUCT.price * CASH_SALE_QTY,
      });
    });

    await stage("Shift B open", async () => {
      await setOpening(office, OPENING_B);
      await loginPos(posB, USERS.cashierB);
      const opened = await startShift(posB, OPENING_B);
      state.shiftBId = Number(opened.shift_id);
      expect(state.shiftBId).not.toBe(state.shiftAId);
      await pinBusinessDay(posB, state.shiftBId, RETURN_DAY);
      await sell(posB, {
        qty: DRAWER_SALE_QTY,
        method: "cash",
        tender: PRODUCT.price * DRAWER_SALE_QTY,
        total: PRODUCT.price * DRAWER_SALE_QTY,
      });
      const shift = await currentShift(posB);
      expect(Number(shift.opening_cash)).toBeCloseTo(OPENING_B, 2);
      expect(Number(shift.cash_sales)).toBeCloseTo(PRODUCT.price * DRAWER_SALE_QTY, 2);
      expect(Number(shift.cash_refunds)).toBeCloseTo(0, 2);
      expect(Number(shift.expected_cash)).toBeCloseTo(OPENING_B + PRODUCT.price * DRAWER_SALE_QTY, 2);
      expect(Number(shift.visa_refunds)).toBeCloseTo(0, 2);
      state.stockAfterSales = await stock();
      expect(state.stockAfterSales).toBeCloseTo(PRODUCT.stock - CASH_SALE_QTY - DRAWER_SALE_QTY, 3);
    });

    await stage("return screen", async () => {
      await posB.getByRole("button", { name: "استرجاع", exact: true }).click();
      await expect(posB.getByRole("heading", { name: "استرجاع", exact: true })).toBeVisible();
      await expect(posB.getByRole("heading", { name: "اختر إيصالاً من الوردية" })).toBeVisible();
      await expect(posB.getByRole("button", { name: "بحث في مبيعات سابقة", exact: true })).toBeVisible();
    });

    await stage("INV search", async () => {
      await setCatalogPrice(PRODUCT.raisedPrice);
      const catalog = await db.get("SELECT price FROM products WHERE barcode = ?", [PRODUCT.barcode]);
      expect(Number(catalog.price)).toBeCloseTo(PRODUCT.raisedPrice, 2);
      const lookup = await openReceipt(posB, state.receipt);
      state.lookup = lookup;
      expect(lookup.receipt_number).toBe(state.receipt);
      expect(lookup.cashier_username).toBe(USERS.cashierA.username);
      expect(Number(lookup.shift_id)).toBe(state.shiftAId);
      expect(lookup.payment_method).toBe("cash");
      expect(String(lookup.business_day).slice(0, 10)).toBe(SALE_DAY);
      const detail = posB.locator(".rf-detail");
      await expect(detail).toContainText(USERS.cashierA.username);
      await expect(detail).toContainText(`الوردية الأصلية #${state.shiftAId}`);
      await expect(detail).toContainText("الدفع الأصلي: نقد");
      await expect(detail).toContainText(`يوم العمل ${SALE_DAY}`);
      await expect(detail).not.toContainText(RETURN_DAY);
      await expect(posB.locator(".pos-header")).toContainText(`يوم العمل ${dmy(RETURN_DAY)}`);
      const line = await returnLine(posB);
      expect(line.sold).toBeCloseTo(CASH_SALE_QTY, 3);
      expect(line.refunded).toBeCloseTo(0, 3);
      expect(line.returnable).toBeCloseTo(CASH_SALE_QTY, 3);
      await expect(line.row.locator("td").nth(2).locator("input")).toHaveCount(0);
    });

    await stage("historical price", async () => {
      const line = state.lookup.lines.find((item) => item.name === PRODUCT.name);
      expect(Number(line.price)).toBeCloseTo(PRODUCT.price, 2);
      expect(Number(line.price)).not.toBeCloseTo(PRODUCT.raisedPrice, 2);
      const cell = posB.locator(".rf-detail tbody tr", { hasText: PRODUCT.name }).locator("td").nth(1);
      await expect(cell).toContainText("₪20.00");
      await expect(cell).not.toContainText("₪30.00");
      await expect(posB.locator(".rf-detail")).not.toContainText("خصم");
    });

    await stage("partial return", async () => {
      state.captured = await submitReturn(posB, {
        qty: 1,
        method: "cash",
        totalText: "₪20.00",
        methodLabel: "نقد",
      });
      expect(String(state.captured.body.idempotency_key || "").length).toBeGreaterThanOrEqual(8);
      expect(state.captured.line.sold).toBeCloseTo(2, 3);
      expect(state.captured.line.refunded).toBeCloseTo(0, 3);
      expect(state.captured.line.returning).toBeCloseTo(1, 3);
      expect(state.captured.line.returnable - state.captured.line.returning).toBeCloseTo(1, 3);
    });

    await stage("pending state", async () => {
      await expect(posB.getByText("بانتظار موافقة المدير")).toBeVisible();
      const replay = await replayRefund(posB, state.captured);
      expect(Number(replay.request_id)).toBe(Number(state.captured.created.request_id));
      const counts = await refundCounts(state.txId);
      expect(counts.requests).toBe(1);
      expect(counts.posted).toBe(0);
      expect(await stock()).toBeCloseTo(state.stockAfterSales, 3);
      const shift = await currentShift(posB);
      expect(Number(shift.expected_cash)).toBeCloseTo(800, 2);
      expect(Number(shift.cash_refunds)).toBeCloseTo(0, 2);
    });

    await stage("approval", async () => {
      await approveRefund(office, /₪20\.00/);
      await waitUntilRefundModalCloses(posB);
    });

    await stage("expected drawer 780", async () => {
      const shift = await currentShift(posB);
      expect(Number(shift.opening_cash)).toBeCloseTo(OPENING_B, 2);
      expect(Number(shift.cash_sales)).toBeCloseTo(300, 2);
      expect(Number(shift.cash_refunds)).toBeCloseTo(20, 2);
      expect(Number(shift.expected_cash)).toBeCloseTo(780, 2);
      expect(Number(shift.visa_sales)).toBeCloseTo(0, 2);
      expect(Number(shift.visa_refunds)).toBeCloseTo(0, 2);
      const posted = await db.get(
        "SELECT shift_id, payment_method, business_day, total FROM refunds WHERE original_transaction_id = ?",
        [state.txId]
      );
      expect(Number(posted.shift_id)).toBe(state.shiftBId);
      expect(Number(posted.shift_id)).not.toBe(state.shiftAId);
      expect(posted.payment_method).toBe("cash");
      expect(String(posted.business_day).slice(0, 10)).toBe(RETURN_DAY);
      expect(Number(posted.total)).toBeCloseTo(20, 2);
    });

    await stage("original shift unchanged", async () => {
      const again = snapshotClosed(await readShift(office, state.shiftAId));
      expectSameSnapshot(again, state.shiftASnapshot);
      const assigned = await db.get("SELECT COUNT(*) AS c FROM refunds WHERE shift_id = ?", [state.shiftAId]);
      expect(Number(assigned.c)).toBe(0);
    });

    await stage("stock +1", async () => {
      expect(await stock()).toBeCloseTo(state.stockAfterSales + 1, 3);
      const saleRows = await db.all(
        `SELECT id, quantity_delta, business_day, user_id, reference_id, notes
         FROM inventory_ledger WHERE reference_type = 'transaction' AND reference_id = ?`,
        [state.txId]
      );
      expect(ledgerKey(saleRows)).toBe(state.saleLedger);
      const refund = await db.get("SELECT id FROM refunds WHERE original_transaction_id = ?", [state.txId]);
      const refundRows = await db.all(
        `SELECT quantity_delta, business_day, user_id, reference_id
         FROM inventory_ledger WHERE reference_type = 'refund' AND reference_id = ?`,
        [refund.id]
      );
      expect(refundRows).toHaveLength(1);
      expect(Number(refundRows[0].quantity_delta)).toBeCloseTo(1, 3);
      expect(String(refundRows[0].business_day).slice(0, 10)).toBe(RETURN_DAY);
      const cashierB = await db.get("SELECT id FROM users WHERE username = ?", [USERS.cashierB.username]);
      expect(Number(refundRows[0].user_id)).toBe(Number(cashierB.id));
    });

    await stage("return history", async () => {
      const lookup = await openReceipt(posB, state.receipt);
      assertNoSensitive(lookup);
      const line = await returnLine(posB);
      expect(line.sold).toBeCloseTo(2, 3);
      expect(line.refunded).toBeCloseTo(1, 3);
      expect(line.returnable).toBeCloseTo(1, 3);
      await expect(line.row.locator("td").nth(2).locator("input")).toHaveCount(0);
      const history = posB.locator(".rf-history");
      await expect(history).toContainText(PRODUCT.name);
      await expect(history).toContainText("×1");
      await expect(history).toContainText("₪20.00");
      await expect(history).toContainText("نقد");
      await expect(history).toContainText(USERS.cashierB.username);
      await expect(history).toContainText(`وردية #${state.shiftBId}`);
      await expect(history).toContainText(`يوم العمل ${dmy(RETURN_DAY)}`);
      const meta = posB.locator(".rf-detail .rf-meta").first();
      await expect(meta).toContainText(state.receipt);
      await expect(meta).toContainText(`يوم العمل ${SALE_DAY}`);
      await expect(meta).toContainText(USERS.cashierA.username);
      await expect(meta).toContainText("الدفع الأصلي: نقد");
      expect(String(lookup.returns.find((row) => row.kind === "refund").business_day).slice(0, 10)).toBe(RETURN_DAY);
    });

    await stage("duplicate submit protection", async () => {
      const beforeStock = await stock();
      const before = await currentShift(posB);
      await replayRefund(posB, state.captured);
      const counts = await refundCounts(state.txId);
      expect(counts.requests).toBe(1);
      expect(counts.posted).toBe(1);
      expect(await stock()).toBeCloseTo(beforeStock, 3);
      const after = await currentShift(posB);
      expect(Number(after.expected_cash)).toBeCloseTo(Number(before.expected_cash), 2);
      expect(Number(after.cash_refunds)).toBeCloseTo(Number(before.cash_refunds), 2);
      const refundMoves = await db.get(
        `SELECT COUNT(*) AS c FROM inventory_ledger
         WHERE reference_type = 'refund'
           AND reference_id = (SELECT id FROM refunds WHERE original_transaction_id = ?)`,
        [state.txId]
      );
      expect(Number(refundMoves.c)).toBe(1);
    });

    await stage("visa refund", async () => {
      await setCatalogPrice(PRODUCT.price);
      await setOpening(office, OPENING_A);
      await loginPos(posA, USERS.cashierA);
      const opened = await startShift(posA, OPENING_A);
      state.visaShiftId = Number(opened.shift_id);
      await pinBusinessDay(posA, state.visaShiftId, VISA_SALE_DAY);
      const sale = await sell(posA, {
        qty: VISA_QTY,
        method: "visa",
        total: PRODUCT.price * VISA_QTY,
      });
      state.visaReceipt = sale.receipt_number;
      state.visaTxId = Number(sale.transaction_id);
      await endShift(posA);
      state.visaSnapshot = await finalizeShift(office, {
        shiftId: state.visaShiftId,
        cashierName: USERS.cashierA.username,
        expected: OPENING_A,
      });
      const before = await currentShift(posB);
      expect(Number(before.expected_cash)).toBeCloseTo(780, 2);
      const lookup = await openReceipt(posB, state.visaReceipt);
      expect(lookup.payment_method).toBe("visa");
      await expect(posB.locator(".rf-detail")).toContainText("الدفع الأصلي: بطاقة");
      await expect(posB.locator(".rf-detail")).toContainText(`يوم العمل ${VISA_SALE_DAY}`);
      const submitted = await submitReturn(posB, {
        qty: VISA_QTY,
        method: "visa",
        totalText: "₪100.00",
        methodLabel: "بطاقة",
      });
      await approveRefund(office, /₪100\.00/);
      await waitUntilRefundModalCloses(posB);
      const after = await currentShift(posB);
      expect(Number(after.expected_cash)).toBeCloseTo(Number(before.expected_cash), 2);
      expect(Number(after.cash_refunds)).toBeCloseTo(Number(before.cash_refunds), 2);
      expect(Number(after.visa_refunds)).toBeCloseTo(Number(before.visa_refunds) + 100, 2);
      const posted = await db.get(
        "SELECT shift_id, payment_method, business_day FROM refunds WHERE original_transaction_id = ?",
        [state.visaTxId]
      );
      expect(Number(posted.shift_id)).toBe(state.shiftBId);
      expect(posted.payment_method).toBe("visa");
      expect(String(posted.business_day).slice(0, 10)).toBe(RETURN_DAY);
      expectSameSnapshot(snapshotClosed(await readShift(office, state.visaShiftId)), state.visaSnapshot);
      expectSameSnapshot(snapshotClosed(await readShift(office, state.shiftAId)), state.shiftASnapshot);
      expect(submitted.created.request_id).toBeTruthy();
    });

    await stage("visa-to-cash", async () => {
      await loginPos(posA, USERS.cashierA);
      const opened = await startShift(posA, OPENING_A);
      state.visaCashShiftId = Number(opened.shift_id);
      await pinBusinessDay(posA, state.visaCashShiftId, VISA_CASH_SALE_DAY);
      const sale = await sell(posA, {
        qty: VISA_QTY,
        method: "visa",
        total: PRODUCT.price * VISA_QTY,
      });
      state.visaCashReceipt = sale.receipt_number;
      state.visaCashTxId = Number(sale.transaction_id);
      await endShift(posA);
      state.visaCashSnapshot = await finalizeShift(office, {
        shiftId: state.visaCashShiftId,
        cashierName: USERS.cashierA.username,
        expected: OPENING_A,
      });
      const before = await currentShift(posB);
      const lookup = await openReceipt(posB, state.visaCashReceipt);
      expect(lookup.payment_method).toBe("visa");
      await expect(posB.locator(".rf-detail")).toContainText("الدفع الأصلي: بطاقة");
      await submitReturn(posB, {
        qty: VISA_QTY,
        method: "cash",
        totalText: "₪100.00",
        methodLabel: "نقد",
      });
      await approveRefund(office, /₪100\.00/);
      await waitUntilRefundModalCloses(posB);
      const after = await currentShift(posB);
      expect(Number(after.expected_cash)).toBeCloseTo(Number(before.expected_cash) - 100, 2);
      expect(Number(after.cash_refunds)).toBeCloseTo(Number(before.cash_refunds) + 100, 2);
      expect(Number(after.visa_refunds)).toBeCloseTo(Number(before.visa_refunds), 2);
      const history = await openReceipt(posB, state.visaCashReceipt);
      expect(history.payment_method).toBe("visa");
      await expect(posB.locator(".rf-detail .rf-meta").first()).toContainText("الدفع الأصلي: بطاقة");
      await expect(posB.locator(".rf-history")).toContainText("نقد");
      await expect(posB.locator(".rf-history")).toContainText(`يوم العمل ${dmy(RETURN_DAY)}`);
      await expect(posB.locator(".rf-detail .rf-meta").first()).toContainText(`يوم العمل ${VISA_CASH_SALE_DAY}`);
      const posted = await db.get(
        "SELECT shift_id, payment_method, business_day FROM refunds WHERE original_transaction_id = ?",
        [state.visaCashTxId]
      );
      expect(posted.payment_method).toBe("cash");
      expect(Number(posted.shift_id)).toBe(state.shiftBId);
      expect(String(posted.business_day).slice(0, 10)).toBe(RETURN_DAY);
      expectSameSnapshot(snapshotClosed(await readShift(office, state.visaCashShiftId)), state.visaCashSnapshot);
      expectSameSnapshot(snapshotClosed(await readShift(office, state.shiftAId)), state.shiftASnapshot);
      const counts = await refundCounts(state.txId);
      expect(counts.requests).toBe(1);
      expect(counts.posted).toBe(1);
    });
  } finally {
    await posAContext.close();
    await posBContext.close();
    await officeContext.close();
  }
});
