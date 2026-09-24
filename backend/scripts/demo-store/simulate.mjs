import fs from "fs";
import path from "path";
import { createApp } from "../../app.js";
import { shopYmdFromTimestamp } from "../../utils/shopTime.js";
import { businessDayFromTimestamp } from "../../utils/businessDay.js";
import { reportDir } from "./guards.mjs";
import {
  asList,
  call,
  checkMoney,
  checkQty,
  httpFail,
  num,
  pushResult,
  snippet,
  unwrap,
} from "./lib.mjs";

const DAY = "2026-09-14";
const POS = "2026-09-15";

export async function runSimulation({ db, dbPath, expected, results }) {
  const app = createApp(db, dbPath);
  const ids = {};
  const tx = {};
  const accounts = expected.accounts;
  const products = expected.products;
  const parties = expected.parties;

  async function login(account, portal = account.portal) {
    const res = await call(app, {
      method: "post",
      path: "/api/v1/auth/login",
      body: { username: account.username, password: account.password, app: portal === "kiosk" ? "office" : portal },
    });
    const data = unwrap(res.body);
    return { res, token: data?.token || null };
  }

  async function must(res, label, statuses) {
    if (!statuses.includes(res.status)) throw httpFail(res, label);
    return unwrap(res.body);
  }

  let admin = null;
  let aborted = null;
  try {
  const badDefault = await call(app, {
    method: "post",
    path: "/api/v1/auth/login",
    body: { username: "admin", password: "admin123", app: "office" },
  });
  pushResult(results, {
    scenario: "Default password admin123 is rejected",
    feature: "auth",
    status: badDefault.status === 401 ? "PASS" : "FAIL",
    expected: "401",
    actual: String(badDefault.status),
    classification: badDefault.status === 401 ? "" : "application",
    screen: "تسجيل الدخول",
    detail: `Default password admin123 is rejected: expected HTTP 401; actual ${badDefault.status}`,
  });

  const adminLogin = await login(accounts.admin, "office");
  if (adminLogin.res.status !== 200) throw httpFail(adminLogin.res, "admin login");
  admin = adminLogin.token;
  const cashier1Login = await login(accounts.cashier1, "pos");
  if (cashier1Login.res.status !== 200) throw httpFail(cashier1Login.res, "cashier1 login");
  const cashier1 = cashier1Login.token;
  const cashier2Login = await login(accounts.cashier2, "pos");
  if (cashier2Login.res.status !== 200) throw httpFail(cashier2Login.res, "cashier2 login");
  const cashier2 = cashier2Login.token;
  const financeLogin = await login(accounts.finance, "office");
  if (financeLogin.res.status !== 200) throw httpFail(financeLogin.res, "finance accountant login");
  const finance = financeLogin.token;
  const accountantLogin = await login(accounts.accountant, "office");
  if (accountantLogin.res.status !== 200) throw httpFail(accountantLogin.res, "accountant login");

  const cashierOffice = await login(accounts.cashier1, "office");
  pushResult(results, {
    scenario: "Cashier cannot open the office portal",
    feature: "auth",
    status: cashierOffice.res.status === 403 ? "PASS" : "FAIL",
    expected: "403",
    actual: String(cashierOffice.res.status),
    classification: cashierOffice.res.status === 403 ? "" : "application",
    screen: "تسجيل الدخول",
  });

  const userRows = await db.all("SELECT id, username FROM users");
  const userId = Object.fromEntries(userRows.map((row) => [row.username, row.id]));

  const branding = await call(app, {
    method: "patch",
    path: "/api/v1/settings",
    token: admin,
    body: expected.branding,
  });
  pushResult(results, {
    scenario: "Demo branding replaces seeded store identity",
    feature: "settings",
    status: branding.status === 200 ? "PASS" : "FAIL",
    expected: "200",
    actual: String(branding.status),
    detail: branding.status === 200 ? "Demo branding saved" : snippet(branding.body),
    classification: branding.status === 200 ? "" : "application",
    screen: "الإعدادات",
  });

  const category = await must(
    await call(app, {
      method: "post",
      path: "/api/v1/products/categories",
      token: admin,
      body: { name: "مخبز" },
    }),
    "bakery category",
    [201]
  );
  ids.category = category.id;
  await must(
    await call(app, {
      method: "put",
      path: "/api/v1/reports/bakery/categories",
      token: admin,
      body: { category_ids: [ids.category] },
    }),
    "bakery report categories",
    [200]
  );

  async function supplier(name) {
    const row = await must(
      await call(app, { method: "post", path: "/api/v1/suppliers", token: admin, body: { name } }),
      `supplier ${name}`,
      [201]
    );
    return row.id;
  }
  ids.dairy = await supplier(parties.suppliers.dairy);
  ids.produce = await supplier(parties.suppliers.produce);
  ids.bakerySupplier = await supplier(parties.suppliers.bakery);
  ids.vatSupplier = await supplier(parties.suppliers.vat);
  ids.officeSupplier = await supplier(parties.suppliers.office);

  async function customer(name, credit) {
    const row = await must(
      await call(app, {
        method: "post",
        path: "/api/v1/customers",
        token: admin,
        body: { name, credit_limit: credit },
      }),
      `customer ${name}`,
      [201]
    );
    return row.id;
  }
  ids.ahmad = await customer(parties.customers.ahmad, 500);
  ids.layla = await customer(parties.customers.layla, 10);
  ids.reject = await customer(parties.customers.reject, 500);
  ids.officeCustomer = await customer("مكتب المبيعات التجريبي", 0);

  async function product(body) {
    const row = await must(
      await call(app, { method: "post", path: "/api/v1/products", token: admin, body }),
      `product ${body.name}`,
      [201]
    );
    const unitsRes = await call(app, {
      method: "get",
      path: `/api/v1/products/${row.id}/units`,
      token: admin,
    });
    const units = asList(unitsRes.body);
    const piece = units.find((unit) => unit.unit_name === "حبة") || units[0];
    const kg = units.find((unit) => unit.unit_name === "كغم");
    return { id: row.id, piece: piece?.id, kg: kg?.id, units };
  }

  const milk = await product({
    barcode: products.milk.barcode,
    name: products.milk.name,
    price: num(products.milk.price),
    stock: 0,
    unit: "حبة",
  });
  const tomato = await product({
    barcode: products.tomato.barcode,
    name: products.tomato.name,
    price: num(products.tomato.pricePerKg),
    stock: 0,
    is_weighed: true,
    scale_code: products.tomato.scaleCode,
  });
  const bread = await product({
    barcode: products.bread.barcode,
    name: products.bread.name,
    price: num(products.bread.price),
    stock: 0,
    unit: "حبة",
    category: "مخبز",
  });
  const yogurt = await product({
    barcode: products.yogurt.barcode,
    name: products.yogurt.name,
    price: num(products.yogurt.price),
    stock: 0,
    unit: "حبة",
  });
  const sugar = await product({
    barcode: products.sugar.barcode,
    name: products.sugar.name,
    price: num(products.sugar.price),
    stock: 0,
    unit: "حبة",
    min_stock: 2,
  });
  const oil = await product({
    barcode: products.oil.barcode,
    name: products.oil.name,
    price: num(products.oil.price),
    stock: 0,
    unit: "حبة",
    min_stock: num(products.oil.minStock),
  });
  const water = await product({
    barcode: products.water.barcode,
    name: products.water.name,
    price: num(products.water.price),
    stock: 0,
    unit: "حبة",
  });
  const flour = await product({
    barcode: products.flour.barcode,
    name: products.flour.name,
    price: 0,
    stock: 0,
    unit: "كغم",
    inventory_scope: "bakery",
  });
  const vat = await product({
    barcode: products.vat.barcode,
    name: products.vat.name,
    price: 1,
    stock: 0,
    unit: "حبة",
  });
  const missing = await product({
    barcode: products.missing.barcode,
    name: products.missing.name,
    price: num(products.missing.price),
    cost: 0,
    stock: 0,
    unit: "حبة",
  });
  const damaged = await product({
    barcode: products.damaged.barcode,
    name: products.damaged.name,
    price: num(products.damaged.price),
    stock: 0,
    unit: "حبة",
  });
  Object.assign(ids, {
    milk: milk.id,
    tomato: tomato.id,
    bread: bread.id,
    yogurt: yogurt.id,
    sugar: sugar.id,
    oil: oil.id,
    water: water.id,
    flour: flour.id,
    vat: vat.id,
    missing: missing.id,
    damaged: damaged.id,
  });

  async function purchase(supplierId, ref, items) {
    const draft = await must(
      await call(app, {
        method: "post",
        path: "/api/v1/purchases/invoices",
        token: admin,
        body: { supplier_id: supplierId, invoice_date: DAY, ref_text: ref, items },
      }),
      `draft ${ref}`,
      [201]
    );
    await must(
      await call(app, {
        method: "post",
        path: `/api/v1/purchases/invoices/${draft.id}/post`,
        token: admin,
        body: {},
      }),
      `post ${ref}`,
      [200]
    );
    return draft.id;
  }

  const line = (productId, quantity, total, extra = {}) => ({
    product_id: productId,
    quantity: num(quantity),
    total_cost: num(total),
    vat_rate: 0,
    ...extra,
  });

  await purchase(ids.dairy, "محاكاة-حليب", [line(ids.milk, 10, "40.00")]);
  await purchase(ids.dairy, "محاكاة-لبن", [
    line(ids.yogurt, 4, "40.00", { expiry_date: "2026-10-01" }),
    line(ids.yogurt, 6, "90.00", { expiry_date: "2026-12-01" }),
  ]);
  await purchase(ids.produce, "محاكاة-بندورة", [line(ids.tomato, 5, "15.00")]);
  await purchase(ids.produce, "محاكاة-تالف", [line(ids.damaged, 2, "4.00")]);
  await purchase(ids.produce, "محاكاة-سكر", [line(ids.sugar, 4, "8.00")]);
  await purchase(ids.produce, "محاكاة-زيت", [line(ids.oil, 2, "10.00")]);
  await purchase(ids.bakerySupplier, "محاكاة-خبز", [line(ids.bread, 20, "20.00")]);
  await purchase(ids.bakerySupplier, "محاكاة-طحين", [line(ids.flour, 5, "10.00")]);
  await purchase(ids.officeSupplier, "محاكاة-مياه", [line(ids.water, 6, "3.00")]);
  ids.vatInvoice = await purchase(ids.vatSupplier, "محاكاة-ضريبة", [
    line(ids.vat, 10, "116.00", { vat_rate: 0.16 }),
  ]);

  async function supplierBalance(id) {
    return (await db.get("SELECT balance FROM suppliers WHERE id = ?", [id])).balance;
  }
  checkMoney(results, "Dairy balance after both purchases", "170.00", await supplierBalance(ids.dairy), {
    feature: "purchases",
    screen: "الموردون / مورد الألبان التجريبي",
  });
  checkMoney(results, "Yogurt weighted-average cost", "13.00", (await db.get("SELECT cost FROM products WHERE id = ?", [ids.yogurt])).cost, {
    feature: "costing",
    screen: "المنتجات / لبن تشكيلة تجريبي",
  });

  const vatLine = await db.get(
    "SELECT line_vat, line_net, line_total FROM purchase_invoice_items WHERE product_id = ?",
    [ids.vat]
  );
  checkMoney(results, "VAT invoice supplier gross", "116.00", vatLine?.line_total, {
    feature: "purchase-vat",
    screen: "فاتورة مشتريات / محاكاة-ضريبة",
  });
  checkMoney(results, "Purchase VAT split — independent inclusive tax", "16.00", vatLine?.line_vat, {
    feature: "purchase-vat",
    screen: "فاتورة مشتريات / محاكاة-ضريبة",
  });
  checkMoney(results, "VAT inventory cost uses gross ÷ quantity", "11.60", (await db.get("SELECT cost FROM products WHERE id = ?", [ids.vat])).cost, {
    feature: "costing",
    screen: "المنتجات / حافة ضريبة تجريبية",
  });

  async function paySupplier(supplierId, amount, ref) {
    const draft = await must(
      await call(app, {
        method: "post",
        path: "/api/v1/vouchers",
        token: admin,
        body: {
          voucher_type: "payment",
          voucher_date: DAY,
          lines: [{ line_type: "cash", amount: num(amount), currency: "NIS", supplier_id: supplierId }],
        },
      }),
      `voucher ${ref}`,
      [201]
    );
    await must(
      await call(app, { method: "post", path: `/api/v1/vouchers/${draft.id}/post`, token: admin, body: {} }),
      `post voucher ${ref}`,
      [200]
    );
  }
  await paySupplier(ids.dairy, "40.00", "dairy-40");
  checkMoney(results, "Supplier partial payment", "130.00", await supplierBalance(ids.dairy), {
    feature: "vouchers",
    screen: "سند صرف / مورد الألبان التجريبي",
    detail: `Supplier partial payment: expected remaining debt 130.00; actual ${await supplierBalance(ids.dairy)}`,
  });
  await paySupplier(ids.bakerySupplier, "10.00", "bakery-10");

  const warehouses = asList(
    (await call(app, { method: "get", path: "/api/v1/warehouses", token: admin })).body
  );
  const mainWh = warehouses.find((row) => row.type === "main");
  const storeWh = warehouses.find((row) => row.type === "store");
  const milkBeforeTransfer = (await db.get("SELECT stock FROM products WHERE id = ?", [ids.milk])).stock;
  const transfer = await must(
    await call(app, {
      method: "post",
      path: "/api/v1/warehouses/transfers",
      token: admin,
      body: {
        from_warehouse_id: mainWh.id,
        to_warehouse_id: storeWh.id,
        transfer_date: DAY,
        notes: "تحويل حليب المحاكاة",
        items: [{ product_id: ids.milk, quantity: 2 }],
      },
    }),
    "transfer draft",
    [201]
  );
  await must(
    await call(app, {
      method: "post",
      path: `/api/v1/warehouses/transfers/${transfer.id}/post`,
      token: admin,
      body: {},
    }),
    "transfer post",
    [200]
  );
  checkQty(results, "Internal transfer does not change catalog stock", milkBeforeTransfer, (await db.get("SELECT stock FROM products WHERE id = ?", [ids.milk])).stock, {
    feature: "warehouses",
    screen: "المستودعات",
  });

  const milkReturn = await must(
    await call(app, {
      method: "post",
      path: "/api/v1/purchases/returns",
      token: admin,
      body: {
        supplier_id: ids.dairy,
        return_date: DAY,
        notes: "إرجاع حليبين",
        items: [{ product_id: ids.milk, unit_id: milk.piece, quantity: 2, total_cost: 8, vat_rate: 0 }],
      },
    }),
    "purchase return",
    [201]
  );
  await must(
    await call(app, {
      method: "post",
      path: `/api/v1/purchases/returns/${milkReturn.id}/post`,
      token: admin,
      body: {},
    }),
    "post purchase return",
    [200]
  );
  checkQty(results, "Purchase return reduces sellable milk", "8.000", (await db.get("SELECT stock FROM products WHERE id = ?", [ids.milk])).stock, {
    feature: "purchase-returns",
    screen: "مرتجعات الموردين",
  });
  checkMoney(results, "Dairy balance after return", "122.00", await supplierBalance(ids.dairy), {
    feature: "purchase-returns",
    screen: "الموردون / مورد الألبان التجريبي",
  });

  const count = await must(
    await call(app, {
      method: "post",
      path: "/api/v1/inventory/counts",
      token: admin,
      body: { notes: "جرد سكر المحاكاة" },
    }),
    "stock count",
    [201]
  );
  await must(
    await call(app, {
      method: "post",
      path: `/api/v1/inventory/counts/${count.id}/lines`,
      token: admin,
      body: { product_id: ids.sugar, counted_qty: 3 },
    }),
    "count line",
    [200, 201]
  );
  await must(
    await call(app, {
      method: "post",
      path: `/api/v1/inventory/counts/${count.id}/post`,
      token: admin,
      body: {},
    }),
    "post count",
    [200]
  );
  checkQty(results, "Stock count corrects sugar to 3", "3.000", (await db.get("SELECT stock FROM products WHERE id = ?", [ids.sugar])).stock, {
    feature: "stock-count",
    screen: "جرد المخزون / سكر تجريبي",
  });

  await must(
    await call(app, {
      method: "post",
      path: "/api/v1/inventory-issues",
      token: admin,
      body: {
        reason: "damaged",
        items: [{ product_id: ids.damaged, product_unit_id: damaged.piece, quantity: 1 }],
      },
    }),
    "inventory issue",
    [200, 201]
  );
  checkQty(results, "Damaged issue reduces stock by 1", "1.000", (await db.get("SELECT stock FROM products WHERE id = ?", [ids.damaged])).stock, {
    feature: "inventory-issues",
    screen: "سند إخراج بضاعة / صنف تالف تجريبي",
  });

  await must(
    await call(app, {
      method: "post",
      path: "/api/v1/inventory-receipts",
      token: admin,
      body: {
        reason: "opening",
        items: [{ product_id: ids.missing, product_unit_id: missing.piece, quantity: 2 }],
      },
    }),
    "opening receipt",
    [200, 201]
  );
  checkQty(results, "Opening receipt for the zero-cost item", "2.000", (await db.get("SELECT stock FROM products WHERE id = ?", [ids.missing])).stock, {
    feature: "inventory-receipts",
    screen: "سند إدخال بضاعة / حافة تكلفة مفقودة",
  });

  await must(
    await call(app, {
      method: "post",
      path: "/api/v1/inventory/adjustments",
      token: admin,
      body: {
        adjustment_type: "consumption",
        adjustment_date: POS,
        items: [{ product_id: ids.bread, quantity: 1 }],
        post: true,
      },
    }),
    "bakery consumption",
    [200, 201]
  );

  const rate = await call(app, {
    method: "patch",
    path: `/api/v1/payroll/cashiers/${userId.cashier1}`,
    token: admin,
    body: { hourly_rate: 25 },
  });
  pushResult(results, {
    scenario: "Cashier hourly rate snapshot source",
    feature: "payroll",
    status: rate.status === 200 ? "PASS" : "FAIL",
    expected: "200",
    actual: String(rate.status),
    classification: rate.status === 200 ? "" : "application",
    screen: "أجور الساعة والدوام",
  });
  await call(app, {
    method: "patch",
    path: `/api/v1/payroll/cashiers/${userId.cashier2}`,
    token: admin,
    body: { hourly_rate: 20 },
  });

  const laith = await must(
    await call(app, {
      method: "post",
      path: "/api/v1/employees",
      token: admin,
      body: { name: parties.employees.laith, start_on: "2026-01-01", user_id: userId.cashier1 },
    }),
    "employee laith",
    [201]
  );
  const samer = await must(
    await call(app, {
      method: "post",
      path: "/api/v1/employees",
      token: admin,
      body: { name: parties.employees.samer, start_on: "2026-01-01" },
    }),
    "employee samer",
    [201]
  );
  const baker = await must(
    await call(app, {
      method: "post",
      path: "/api/v1/employees",
      token: admin,
      body: { name: parties.employees.baker, start_on: "2026-01-01" },
    }),
    "employee baker",
    [201]
  );
  ids.laith = laith.id;
  ids.samer = samer.id;
  ids.baker = baker.id;
  const debtAccount = await must(
    await call(app, {
      method: "post",
      path: `/api/v1/employees/${ids.samer}/debt-account`,
      token: admin,
      body: {},
    }),
    "employee debt account",
    [200, 201]
  );
  ids.samerCustomer = debtAccount.customer_id || debtAccount.id;

  async function openShift(token, opening) {
    await must(
      await call(app, {
        method: "patch",
        path: "/api/v1/settings",
        token: admin,
        body: { default_opening_cash: num(opening) },
      }),
      `set opening cash ${opening}`,
      [200]
    );
    const res = await must(
      await call(app, {
        method: "post",
        path: "/api/v1/shifts/start",
        token,
        body: {},
      }),
      `open shift ${opening}`,
      [201]
    );
    const opened = res.opening_cash ?? res.shift?.opening_cash;
    checkMoney(results, `Shift opens with configured cash ${opening}`, opening, opened, {
      feature: "shifts",
      screen: "الورديات",
      detail: `The shift API uses الإعدادات / النقد الافتتاحي, not a body amount. Expected ${opening}.`,
    });
    return res.shift_id || res.id;
  }

  async function checkout(token, body, label, statuses = [201]) {
    const res = await call(app, { method: "post", path: "/api/v1/checkout", token, body });
    if (!statuses.includes(res.status)) throw httpFail(res, label);
    return { status: res.status, data: unwrap(res.body) };
  }

  ids.shift1 = await openShift(cashier1, "200.00");
  const flourReject = await call(app, {
    method: "post",
    path: "/api/v1/checkout",
    token: cashier1,
    body: {
      idempotency_key: "demo-flour-reject",
      items: [{ product_id: ids.flour, quantity: 1, price: 0, unit_id: flour.kg || flour.piece }],
      payment_method: "cash",
    },
  });
  const flourStock = (await db.get("SELECT stock FROM products WHERE id = ?", [ids.flour])).stock;
  pushResult(results, {
    scenario: "Bakery supply cannot be sold at POS",
    feature: "bakery-supplies",
    status: flourReject.status === 409 && num(flourStock) === 5 ? "PASS" : "FAIL",
    expected: "HTTP 409 BAKERY_SUPPLY_NOT_SELLABLE and stock 5.000",
    actual: `HTTP ${flourReject.status} stock ${flourStock}`,
    classification: flourReject.status === 409 && num(flourStock) === 5 ? "" : "application",
    screen: "نقطة البيع",
  });

  async function savedTotal(key) {
    const row = await db.get("SELECT id, total, discount FROM transactions WHERE idempotency_key = ?", [key]);
    return row;
  }

  tx.milk = await checkout(cashier1, {
    idempotency_key: "demo-milk-cash",
    items: [{ product_id: ids.milk, quantity: 3, price: 8, unit_id: milk.piece }],
    payment_method: "cash",
  }, "milk cash");
  checkMoney(results, "Piece sale — 3 milk at 8", "24.00", (await savedTotal("demo-milk-cash")).total, {
    feature: "pos",
    screen: "نقطة البيع / حليب طيرة تجريبي",
  });

  tx.tomato = await checkout(cashier1, {
    idempotency_key: "demo-tomato",
    items: [{
      product_id: ids.tomato,
      quantity: 1.25,
      price: 6,
      unit_id: tomato.kg,
      scanned_barcode: products.tomato.weightBarcode,
    }],
    payment_method: "cash",
  }, "tomato weight");
  checkMoney(results, "Weighed sale rounds 7.50 to a whole shekel", "8.00", (await savedTotal("demo-tomato")).total, {
    feature: "weight",
    screen: "نقطة البيع / بندورة تجريبية",
    detail: "1.250 kg × 6.00 = 7.50, and the documented weighed-line rule charges 8.",
  });

  await checkout(cashier1, {
    idempotency_key: "demo-bread-full",
    items: [{ product_id: ids.bread, quantity: 4, price: 3, unit_id: bread.piece }],
    payment_method: "cash",
  }, "bread before promo");
  checkMoney(results, "Bread sale before the promotion", "12.00", (await savedTotal("demo-bread-full")).total, {
    feature: "pos",
    screen: "نقطة البيع / خبز طابون تجريبي",
  });

  await must(
    await call(app, {
      method: "post",
      path: "/api/v1/marketing/promotions",
      token: admin,
      body: {
        name: "خصم خبز المحاكاة 10%",
        offer_type: "percentage",
        product_id: ids.bread,
        product_unit_id: bread.piece,
        discount_value: 10,
        start_date: "2026-01-01",
        end_date: "2026-12-31",
        active: true,
      },
    }),
    "promotion",
    [201]
  );

  await checkout(cashier1, {
    idempotency_key: "demo-yogurt-visa",
    items: [{ product_id: ids.yogurt, quantity: 2, price: 18, unit_id: yogurt.piece }],
    payment_method: "visa",
  }, "yogurt visa");
  checkMoney(results, "Visa sale — 2 yogurt at 18", "36.00", (await savedTotal("demo-yogurt-visa")).total, {
    feature: "pos",
    screen: "نقطة البيع",
  });

  await checkout(cashier1, {
    idempotency_key: "demo-milk-mixed",
    items: [{ product_id: ids.milk, quantity: 1, price: 8, unit_id: milk.piece }],
    payments: [
      { method: "cash", amount: 3 },
      { method: "visa", amount: 5 },
    ],
  }, "mixed milk");
  checkMoney(results, "Mixed cash and Visa sale", "8.00", (await savedTotal("demo-milk-mixed")).total, {
    feature: "pos",
    screen: "نقطة البيع / حليب طيرة تجريبي",
  });

  await checkout(cashier1, {
    idempotency_key: "demo-bread-promo",
    items: [{ product_id: ids.bread, quantity: 2, price: 3, unit_id: bread.piece }],
    payment_method: "cash",
  }, "promo bread");
  checkMoney(results, "Ten percent bread promotion", "5.00", (await savedTotal("demo-bread-promo")).total, {
    feature: "promotions",
    screen: "التسويق / خبز طابون تجريبي",
    detail: "2 × 3.00 = 6.00, discount 0.60, calculated 5.40, rounding −0.40, payable 5.00.",
  });

  const yogurtDebt = await checkout(cashier1, {
    idempotency_key: "demo-yogurt-zimma",
    items: [{ product_id: ids.yogurt, quantity: 2, price: 18, unit_id: yogurt.piece }],
    payment_method: "on_account",
    customer_id: ids.ahmad,
  }, "ahmad zimma", [202]);
  const yogurtReq = yogurtDebt.data.request_id || yogurtDebt.data.id;
  await must(
    await call(app, {
      method: "put",
      path: `/api/v1/on-account-requests/${yogurtReq}`,
      token: admin,
      body: { status: "approved" },
    }),
    "approve ahmad yogurt",
    [200]
  );
  checkMoney(results, "Approved customer debt — yogurt", "36.00", (await db.get("SELECT balance FROM customers WHERE id = ?", [ids.ahmad])).balance, {
    feature: "on-account",
    screen: "موافقات الذمة / أحمد الذمة التجريبي",
  });

  const employeeDebt = await checkout(cashier1, {
    idempotency_key: "demo-milk-employee",
    items: [{ product_id: ids.milk, quantity: 1, price: 8, unit_id: milk.piece }],
    payment_method: "on_account",
    employee_id: ids.samer,
  }, "employee zimma", [202]);
  const employeeReq = employeeDebt.data.request_id || employeeDebt.data.id;
  await must(
    await call(app, {
      method: "put",
      path: `/api/v1/on-account-requests/${employeeReq}`,
      token: admin,
      body: { status: "approved" },
    }),
    "approve employee debt",
    [200]
  );
  ids.employeeTx = (
    await db.get("SELECT transaction_id FROM on_account_requests WHERE id = ?", [employeeReq])
  )?.transaction_id;

  const partial = await checkout(cashier1, {
    idempotency_key: "demo-bread-partial",
    items: [{ product_id: ids.bread, quantity: 2, price: 3, unit_id: bread.piece }],
    payments: [
      { method: "cash", amount: 2 },
      { method: "on_account", amount: 3 },
    ],
    customer_id: ids.ahmad,
  }, "partial zimma", [202]);
  const partialReq = partial.data.request_id || partial.data.id;
  await must(
    await call(app, {
      method: "put",
      path: `/api/v1/on-account-requests/${partialReq}`,
      token: admin,
      body: { status: "approved" },
    }),
    "approve partial zimma",
    [200]
  );
  checkMoney(results, "Customer debt after yogurt and partial bread", "39.00", (await db.get("SELECT balance FROM customers WHERE id = ?", [ids.ahmad])).balance, {
    feature: "on-account",
    screen: "العملاء / أحمد الذمة التجريبي",
  });

  const rejected = await checkout(cashier1, {
    idempotency_key: "demo-reject-zimma",
    items: [{ product_id: ids.bread, quantity: 1, price: 3, unit_id: bread.piece }],
    payment_method: "on_account",
    customer_id: ids.reject,
  }, "reject zimma", [202]);
  const breadStockPending = (await db.get("SELECT stock FROM products WHERE id = ?", [ids.bread])).stock;
  await must(
    await call(app, {
      method: "put",
      path: `/api/v1/on-account-requests/${rejected.data.request_id || rejected.data.id}`,
      token: admin,
      body: { status: "rejected", review_notes: "مرفوض في المحاكاة" },
    }),
    "reject zimma",
    [200]
  );
  checkQty(results, "Rejected debt does not change bread stock", breadStockPending, (await db.get("SELECT stock FROM products WHERE id = ?", [ids.bread])).stock, {
    feature: "on-account",
    screen: "موافقات الذمة / رفض الذمة التجريبي",
  });
  checkMoney(results, "Rejected customer balance stays zero", "0.00", (await db.get("SELECT balance FROM customers WHERE id = ?", [ids.reject])).balance, {
    feature: "on-account",
    screen: "العملاء / رفض الذمة التجريبي",
  });

  const laylaStockBefore = (await db.get("SELECT stock FROM products WHERE id = ?", [ids.yogurt])).stock;
  const laylaSale = await call(app, {
    method: "post",
    path: "/api/v1/checkout",
    token: cashier1,
    body: {
      idempotency_key: "demo-layla-limit",
      items: [{ product_id: ids.yogurt, quantity: 1, price: 18, unit_id: yogurt.piece }],
      payment_method: "on_account",
      customer_id: ids.layla,
    },
  });
  if (laylaSale.status === 202) {
    const approve = await call(app, {
      method: "put",
      path: `/api/v1/on-account-requests/${unwrap(laylaSale.body).request_id || unwrap(laylaSale.body).id}`,
      token: admin,
      body: { status: "approved" },
    });
    const laylaBalance = (await db.get("SELECT balance FROM customers WHERE id = ?", [ids.layla])).balance;
    const laylaStock = (await db.get("SELECT stock FROM products WHERE id = ?", [ids.yogurt])).stock;
    const blocked = approve.status === 400 && num(laylaBalance) === 0 && num(laylaStock) === num(laylaStockBefore);
    pushResult(results, {
      scenario: "Credit limit blocks a completed debt sale",
      feature: "credit-limit",
      status: blocked ? "PASS" : "FAIL",
      expected: "approval 400, balance 0.00, stock unchanged",
      actual: `approval ${approve.status}, balance ${laylaBalance}, stock ${laylaStock}`,
      classification: blocked ? "" : "application",
      screen: "موافقات الذمة / ليلى الحد التجريبي",
      detail: blocked
        ? "Checkout queued the request and approval rejected it. Stock and balance stayed unchanged."
        : `Credit limit: expected no completed sale; approval HTTP ${approve.status}, balance ${laylaBalance}`,
    });
  } else {
    const laylaBalance = (await db.get("SELECT balance FROM customers WHERE id = ?", [ids.layla])).balance;
    const laylaStock = (await db.get("SELECT stock FROM products WHERE id = ?", [ids.yogurt])).stock;
    const blocked = laylaSale.status === 400 && num(laylaBalance) === 0 && num(laylaStock) === num(laylaStockBefore);
    pushResult(results, {
      scenario: "Credit limit blocks a completed debt sale",
      feature: "credit-limit",
      status: blocked ? "PASS" : "FAIL",
      expected: "checkout 400, balance 0.00, stock unchanged",
      actual: `checkout ${laylaSale.status}, balance ${laylaBalance}, stock ${laylaStock}`,
      classification: blocked ? "" : "application",
      screen: "نقطة البيع / ليلى الحد التجريبي",
    });
  }
  const laylaRequest = await db.get(
    "SELECT status FROM on_account_requests WHERE customer_id = ? ORDER BY id DESC LIMIT 1",
    [ids.layla]
  );
    pushResult(results, {
      scenario: "Over-limit debt stays pending until an explicit override",
      feature: "credit-limit",
      status: laylaRequest?.status === "pending" ? "PASS" : "FAIL",
      expected: "pending",
      actual: String(laylaRequest?.status ?? "none"),
      classification: laylaRequest?.status === "pending" ? "" : "application",
      screen: "موافقات الذمة / ليلى الحد التجريبي",
      detail: "Ordinary approval does not post the sale and does not raise the permanent limit.",
    });

  const advance = await must(
    await call(app, {
      method: "post",
      path: "/api/v1/advance-requests",
      token: cashier1,
      body: { employee_id: ids.laith, amount: 20, notes: "سلفة محاكاة" },
    }),
    "advance request",
    [201]
  );
  await must(
    await call(app, {
      method: "put",
      path: `/api/v1/advance-requests/${advance.request_id || advance.id}`,
      token: admin,
      body: { status: "approved", occurred_on: POS },
    }),
    "approve advance",
    [200]
  );
  const advanceExpense = await db.get(
    `SELECT amount, paid_on FROM operating_expenses
     WHERE source = 'employee_payment' AND amount = 20
     ORDER BY id DESC LIMIT 1`
  );
  checkMoney(results, "Approved advance creates one 20 expense", "20.00", advanceExpense?.amount, {
    feature: "advances",
    screen: "موافقات السلف / ليث الصندوق التجريبي",
  });
  pushResult(results, {
    scenario: "Advance expense date follows the shift day",
    feature: "advances",
    status: advanceExpense?.paid_on === POS ? "PASS" : "FAIL",
    expected: POS,
    actual: String(advanceExpense?.paid_on ?? ""),
    classification: advanceExpense?.paid_on === POS ? "" : "application",
    screen: "المصروفات",
    detail:
      advanceExpense?.paid_on === POS
        ? "Advance expense is dated 2026-09-15."
        : `Advance approval has no business date and stamped ${advanceExpense?.paid_on} instead of the 2026-09-15 shift.`,
  });

  async function refund(key, productId, quantity, method, label) {
    const original = await savedTotal(key);
    const row = await must(
      await call(app, {
        method: "post",
        path: "/api/v1/refund-requests",
        token: cashier1,
        body: {
          original_transaction_id: original.id,
          lines: [{ product_id: productId, quantity }],
          reason: label,
          payment_method: method,
        },
      }),
      label,
      [201]
    );
    await must(
      await call(app, {
        method: "put",
        path: `/api/v1/refund-requests/${row.id || row.request_id}`,
        token: admin,
        body: { status: "approved" },
      }),
      `approve ${label}`,
      [200]
    );
  }
  await refund("demo-milk-cash", ids.milk, 1, "cash", "partial milk refund");
  await refund("demo-yogurt-visa", ids.yogurt, 2, "visa", "full yogurt refund");

  const suspended = await call(app, {
    method: "post",
    path: "/api/v1/suspended-sales",
    token: cashier1,
    body: {
      note: "سلة معلقة — سكر تجريبي",
      items: [{ product_id: ids.sugar, quantity: 1, price: 4, unit_id: sugar.piece }],
    },
  });
  pushResult(results, {
    scenario: "Suspended sale does not move stock",
    feature: "suspended-sales",
    status: suspended.status === 201 && num((await db.get("SELECT stock FROM products WHERE id = ?", [ids.sugar])).stock) === 3 ? "PASS" : "FAIL",
    expected: "201 and sugar stock 3.000",
    actual: `HTTP ${suspended.status}`,
    classification: suspended.status === 201 ? "" : "application",
    screen: "نقطة البيع / البيع المعلق",
  });

  const tomatoRow = await savedTotal("demo-tomato");
  const receipt = await call(app, {
    method: "post",
    path: "/api/v1/print-receipt",
    token: cashier1,
    body: { transaction_id: tomatoRow.id },
  });
  const receiptData = unwrap(receipt.body) || {};
  const html = receiptData.receipt_html || receipt.body?.receipt_html || "";
  fs.mkdirSync(path.join(reportDir, "receipts"), { recursive: true });
  if (html) fs.writeFileSync(path.join(reportDir, "receipts", "tomato.html"), html, "utf8");
  const receiptOk = receipt.status === 200 && html.includes("بندورة") && /8(\.00)?/.test(html);
  pushResult(results, {
    scenario: "Receipt reprint shows the weighed total",
    feature: "print",
    status: receiptOk ? "PASS" : "FAIL",
    expected: "HTML contains بندورة and 8",
    actual: receipt.status === 200 ? `HTML length ${html.length}` : snippet(receipt.body),
    classification: receiptOk ? "" : "application",
    screen: "إعادة طباعة الإيصال",
  });
  const silent = await call(app, {
    method: "post",
    path: "/api/v1/print-receipt/silent",
    token: cashier1,
    body: { transaction_id: tomatoRow.id },
  });
  const silentData = unwrap(silent.body) || silent.body || {};
  pushResult(results, {
    scenario: "Silent print is captured without a physical printer",
    feature: "print",
    status: silent.status === 200 && (silentData.testMode || silent.body?.testMode) ? "PASS" : "FAIL",
    expected: "testMode save",
    actual: snippet(silent.body),
    classification: silent.status === 200 ? "" : "application",
    screen: "إيصال",
  });

  await must(
    await call(app, { method: "post", path: `/api/v1/shifts/${ids.shift1}/end`, token: cashier1, body: {} }),
    "end cashier1",
    [200]
  );
  const shift1Row = await db.get("SELECT expected_cash FROM cashier_shifts WHERE id = ?", [ids.shift1]);
  checkMoney(results, "Cashier 1 expected drawer", "226.00", shift1Row?.expected_cash, {
    feature: "shifts",
    screen: "الورديات / cashier1",
  });
  await must(
    await call(app, {
      method: "post",
      path: `/api/v1/shifts/${ids.shift1}/reconcile`,
      token: admin,
      body: { closing_cash: 226.4 },
    }),
    "reconcile cashier1",
    [200, 202]
  );

  ids.shift2 = await openShift(cashier2, "50.00");
  await checkout(cashier2, {
    idempotency_key: "demo-oil",
    items: [{ product_id: ids.oil, quantity: 1, price: 9, unit_id: oil.piece }],
    payment_method: "cash",
  }, "oil");
  checkMoney(results, "Second cashier oil sale", "9.00", (await savedTotal("demo-oil")).total, {
    feature: "shifts",
    screen: "نقطة البيع / زيت تجريبي",
  });
  await must(
    await call(app, { method: "post", path: `/api/v1/shifts/${ids.shift2}/end`, token: cashier2, body: {} }),
    "end cashier2",
    [200]
  );
  checkMoney(results, "Cashier 2 expected drawer", "59.00", (await db.get("SELECT expected_cash FROM cashier_shifts WHERE id = ?", [ids.shift2])).expected_cash, {
    feature: "shifts",
    screen: "الورديات / cashier2",
  });
  await must(
    await call(app, {
      method: "post",
      path: `/api/v1/shifts/${ids.shift2}/reconcile`,
      token: admin,
      body: { closing_cash: 59 },
    }),
    "reconcile cashier2",
    [200, 202]
  );

  ids.edgeShift = await openShift(cashier1, "0.00");
  await checkout(cashier1, {
    idempotency_key: "demo-edge-cost",
    items: [{ product_id: ids.missing, quantity: 1, price: 7, unit_id: missing.piece }],
    payment_method: "cash",
  }, "missing cost");
  await must(
    await call(app, { method: "post", path: `/api/v1/shifts/${ids.edgeShift}/end`, token: cashier1, body: {} }),
    "end edge shift",
    [200]
  );
  await must(
    await call(app, {
      method: "post",
      path: `/api/v1/shifts/${ids.edgeShift}/reconcile`,
      token: admin,
      body: { closing_cash: 7 },
    }),
    "reconcile edge",
    [200, 202]
  );

  const shifts = expected.anchor.shifts;
  const cutoffRow = await db.get(
    "SELECT value FROM app_settings WHERE key = 'business_day_cutoff_hour'"
  );
  const cutoffHour = cutoffRow?.value ?? 0;
  for (const [id, bounds] of [
    [ids.shift1, shifts.cashier1],
    [ids.shift2, shifts.cashier2],
    [ids.edgeShift, shifts.edge],
  ]) {
    await db.run(
      "UPDATE cashier_shifts SET start_time = ?, end_time = ?, business_day = ? WHERE id = ?",
      [bounds.start, bounds.end, businessDayFromTimestamp(bounds.start, cutoffHour), id]
    );
  }

  const expenseCategory = await db.get("SELECT id FROM expense_categories WHERE name = 'electricity'");
  const expenseCountBefore = (await db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n;
  const denied = await call(app, {
    method: "post",
    path: "/api/v1/expenses",
    token: finance,
    body: {
      category_id: expenseCategory.id,
      amount: 30,
      paid_on: POS,
      payment_method: "cash",
      reference_note: "رفض محاسب المالية",
    },
  });
  const expenseCountAfterDeny = (await db.get("SELECT COUNT(*) AS n FROM operating_expenses")).n;
  pushResult(results, {
    scenario: "Finance-only accountant cannot post an expense",
    feature: "permissions",
    status: denied.status === 403 && expenseCountAfterDeny === expenseCountBefore ? "PASS" : "FAIL",
    expected: "403 and no new expense",
    actual: `HTTP ${denied.status}, count ${expenseCountBefore} → ${expenseCountAfterDeny}`,
    classification: denied.status === 403 ? "" : "application",
    screen: "المصروفات",
  });
  const overviewOk = await call(app, {
    method: "get",
    path: "/api/v1/finance/overview",
    token: finance,
    query: { from: POS, to: POS },
  });
  pushResult(results, {
    scenario: "Finance-only accountant can read the finance overview",
    feature: "permissions",
    status: overviewOk.status === 200 ? "PASS" : "FAIL",
    expected: "200",
    actual: String(overviewOk.status),
    classification: overviewOk.status === 200 ? "" : "application",
    screen: "المراقبة المالية",
  });
  await must(
    await call(app, {
      method: "post",
      path: "/api/v1/expenses",
      token: admin,
      body: {
        category_id: expenseCategory.id,
        amount: 30,
        paid_on: POS,
        payment_method: "cash",
        reference_note: "كهرباء المحاكاة",
      },
    }),
    "electricity",
    [201]
  );

  const receiptVoucher = await must(
    await call(app, {
      method: "post",
      path: "/api/v1/vouchers",
      token: admin,
      body: {
        voucher_type: "receipt",
        voucher_date: POS,
        lines: [{ line_type: "cash", amount: 15, currency: "NIS", customer_id: ids.ahmad }],
      },
    }),
    "customer receipt",
    [201]
  );
  await must(
    await call(app, {
      method: "post",
      path: `/api/v1/vouchers/${receiptVoucher.id}/post`,
      token: admin,
      body: {},
    }),
    "post customer receipt",
    [200]
  );
  checkMoney(results, "Customer receipt leaves Ahmad at 24.00", "24.00", (await db.get("SELECT balance FROM customers WHERE id = ?", [ids.ahmad])).balance, {
    feature: "vouchers",
    screen: "سند قبض / أحمد الذمة التجريبي",
  });

  const invoice = await must(
    await call(app, {
      method: "post",
      path: "/api/v1/sales/invoices",
      token: admin,
      body: {
        customer_id: ids.officeCustomer,
        invoice_date: POS,
        items: [{ product_id: ids.water, quantity: 2, total_price: 4 }],
      },
    }),
    "sales invoice",
    [201]
  );
  await must(
    await call(app, {
      method: "post",
      path: `/api/v1/sales/invoices/${invoice.id}/post`,
      token: admin,
      body: { payment_method: "cash" },
    }),
    "post sales invoice",
    [200]
  );
  checkMoney(results, "Office sales invoice total", "4.00", (await db.get("SELECT total FROM sales_invoices WHERE id = ?", [invoice.id])).total, {
    feature: "sales-invoices",
    screen: "فاتورة مبيعات / مياه مكتب تجريبية",
  });
  checkMoney(results, "Cash office invoice does not create customer debt", "0.00", (await db.get("SELECT balance FROM customers WHERE id = ?", [ids.officeCustomer])).balance, {
    feature: "sales-invoices",
    screen: "العملاء / مكتب المبيعات التجريبي",
  });

  const yogurtTx = await savedTotal("demo-yogurt-zimma");
  const ahmadTx = yogurtTx?.id
    ? yogurtTx
    : await db.get(
        "SELECT id FROM transactions WHERE customer_id = ? ORDER BY id ASC LIMIT 1",
        [ids.ahmad]
      );
  if (ahmadTx?.id) {
    const delivery = await call(app, {
      method: "post",
      path: "/api/v1/deliveries/sales",
      token: admin,
      body: {
        transaction_id: ahmadTx.id,
        customer_id: ids.ahmad,
        driver: "سائق المحاكاة",
        address: "الطيرة",
        delivery_date: POS,
        notes: "توصيل ذمة أحمد",
      },
    });
    if (delivery.status === 201) {
      await call(app, {
        method: "patch",
        path: `/api/v1/deliveries/sales/${unwrap(delivery.body).id}/status`,
        token: admin,
        body: { status: "delivered" },
      });
    }
    pushResult(results, {
      scenario: "Delivery record for Ahmad's debt sale",
      feature: "deliveries",
      status: delivery.status === 201 ? "PASS" : "FAIL",
      expected: "201",
      actual: String(delivery.status),
      classification: delivery.status === 201 ? "" : "application",
      screen: "التوصيل",
    });
  }

  await call(app, {
    method: "post",
    path: "/api/v1/attendance/manual-punch",
    token: admin,
    body: { user_id: userId["bakery.demo"], punch_time: "2026-09-15 08:00:00", type: "in" },
  });
  await call(app, {
    method: "post",
    path: "/api/v1/attendance/manual-punch",
    token: admin,
    body: { user_id: userId["bakery.demo"], punch_time: "2026-09-15 16:00:00", type: "out" },
  });
  const attendance = unwrap(
    (
      await call(app, {
        method: "get",
        path: "/api/v1/attendance/report",
        token: admin,
        query: { date_from: POS, date_to: POS },
      })
    ).body
  );
  const bakerRow = (attendance?.employees || []).find((row) => row.username === "bakery.demo");
  checkQty(results, "Bakery employee punch hours", "8.000", bakerRow?.total_hours, {
    feature: "attendance",
    screen: "الدوام / bakery.demo",
  });
  checkMoney(results, "Bakery employee punch pay", "120.00", bakerRow?.total_pay, {
    feature: "attendance",
    screen: "الدوام / bakery.demo",
  });

  const payroll = unwrap(
    (
      await call(app, {
        method: "get",
        path: "/api/v1/payroll/report",
        token: admin,
        query: { date_from: POS, date_to: POS },
      })
    ).body
  );
  const pay1 = (payroll?.employees || []).find((row) => row.username === "cashier1");
  const pay2 = (payroll?.employees || []).find((row) => row.username === "cashier2");
  checkMoney(results, "Cashier 1 eight-hour snapshot pay", "200.00", pay1?.total_pay, {
    feature: "payroll",
    screen: "أجور الساعة والدوام / cashier1",
  });
  checkQty(results, "Cashier 1 hours on 15 Sep", "8.000", pay1?.total_hours, {
    feature: "payroll",
    screen: "أجور الساعة والدوام / cashier1",
  });
  checkMoney(results, "Cashier 2 four-hour snapshot pay", "80.00", pay2?.total_pay, {
    feature: "payroll",
    screen: "أجور الساعة والدوام / cashier2",
  });
  const snapshot = await db.get("SELECT hourly_rate_snapshot FROM cashier_shifts WHERE id = ?", [ids.shift1]);
  checkMoney(results, "Cashier 1 rate snapshot is stored on the shift", "25.00", snapshot?.hourly_rate_snapshot, {
    feature: "payroll",
    screen: "الورديات",
  });

  const samerPayout = await call(app, {
    method: "post",
    path: `/api/v1/employees/${ids.samer}/payroll-payouts`,
    token: admin,
    body: {
      period_from: POS,
      period_to: POS,
      occurred_on: POS,
      salary_before_deductions: 300,
      cash_paid: 292,
      payment_method: "transfer",
      deductions: [{ kind: "debt", source_type: "pos_sale", source_id: ids.employeeTx, amount: 8 }],
      idempotency_key: "demo-samer-payroll",
    },
  });
  const samerDeducted = num(unwrap(samerPayout.body)?.breakdown?.product_debt_deducted);
  pushResult(results, {
    scenario: "Non-cashier payroll deducts the employee debt once",
    feature: "payroll",
    status: samerPayout.status === 201 && samerDeducted === 8 ? "PASS" : "FAIL",
    expected: "201 and product_debt_deducted 8.00",
    actual: `HTTP ${samerPayout.status}, deducted ${samerDeducted}`,
    classification: samerPayout.status === 201 && samerDeducted === 8 ? "" : "application",
    screen: "رواتب الموظفين / سامر الرفوف التجريبي",
    detail:
      samerPayout.status === 201 && samerDeducted === 8
        ? "The 15 Sep payout deducted the 8.00 employee debt."
        : "Payroll dates the debt from transactions.created_at, not the shift business day, so a 15 Sep payout does not see a sale inserted on the real clock.",
  });
  const samerAgain = await call(app, {
    method: "post",
    path: `/api/v1/employees/${ids.samer}/payroll-payouts`,
    token: admin,
    body: {
      period_from: POS,
      period_to: POS,
      occurred_on: POS,
      salary_before_deductions: 300,
      cash_paid: 292,
      payment_method: "transfer",
      deductions: [{ kind: "debt", source_type: "pos_sale", source_id: ids.employeeTx, amount: 8 }],
      idempotency_key: "demo-samer-payroll-again",
    },
  });
  const samerCustomerBalance = (
    await db.get("SELECT balance FROM customers WHERE id = ?", [ids.samerCustomer])
  )?.balance;
  const secondDeducted = unwrap(samerAgain.body)?.breakdown?.product_debt_deducted;
  const salaryExpenses = await db.get("SELECT COUNT(*) AS n FROM operating_expenses WHERE amount = 292");
  const deductedOnce =
    num(samerCustomerBalance) === 0 &&
    samerAgain.status >= 400 &&
    samerAgain.status < 500 &&
    (secondDeducted == null || num(secondDeducted) === 0) &&
    Number(salaryExpenses?.n) === 1;
  pushResult(results, {
    scenario: "Repeating the settled September salary does not pay it again",
    feature: "payroll",
    status: deductedOnce ? "PASS" : "FAIL",
    expected: "4xx, debt balance 0.00, one 292.00 salary expense",
    actual: `HTTP ${samerAgain.status}, second deduction ${secondDeducted ?? 0}, balance ${samerCustomerBalance}, salary expenses ${salaryExpenses?.n}`,
    classification: deductedOnce ? "" : "application",
    screen: "رواتب الموظفين / سامر الرفوف التجريبي",
  });

  const laithLedger = await db.get(
    "SELECT id FROM employee_ledger_entries WHERE employee_id = ? AND purpose = 'salary_advance'",
    [ids.laith]
  );
  const laithPayout = await call(app, {
    method: "post",
    path: `/api/v1/employees/${ids.laith}/payroll-payouts`,
    token: admin,
    body: {
      period_from: POS,
      period_to: POS,
      occurred_on: POS,
      salary_before_deductions: 200,
      cash_paid: 180,
      payment_method: "transfer",
      deductions: [{ kind: "advance", source_type: "ledger_entry", source_id: laithLedger?.id, amount: 20 }],
      idempotency_key: "demo-laith-payroll",
    },
  });
  const laithDeducted = num(unwrap(laithPayout.body)?.breakdown?.advance_deducted);
  pushResult(results, {
    scenario: "Cashier payroll settles the 20 advance once",
    feature: "payroll",
    status: laithPayout.status === 201 && laithDeducted === 20 ? "PASS" : "FAIL",
    expected: "201 and advance_deducted 20.00",
    actual: `HTTP ${laithPayout.status}, deducted ${laithDeducted}`,
    classification: laithPayout.status === 201 && laithDeducted === 20 ? "" : "application",
    screen: "رواتب الموظفين / ليث الصندوق التجريبي",
    detail:
      laithPayout.status === 201 && laithDeducted === 20
        ? "The 15 Sep payroll deducted the 20.00 advance."
        : "The advance expense is stamped on the real clock, so the 15 Sep payroll does not deduct it.",
  });
  const advanceRows = await db.get(
    "SELECT COUNT(*) AS n FROM operating_expenses WHERE source = 'employee_payment' AND amount = 20"
  );
  pushResult(results, {
    scenario: "Advance expense is not posted a second time at payroll",
    feature: "payroll",
    status: Number(advanceRows?.n) === 1 ? "PASS" : "FAIL",
    expected: "1",
    actual: String(advanceRows?.n),
    classification: Number(advanceRows?.n) === 1 ? "" : "application",
    screen: "المصروفات",
  });

  await call(app, {
    method: "post",
    path: `/api/v1/employees/${ids.baker}/payroll-payouts`,
    token: admin,
    body: {
      period_from: POS,
      period_to: POS,
      occurred_on: POS,
      salary_before_deductions: 120,
      cash_paid: 120,
      payment_method: "transfer",
      deductions: [],
      idempotency_key: "demo-baker-payroll",
    },
  });

  const bank = await must(
    await call(app, {
      method: "post",
      path: "/api/v1/banks/accounts",
      token: admin,
      body: { name: "حساب بنك المحاكاة", bank_name: "بنك تجريبي", account_no: "000-DEMO", currency: "NIS" },
    }),
    "bank account",
    [201]
  );
  const check = await must(
    await call(app, {
      method: "post",
      path: "/api/v1/banks/checks",
      token: admin,
      body: {
        check_type: "received",
        check_no: "DEMO-100",
        bank_name: "بنك تجريبي",
        amount: 10,
        currency: "NIS",
        due_date: "2026-10-01",
        customer_id: ids.ahmad,
        bank_account_id: bank.id,
        notes: "شيك ذمة لم يُحصَّل",
      },
    }),
    "received check",
    [201]
  );
  checkMoney(results, "Uncollected check does not change Ahmad's debt", "24.00", (await db.get("SELECT balance FROM customers WHERE id = ?", [ids.ahmad])).balance, {
    feature: "banks",
    screen: "البنوك / شيك DEMO-100",
  });
  pushResult(results, {
    scenario: "Received check is stored pending",
    feature: "banks",
    status: check.status === "pending" || check.status == null ? "PASS" : "FAIL",
    expected: "pending",
    actual: String(check.status),
    classification: check.status === "pending" || check.status == null ? "" : "application",
    screen: "البنوك",
  });
  const currencies = unwrap(
    (await call(app, { method: "get", path: "/api/v1/currencies/all", token: admin })).body
  );
  const nis = (currencies?.currencies || []).find((row) => row.code === "NIS");
  checkMoney(results, "NIS rate stays 1.00", "1.00", nis?.exchange_rate_to_nis, {
    feature: "currencies",
    screen: "الإعدادات / العملات",
  });

  const breadBeforeHalf = (await db.get("SELECT stock FROM products WHERE id = ?", [ids.bread])).stock;
  const halfPiece = await call(app, {
    method: "post",
    path: "/api/v1/checkout",
    token: cashier1,
    body: {
      idempotency_key: "demo-half-piece",
      items: [{ product_id: ids.bread, quantity: 0.5, price: 3, unit_id: bread.piece }],
      payment_method: "cash",
    },
  });
  const breadAfterHalf = (await db.get("SELECT stock FROM products WHERE id = ?", [ids.bread])).stock;
  pushResult(results, {
    scenario: "Half a piece is rejected and stock stays unchanged",
    feature: "pos",
    status: halfPiece.status === 400 && num(breadAfterHalf) === num(breadBeforeHalf) ? "PASS" : "FAIL",
    expected: "400 and stock unchanged",
    actual: `${halfPiece.status} / stock ${breadAfterHalf}`,
    classification: halfPiece.status === 400 && num(breadAfterHalf) === num(breadBeforeHalf) ? "" : "application",
    screen: "نقطة البيع / خبز طابون تجريبي",
  });

  const promoSale = await db.get(
    "SELECT id, subtotal, discount, total FROM transactions WHERE idempotency_key = ?",
    ["demo-bread-promo"]
  );
  const promoReceipt = await call(app, {
    method: "get",
    path: `/api/v1/shifts/transactions/${promoSale?.id}/receipt`,
    token: admin,
  });
  const promoPrinted = `${unwrap(promoReceipt.body)?.receipt_text || ""}\n${unwrap(promoReceipt.body)?.receipt_html || ""}`;
  pushResult(results, {
    scenario: "Reprint shows subtotal, discount, and amount due",
    feature: "receipts",
    status:
      promoReceipt.status === 200 &&
      promoPrinted.includes("6.00") &&
      promoPrinted.includes("تقريب") &&
      promoPrinted.includes("-0.40") &&
      promoPrinted.includes("5.00") &&
      /خصم/.test(promoPrinted)
        ? "PASS"
        : "FAIL",
    expected: "6.00, خصم 0.60, تقريب -0.40, due 5.00",
    actual: promoReceipt.status === 200 ? "receipt text" : String(promoReceipt.status),
    classification: promoReceipt.status === 200 && /خصم/.test(promoPrinted) ? "" : "application",
    screen: "إعادة طباعة إيصال خبز العرض",
  });
  const breadRounding = await db.get(
    `SELECT ROUND(SUM(ti.line_net), 2) AS lines,
            ROUND(SUM(t.rounding_adjustment), 2) AS adjustment,
            ROUND(SUM(t.total), 2) AS due
       FROM transactions t
       JOIN transaction_items ti ON ti.transaction_id = t.id
      WHERE t.idempotency_key IN ('demo-bread-promo', 'demo-bread-partial')`
  );
  pushResult(results, {
    scenario: "Bread item revenue plus rounding equals the payable totals",
    feature: "pos",
    status:
      num(breadRounding?.lines) === 10.8 &&
      num(breadRounding?.adjustment) === -0.8 &&
      num(breadRounding?.due) === 10
        ? "PASS"
        : "FAIL",
    expected: "lines 10.80 + adjustment -0.80 = due 10.00",
    actual: `lines ${breadRounding?.lines}, adjustment ${breadRounding?.adjustment}, due ${breadRounding?.due}`,
    classification: "application",
    screen: "تقارير المبيعات / تقريب",
    detail: "Each 6.00 − 0.60 = 5.40 line stays 5.40. Each invoice payable is 5.00.",
  });

  const ahmadLedger = unwrap(
    (await call(app, { method: "get", path: `/api/v1/customers/${ids.ahmad}/ledger`, token: admin })).body
  );
  const mixedDebit = (ahmadLedger?.events || []).some((row) => num(row.debit) === 3);
  pushResult(results, {
    scenario: "Ahmad's ledger debits the 3.00 on-account share and closes at 24.00",
    feature: "customers",
    status: mixedDebit && num(ahmadLedger?.closing_balance) === 24 ? "PASS" : "FAIL",
    expected: "debit 3.00 and closing 24.00",
    actual: `closing ${ahmadLedger?.closing_balance}; mixed debit ${mixedDebit}`,
    classification: mixedDebit && num(ahmadLedger?.closing_balance) === 24.4 ? "" : "application",
    screen: "كشف حساب أحمد الذمة التجريبي",
  });
  const replayDebt = await call(app, {
    method: "post",
    path: "/api/v1/checkout",
    token: cashier1,
    body: {
      idempotency_key: "demo-bread-partial",
      items: [{ product_id: ids.bread, quantity: 2, price: 3, unit_id: bread.piece }],
      payments: [
        { method: "cash", amount: 2 },
        { method: "on_account", amount: 3 },
      ],
      customer_id: ids.ahmad,
    },
  });
  const ahmadAfterReplay = (await db.get("SELECT balance FROM customers WHERE id = ?", [ids.ahmad])).balance;
  pushResult(results, {
    scenario: "Replaying the mixed ذمة sale does not add Ahmad's debt again",
    feature: "on-account",
    status: [200, 202].includes(replayDebt.status) && num(ahmadAfterReplay) === 24 ? "PASS" : "FAIL",
    expected: "24.00",
    actual: `${replayDebt.status} / ${ahmadAfterReplay}`,
    classification: num(ahmadAfterReplay) === 24.4 ? "" : "application",
    screen: "العملاء / أحمد الذمة التجريبي",
  });

  const daily = unwrap(
    (await call(app, { method: "get", path: "/api/v1/reports/daily", token: admin, query: { date: POS } })).body
  );
  const listedRevenue = (daily?.top_products || []).reduce((sum, row) => sum + num(row.revenue), 0);
  const postedLines = await db.get(
    `SELECT COALESCE(SUM(ti.line_net + ti.line_tax), 0) AS s
       FROM transaction_items ti
       JOIN transactions t ON t.id = ti.transaction_id
       JOIN cashier_shifts cs ON cs.id = t.shift_id
      WHERE substr(cs.start_time, 1, 10) = ?`,
    [POS]
  );
  const lineRevenue = num(postedLines?.s);
  const billed = num(daily?.total_sales);
  const adjustment = num(daily?.rounding_adjustment);
  const itemRevenue = num(daily?.item_revenue);
  const reconciled = Math.abs(lineRevenue + adjustment - billed) <= 0.001 && Math.abs(itemRevenue - lineRevenue) <= 0.001;
  pushResult(results, {
    scenario: "15 Sep item revenue plus rounding equals billed sales",
    feature: "reports",
    status: reconciled ? "PASS" : "FAIL",
    expected: "lines 151.80 + adjustment -0.80 = sales 151.00",
    actual: `lines ${lineRevenue}; item ${itemRevenue}; adjustment ${adjustment}; sales ${billed}; top ${listedRevenue}`,
    classification: reconciled ? "" : "application",
    screen: "تقرير يوم 2026-09-15",
    detail: "Line revenue stays pre-round. The two bread invoices contribute −0.40 each, so 151.80 − 0.80 = 151.00.",
  });

  const officeTx = await db.get(
    `SELECT t.created_at, t.total FROM transactions t
      JOIN sales_invoices si ON si.transaction_id = t.id
     WHERE si.id = ?`,
    [invoice.id]
  );
  const officeDay = shopYmdFromTimestamp(officeTx?.created_at);
  const officeDayFinance = unwrap(
    (
      await call(app, {
        method: "get",
        path: "/api/v1/finance/overview",
        token: admin,
        query: { from: officeDay, to: officeDay },
      })
    ).body
  );
  const posPlusOffice = num(officeDayFinance?.sales?.pos) + num(officeDayFinance?.sales?.office);
  pushResult(results, {
    scenario: "Office invoice is in overall sales and not in the POS total",
    feature: "finance",
    status:
      num(officeDayFinance?.sales?.office) >= 4 &&
      num(officeDayFinance?.pos_sales_total) === num(officeDayFinance?.sales?.pos) &&
      Math.abs(posPlusOffice - num(officeDayFinance?.sales?.gross)) < 0.02
        ? "PASS"
        : "FAIL",
    expected: "office >= 4 and pos + office = gross",
    actual: `pos ${officeDayFinance?.pos_sales_total} office ${officeDayFinance?.sales?.office} gross ${officeDayFinance?.sales?.gross}`,
    classification: num(officeDayFinance?.sales?.office) >= 4 ? "" : "application",
    screen: "المراقبة المالية",
  });

  const sugarBefore = (await db.get("SELECT stock FROM products WHERE id = ?", [ids.sugar])).stock;
  const sugarLot = await call(app, {
    method: "post",
    path: "/api/v1/inventory/batches",
    token: admin,
    body: { product_id: ids.sugar, batch_no: "DEMO-SUGAR", expiry_date: "2026-12-31", quantity: 1, cost: 2 },
  });
  const sugarOver = await call(app, {
    method: "post",
    path: "/api/v1/inventory/batches",
    token: admin,
    body: { product_id: ids.sugar, batch_no: "DEMO-SUGAR-OVER", expiry_date: "2027-01-15", quantity: 99, cost: 2 },
  });
  const sugarAfter = (await db.get("SELECT stock FROM products WHERE id = ?", [ids.sugar])).stock;
  pushResult(results, {
    scenario: "Manual sugar batch assigns expiry without receiving stock",
    feature: "inventory",
    status: sugarLot.status === 201 && sugarOver.status === 400 && num(sugarAfter) === num(sugarBefore) ? "PASS" : "FAIL",
    expected: "201 then 400, stock unchanged",
    actual: `${sugarLot.status} / ${sugarOver.status} / stock ${sugarAfter}`,
    classification: sugarLot.status === 201 && sugarOver.status === 400 ? "" : "application",
    screen: "دفعات المخزون / سكر تجريبي",
  });

  const dualSupplier = unwrap(
    (
      await call(app, {
        method: "post",
        path: "/api/v1/suppliers",
        token: admin,
        body: { name: "مورد دفعتان تجريبي", opening_balance: 100 },
      })
    ).body
  );
  const dualDraft = unwrap(
    (
      await call(app, {
        method: "post",
        path: "/api/v1/vouchers",
        token: admin,
        body: {
          voucher_type: "payment",
          voucher_date: POS,
          lines: [{ line_type: "cash", amount: 20, currency: "NIS", supplier_id: dualSupplier?.id }],
        },
      })
    ).body
  );
  await call(app, { method: "post", path: `/api/v1/vouchers/${dualDraft?.id}/post`, token: admin, body: {} });
  await call(app, {
    method: "post",
    path: "/api/v1/finance/payments",
    token: admin,
    body: { supplier_id: dualSupplier?.id, amount: 20, paid_on: POS, payment_method: "cash" },
  });
  const dualBalance = (await db.get("SELECT balance FROM suppliers WHERE id = ?", [dualSupplier?.id]))?.balance;
  const dualLedger = unwrap(
    (await call(app, { method: "get", path: `/api/v1/suppliers/${dualSupplier?.id}/ledger`, token: admin })).body
  );
  const dualPayments = (dualLedger?.events || []).filter((row) => row.ev_type === "payment").length;
  pushResult(results, {
    scenario: "Two supplier payments of 20 both reduce the balance once each",
    feature: "suppliers",
    status: num(dualBalance) === 60 && num(dualLedger?.closing_balance) === 60 && dualPayments === 2 ? "PASS" : "FAIL",
    expected: "balance 60, ledger 60, 2 payments",
    actual: `balance ${dualBalance} ledger ${dualLedger?.closing_balance} payments ${dualPayments}`,
    classification: num(dualBalance) === 60 && num(dualLedger?.closing_balance) === 60 ? "" : "application",
    screen: "كشف حساب مورد دفعتان تجريبي",
  });

  const drawerSupplier = unwrap(
    (
      await call(app, {
        method: "post",
        path: "/api/v1/suppliers",
        token: admin,
        body: { name: "مورد دفع درج تجريبي", opening_balance: 500 },
      })
    ).body
  );
  const drawerShiftId = await openShift(cashier2, "300.00");
  const drawerPay = await call(app, {
    method: "post",
    path: "/api/v1/pos/supplier-payments",
    token: cashier2,
    body: {
      supplier_id: drawerSupplier?.id,
      amount: 100,
      notes: "دفع من الدرج",
      idempotency_key: "demo-pos-supplier-pay-100",
    },
  });
  const drawerReplay = await call(app, {
    method: "post",
    path: "/api/v1/pos/supplier-payments",
    token: cashier2,
    body: {
      supplier_id: drawerSupplier?.id,
      amount: 100,
      notes: "دفع من الدرج",
      idempotency_key: "demo-pos-supplier-pay-100",
    },
  });
  const drawerSupplierRow = await db.get("SELECT balance FROM suppliers WHERE id = ?", [drawerSupplier?.id]);
  const drawerShift = unwrap(
    (await call(app, { method: "get", path: `/api/v1/shifts/${drawerShiftId}`, token: admin })).body
  );
  const drawerVouchers = await db.all(
    "SELECT id FROM vouchers WHERE shift_id = ? AND voucher_type = 'payment'",
    [drawerShiftId]
  );
  const drawerMoves = await db.all(
    "SELECT id FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'supplier_payment'",
    [drawerShiftId]
  );
  const drawerLegacy = await db.get(
    "SELECT COUNT(*) AS n FROM supplier_payments WHERE supplier_id = ?",
    [drawerSupplier?.id]
  );
  pushResult(results, {
    scenario: "POS drawer pays a supplier 100 once and leaves 400 debt / 200 cash",
    feature: "pos-supplier-payment",
    status:
      (drawerPay.status === 201 || drawerPay.status === 200) &&
      drawerReplay.status === 200 &&
      num(drawerSupplierRow?.balance) === 400 &&
      num(drawerShift?.summary?.expected) === 200 &&
      num(drawerShift?.summary?.supplier_payments_total) === 100 &&
      drawerVouchers.length === 1 &&
      drawerMoves.length === 1 &&
      num(drawerLegacy?.n) === 0
        ? "PASS"
        : "FAIL",
    expected: "debt 400, drawer 200, one voucher, one movement",
    actual: `http ${drawerPay.status}/${drawerReplay.status} debt ${drawerSupplierRow?.balance} expected ${drawerShift?.summary?.expected} vouchers ${drawerVouchers.length} moves ${drawerMoves.length} legacy ${drawerLegacy?.n}`,
    classification: "application",
    screen: "نقطة البيع / دفع لمورد",
  });

  const cashDebtCustomer = unwrap(
    (
      await call(app, {
        method: "post",
        path: "/api/v1/customers",
        token: admin,
        body: { name: "عميل ذمة نقدية تجريبي", opening_balance: 100 },
      })
    ).body
  );
  const salesBeforeCashDebt = Number((await db.get("SELECT COUNT(*) AS n FROM transactions")).n);
  const stockBeforeCashDebt = Number(
    (await db.get("SELECT COALESCE(SUM(stock),0) AS s FROM products")).s
  );
  const cashDebt = await call(app, {
    method: "post",
    path: "/api/v1/customer-cash-debt-requests",
    token: cashier2,
    body: {
      customer_id: cashDebtCustomer?.id,
      amount: 30,
      notes: "صرف نقد على الذمة",
      idempotency_key: "demo-pos-customer-cash-debt-30",
    },
  });
  const cashDebtId = unwrap(cashDebt.body)?.request_id;
  const cashDebtPendingBalance = (
    await db.get("SELECT balance FROM customers WHERE id = ?", [cashDebtCustomer?.id])
  )?.balance;
  const cashDebtApproved = await call(app, {
    method: "put",
    path: `/api/v1/customer-cash-debt-requests/${cashDebtId}`,
    token: admin,
    body: { status: "approved" },
  });
  const cashDebtReplay = await call(app, {
    method: "put",
    path: `/api/v1/customer-cash-debt-requests/${cashDebtId}`,
    token: admin,
    body: { status: "approved" },
  });
  const cashDebtBalance = (
    await db.get("SELECT balance FROM customers WHERE id = ?", [cashDebtCustomer?.id])
  )?.balance;
  const cashDebtShift = unwrap(
    (await call(app, { method: "get", path: `/api/v1/shifts/${drawerShiftId}`, token: admin })).body
  );
  const cashDebtMoves = await db.all(
    "SELECT id FROM shift_cash_movements WHERE shift_id = ? AND movement_type = 'customer_cash_debt'",
    [drawerShiftId]
  );
  const salesAfterCashDebt = Number((await db.get("SELECT COUNT(*) AS n FROM transactions")).n);
  const stockAfterCashDebt = Number(
    (await db.get("SELECT COALESCE(SUM(stock),0) AS s FROM products")).s
  );
  pushResult(results, {
    scenario: "Approved customer cash debt of 30 raises debt to 130 and lowers drawer cash to 170",
    feature: "pos",
    status:
      cashDebt.status === 201 &&
      num(cashDebtPendingBalance) === 100 &&
      cashDebtApproved.status === 200 &&
      cashDebtReplay.status === 200 &&
      num(cashDebtBalance) === 130 &&
      num(cashDebtShift?.summary?.expected) === 170 &&
      num(cashDebtShift?.summary?.customer_cash_debts_total) === 30 &&
      num(cashDebtShift?.summary?.cash_sales) === 0 &&
      num(cashDebtShift?.summary?.supplier_payments_total) === 100 &&
      cashDebtMoves.length === 1 &&
      salesAfterCashDebt === salesBeforeCashDebt &&
      stockAfterCashDebt === stockBeforeCashDebt
        ? "PASS"
        : "FAIL",
    expected: "pending debt stays 100; approved debt 130, drawer 170, one outflow",
    actual: `http ${cashDebt.status}/${cashDebtApproved.status}/${cashDebtReplay.status} pending ${cashDebtPendingBalance} debt ${cashDebtBalance} expected ${cashDebtShift?.summary?.expected} cash debts ${cashDebtShift?.summary?.customer_cash_debts_total}`,
    classification: "application",
    screen: "نقطة البيع / ذمم عملاء نقدي",
  });

  const ratePath = await call(app, {
    method: "patch",
    path: `/api/v1/payroll/cashiers/${userId.cashier1}`,
    token: admin,
    body: { hourly_rate: 99 },
  });
  const afterRate = unwrap(
    (
      await call(app, {
        method: "get",
        path: "/api/v1/payroll/report",
        token: admin,
        query: { date_from: POS, date_to: POS, cashier_id: userId.cashier1 },
      })
    ).body
  );
  const cashier1After = (afterRate?.employees || []).find((row) => row.username === "cashier1");
  await call(app, {
    method: "patch",
    path: `/api/v1/payroll/cashiers/${userId.cashier1}`,
    token: admin,
    body: { hourly_rate: 25 },
  });
  pushResult(results, {
    scenario: "Raising today's rate leaves the captured 15 Sep shift at 200",
    feature: "payroll",
    status: ratePath.status === 200 && num(cashier1After?.total_pay) === 200 ? "PASS" : "FAIL",
    expected: "200.00",
    actual: `${ratePath.status} / ${cashier1After?.total_pay}`,
    classification: num(cashier1After?.total_pay) === 200 ? "" : "application",
    screen: "أجور الساعة والدوام / cashier1",
  });

  const roundingShift = await openShift(cashier1, "0.00");
  const roundingProduct = await product({
    barcode: "6281000000991",
    name: "صنف تقريب تجريبي",
    price: 21.3,
    cost: 0,
    stock: 0,
    unit: "حبة",
  });
  const roundingCases = [
    ["21.30", 21.3, 21.3, 21, -0.3],
    ["45.60", 45.6, 45.6, 46, 0.4],
    ["2.50", 2.5, 2.5, 2.5, 0],
    ["2.49", 2.49, 2.49, 2, -0.49],
    ["2.51", 2.51, 2.51, 3, 0.49],
    ["2.00", 2, 2, 2, 0],
    ["0.40", 0.4, 0.4, 0, -0.4],
    ["0.01", 0.01, 0.01, 0, -0.01],
    ["0.99", 0.99, 0.99, 1, 0.01],
  ];
  for (const [label, price, before, payable, adjustment] of roundingCases) {
    await db.run("UPDATE products SET price = ? WHERE id = ?", [price, roundingProduct.id]);
    await db.run("UPDATE product_units SET price = ? WHERE product_id = ?", [price, roundingProduct.id]);
    const key = `demo-round-${label.replace(".", "")}`;
    const stockBefore = Number((await db.get("SELECT stock FROM products WHERE id = ?", [roundingProduct.id])).stock);
    await checkout(cashier1, {
      idempotency_key: key,
      items: [{ product_id: roundingProduct.id, quantity: 1, price, unit_id: roundingProduct.piece }],
      payment_method: "cash",
    }, `round ${label}`);
    const saved = await db.get(
      "SELECT total, amount_before_rounding, rounding_adjustment FROM transactions WHERE idempotency_key = ?",
      [key]
    );
    const stockAfter = Number((await db.get("SELECT stock FROM products WHERE id = ?", [roundingProduct.id])).stock);
    checkMoney(results, `POS payable rounding ${label}`, String(payable), saved?.total, {
      feature: "pos",
      screen: "نقطة البيع / تقريب",
      detail: `${label} calculated ${before.toFixed(2)}, adjustment ${adjustment.toFixed(2)}, payable ${payable.toFixed(2)}.`,
    });
    pushResult(results, {
      scenario: `POS payable rounding ${label} keeps the pre-round total`,
      feature: "pos",
      status:
        num(saved?.amount_before_rounding) === before &&
        num(saved?.rounding_adjustment) === adjustment &&
        stockAfter === stockBefore - 1
          ? "PASS"
          : "FAIL",
      expected: `before ${before.toFixed(2)}, adjustment ${adjustment.toFixed(2)}, stock -1`,
      actual: `before ${saved?.amount_before_rounding}, adjustment ${saved?.rounding_adjustment}, stock ${stockBefore} → ${stockAfter}`,
      classification: "application",
      screen: "نقطة البيع / تقريب",
    });
  }
  await must(
    await call(app, { method: "post", path: `/api/v1/shifts/${roundingShift}/end`, token: cashier1, body: {} }),
    "end rounding shift",
    [200]
  );

  } catch (error) {
    aborted = error;
    pushResult(results, {
      scenario: "Simulation step aborted",
      feature: "runner",
      status: "FAIL",
      expected: "the step completes",
      actual: error.message,
      classification: error.classification || "test_infrastructure",
      screen: "",
    });
  }
  if (admin) {
    try {
      await assertPersisted({ app, db, admin, expected, results, ids });
    } catch (error) {
      pushResult(results, {
        scenario: "Persisted snapshot check aborted",
        feature: "runner",
        status: "FAIL",
        expected: "snapshot comparison completes",
        actual: error.message,
        classification: error.classification || "test_infrastructure",
      });
    }
  }
  if (!aborted) {
    await db.run(
      `INSERT INTO app_settings (key, value) VALUES ('demo_store_simulated', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify("1")]
    );
  }
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "ids.json"), JSON.stringify(ids, null, 2));
  return { ids, aborted: Boolean(aborted) };
}

export async function assertPersisted({ app, db, admin, expected, results, ids }) {
  for (const [name, qty] of Object.entries(expected.stock)) {
    const row = await db.get("SELECT stock, cost FROM products WHERE name = ?", [name]);
    checkQty(results, `Stock ${name}`, qty, row?.stock, {
      feature: "inventory",
      screen: `المنتجات / ${name}`,
    });
    checkMoney(results, `Cost ${name}`, expected.cost[name], row?.cost, {
      feature: "costing",
      screen: `المنتجات / ${name}`,
    });
  }

  const supplierExpected = {
    [expected.parties.suppliers.dairy]: expected.books.dairy.balance,
    [expected.parties.suppliers.produce]: expected.books.produce.balance,
    [expected.parties.suppliers.bakery]: expected.books.bakerySupplier.balance,
    [expected.parties.suppliers.vat]: expected.books.vatSupplier.balance,
    [expected.parties.suppliers.office]: expected.books.officeSupplier.balance,
  };
  for (const [name, balance] of Object.entries(supplierExpected)) {
    const row = await db.get("SELECT balance FROM suppliers WHERE name = ?", [name]);
    checkMoney(results, `Supplier ${name}`, balance, row?.balance, {
      feature: "suppliers",
      screen: `الموردون / ${name}`,
    });
  }

  const ahmad = await db.get("SELECT balance FROM customers WHERE name = ?", [expected.parties.customers.ahmad]);
  checkMoney(results, "Ahmad remaining debt", expected.books.ahmad.balance, ahmad?.balance, {
    feature: "customers",
    screen: "العملاء / أحمد الذمة التجريبي",
  });

  const finance = unwrap(
    (
      await call(app, {
        method: "get",
        path: "/api/v1/finance/overview",
        token: admin,
        query: { from: POS, to: POS },
      })
    ).body
  );
  const pos = expected.books.posDay;
  checkMoney(results, "15 Sep POS sales", pos.gross, finance?.pos_sales_total, {
    feature: "finance",
    screen: "المراقبة المالية 2026-09-15",
  });
  checkMoney(results, "15 Sep refunds", pos.refundTotal, finance?.refunds_total, {
    feature: "finance",
    screen: "المراقبة المالية 2026-09-15",
  });
  checkMoney(results, "15 Sep net POS sales", pos.net, finance?.net_pos_sales, {
    feature: "finance",
    screen: "المراقبة المالية 2026-09-15",
  });
  checkMoney(results, "15 Sep net COGS", pos.netCogs, finance?.net_estimated_cogs, {
    feature: "finance",
    screen: "المراقبة المالية 2026-09-15",
  });
  checkMoney(results, "15 Sep gross profit", pos.grossProfit, finance?.estimated_gross_profit, {
    feature: "finance",
    screen: "المراقبة المالية 2026-09-15",
  });
  const opexDiff = finance?.operating_expenses_total;
  checkMoney(results, "15 Sep operating expenses", expected.books.opex.total, opexDiff, {
    feature: "finance",
    screen: "المراقبة المالية 2026-09-15",
    classification: "application",
  });
  checkMoney(results, "15 Sep profit after expenses", expected.books.operatingProfit, finance?.profit?.operatingNetProfit, {
    feature: "finance",
    screen: "المراقبة المالية 2026-09-15",
  });

  const boundary = unwrap(
    (
      await call(app, {
        method: "get",
        path: "/api/v1/finance/overview",
        token: admin,
        query: { from: "2026-09-14", to: "2026-09-14" },
      })
    ).body
  );
  checkMoney(results, "Midnight-boundary shift stays on 14 Sep", "7.00", boundary?.pos_sales_total, {
    feature: "business-day",
    screen: "المراقبة المالية 2026-09-14",
    detail: "The shift started 23:30 on 14 Sep. The sale timestamp is 00:30 on 15 Sep. The business day is the shift start.",
  });
  pushResult(results, {
    scenario: "Zero historical cost does not produce a known profit",
    feature: "costing",
    status: boundary?.cogs_unknown === true ? "PASS" : "FAIL",
    expected: "cogs_unknown true",
    actual: `cogs_unknown ${boundary?.cogs_unknown}, cogs ${boundary?.net_estimated_cogs}, profit ${boundary?.estimated_gross_profit}`,
    classification: boundary?.cogs_unknown === true ? "" : "application",
    screen: "المراقبة المالية 2026-09-14 / حافة تكلفة مفقودة",
  });
  const lots = await db.all(
    "SELECT expiry_date, quantity FROM product_batches WHERE product_id = ? ORDER BY expiry_date",
    [ids?.yogurt || (await db.get("SELECT id FROM products WHERE name = ?", [expected.products.yogurt.name])).id]
  );
  const lotText = lots.map((row) => `${row.expiry_date}:${row.quantity}`).join(", ");
  const lotOk =
    lots.length === 2 &&
    Number(lots[0].quantity) === 2 &&
    String(lots[0].expiry_date).startsWith("2026-10-01") &&
    Number(lots[1].quantity) === 6 &&
    String(lots[1].expiry_date).startsWith("2026-12-01");
  pushResult(results, {
    scenario: "FEFO leaves the earliest yogurt lot at 2",
    feature: "expiry",
    status: lotOk ? "PASS" : "FAIL",
    expected: "2026-10-01 × 2 and 2026-12-01 × 6",
    actual: lotText || "no batches",
    classification: lotOk ? "" : "application",
    screen: "الصلاحية / لبن تشكيلة تجريبي",
  });

  const inventory = await db.get("SELECT SUM(stock * cost) AS v FROM products");
  checkMoney(results, "Catalog inventory value", expected.books.inventoryAtCost, inventory?.v, {
    feature: "inventory",
    screen: "المراقبة المالية / قيمة المخزون",
  });

  const low = await call(app, { method: "get", path: "/api/v1/inventory/low-stock", token: admin });
  const lowText = JSON.stringify(unwrap(low.body));
  pushResult(results, {
    scenario: "Low stock lists the oil",
    feature: "inventory",
    status: low.status === 200 && lowText.includes(expected.products.oil.name) ? "PASS" : "FAIL",
    expected: expected.products.oil.name,
    actual: low.status === 200 ? "response received" : String(low.status),
    classification: lowText.includes(expected.products.oil.name) ? "" : "application",
    screen: "المنتجات / نواقص",
  });

  const bakery = unwrap(
    (
      await call(app, {
        method: "get",
        path: "/api/v1/reports/bakery",
        token: admin,
        query: { from: POS, to: POS },
      })
    ).body
  );
  checkMoney(results, "Bakery bread net revenue", expected.books.bakeryNet, bakery?.kpis?.net_revenue, {
    feature: "bakery",
    screen: "المخبز / المبيعات 2026-09-15",
  });

  const payments = await db.all(
    `SELECT sp.payment_method AS method, SUM(COALESCE(sp.nis_equivalent, sp.amount)) AS total
     FROM sale_payments sp
     JOIN transactions t ON t.id = sp.transaction_id
     JOIN cashier_shifts s ON s.id = t.shift_id
     WHERE s.start_time IN ('2026-09-15 07:00:00', '2026-09-15 08:00:00')
     GROUP BY sp.payment_method`
  );
  const payMap = Object.fromEntries(payments.map((row) => [row.method, row.total]));
  checkMoney(results, "15 Sep cash tenders", pos.cashPayments, payMap.cash, {
    feature: "pos",
    screen: "تقارير المبيعات",
  });
  checkMoney(results, "15 Sep Visa tenders", pos.visaPayments, payMap.visa, {
    feature: "pos",
    screen: "تقارير المبيعات",
  });
  checkMoney(results, "15 Sep debt tenders", pos.onAccountPayments, payMap.on_account, {
    feature: "pos",
    screen: "تقارير المبيعات",
  });

  const discounts = await db.get(
    `SELECT SUM(discount) AS total FROM transactions t
     JOIN cashier_shifts s ON s.id = t.shift_id
     WHERE s.start_time IN ('2026-09-15 07:00:00', '2026-09-15 08:00:00')`
  );
  checkMoney(results, "15 Sep discounts", pos.discountTotal, discounts?.total, {
    feature: "promotions",
    screen: "تقارير المبيعات",
  });

  const milkId =
    ids?.milk || (await db.get("SELECT id FROM products WHERE name = ?", [expected.products.milk.name]))?.id;
  const stockLines = asList(
    (await call(app, { method: "get", path: "/api/v1/warehouses/stock", token: admin })).body
  );
  const milkLines = stockLines.filter((row) => Number(row.product_id) === Number(milkId));
  const byWarehouse = Object.fromEntries(milkLines.map((row) => [row.warehouse_name, row.quantity]));
  checkQty(results, "Milk shown in the main warehouse", expected.milkWarehouses.main, byWarehouse["المستودع الرئيسي"] ?? 0, {
    feature: "warehouses",
    screen: "المستودعات / المستودع الرئيسي",
  });
  checkQty(results, "Milk shown in the store warehouse", expected.milkWarehouses.store, byWarehouse["مستودع المتجر"] ?? 0, {
    feature: "warehouses",
    screen: "المستودعات / مستودع المتجر",
  });
  checkQty(results, "Returned milk shown in the returns warehouse", expected.milkWarehouses.returns, byWarehouse["مستودع المرتجعات"] ?? 0, {
    feature: "warehouses",
    screen: "المستودعات / مستودع المرتجعات",
  });
  const valuation = unwrap(
    (await call(app, { method: "get", path: "/api/v1/warehouses/valuation", token: admin })).body
  );
  const valuationLines = Array.isArray(valuation?.warehouses) ? valuation.warehouses : [];
  const valuationSum = valuationLines.reduce((sum, row) => sum + Number(row.total_value || 0), 0);
  checkMoney(results, "Warehouse valuation values each unit once", expected.books.warehouseValuation, valuation?.grand_total, {
    feature: "warehouses",
    screen: "المستودعات / التقييم",
    detail: "281.25 = catalog 283.25 − bakery flour 10.00 + returns 8.00. The store transfer is inside the main residual, not added again.",
  });
  checkMoney(results, "Warehouse valuation equals the sum of its lines", expected.books.warehouseValuation, valuationSum, {
    feature: "warehouses",
    screen: "المستودعات / التقييم",
  });

  const ahmadRow = await db.get("SELECT id, balance FROM customers WHERE name = ?", [expected.parties.customers.ahmad]);
  const samerEmployee = await db.get("SELECT customer_id FROM employees WHERE name = ?", [expected.parties.employees.samer]);
  pushResult(results, {
    scenario: "Customer and employee debt accounts stay separate",
    feature: "on-account",
    status: ahmadRow?.id && samerEmployee?.customer_id && Number(ahmadRow.id) !== Number(samerEmployee.customer_id) ? "PASS" : "FAIL",
    expected: "different customer ids",
    actual: `ahmad ${ahmadRow?.id}, samer ${samerEmployee?.customer_id}`,
    classification: "application",
    screen: "العملاء وكشف الموظفين",
  });
}
