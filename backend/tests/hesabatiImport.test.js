import XLSX from "xlsx";
import request from "supertest";
import {
  detectFromBuffer,
  detectTypeFromFilename,
  filenameSuggestsCustomerBalances,
  isAbuShalbakSupplierListExport,
  UNSIGNED_ABU_SHALBAK_SUPPLIER_EXPORT_ERROR,
  IMPORT_TYPE_LABELS,
} from "../utils/importDetect.js";
import { parseBalanceSheetMatrix, parseBalanceAmount, parseBalanceAmountStrict, isBalanceSummaryRow } from "../utils/balanceSheetImport.js";
import { applyCustomerBalanceImport } from "../utils/customerImport.js";
import { applySupplierBalanceImport, parseSupplierBalanceFile, dedupeSupplierBalanceRows, buildSupplierBalanceImportPlan, HESABATI_OPENING_SOURCE } from "../utils/supplierImport.js";
import { buildSupplierLedger } from "../utils/supplierLedger.js";
import { formatHesabatiStatement } from "../utils/hesabatiStatementFormat.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPPLIER_FIXTURE = path.join(__dirname, "../../data/imports/حساباتي _ أرصدة الموردين (2).xlsx");
import { applyPriceListImport } from "../utils/priceListImport.js";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

function xlsxBuffer(rows) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function systemSupplierCsvBuffer() {
  const csv =
    "\uFEFF\"الرقم\",\"الاسم\",\"الهاتف\",\"شروط الدفع\",\"الرصيد (مستحق)\"\n" +
    "\"148\",\"شركة عنبتاوي توباكو\",\"—\",\"—\",\"₪0.00\"\n";
  return Buffer.from(csv, "utf8");
}

describe("importDetect", () => {
  test("detects type from filename — قائمة الأسعار", () => {
    expect(detectTypeFromFilename("(3) حساباتي _ قائمة الأسعار.xlsx")).toBe("hesabati_price_list");
  });

  test("detects type from filename — أرصدة الموردين", () => {
    expect(detectTypeFromFilename("(2) حساباتي _ أرصدة الموردين.xlsx")).toBe(
      "hesabati_supplier_balances"
    );
  });

  test("detects type from filename — أرصدة زبون", () => {
    expect(detectTypeFromFilename("(4)حساباتي _ أرصدة زبون.xlsx")).toBe(
      "hesabati_customer_balances"
    );
  });

  test("detects type from filename — أرصدة العملاء", () => {
    expect(detectTypeFromFilename("حساباتي _ أرصدة العملاء (6).xlsx")).toBe(
      "hesabati_customer_balances"
    );
    expect(filenameSuggestsCustomerBalances("حساباتي _ أرصدة العملاء (6).xlsx")).toBe(true);
  });

  test("detects arabic retail from headers", () => {
    const buf = xlsxBuffer([
      ["الرقم", "الاسم", "باركود", "باركود الوحدات", "مفرق"],
      [1, "منتج", "123", "", 5],
    ]);
    const d = detectFromBuffer(buf, "products.xlsx");
    expect(d.type).toBe("arabic_retail");
    expect(d.label).toBe(IMPORT_TYPE_LABELS.arabic_retail);
  });

  test("detects price list from headers", () => {
    const buf = xlsxBuffer([
      ["باركود", "الاسم", "مفرق", "جملة"],
      ["9990001", "Test Product", 12, 10],
    ]);
    const d = detectFromBuffer(buf, "export.xlsx");
    expect(d.type).toBe("hesabati_price_list");
    expect(d.previewRows.length).toBeGreaterThan(0);
  });

  test("detects customer balances from headers", () => {
    const buf = xlsxBuffer([
      ["الرقم", "اسم الزبون", "الهاتف", "الرصيد"],
      [1, "أحمد", "0599000000", 150.5],
    ]);
    const d = detectFromBuffer(buf, "balances.xlsx");
    expect(d.type).toBe("hesabati_customer_balances");
  });
});

describe("balance sheet parsing", () => {
  test("parseBalanceSheetMatrix extracts name and balance", () => {
    const matrix = [
      ["الرقم", "اسم المورد", "الرصيد"],
      [10, "مورد الخضار", 500],
    ];
    const rows = parseBalanceSheetMatrix(matrix, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("مورد الخضار");
    expect(rows[0].balance).toBe(500);
    expect(rows[0].code).toBe("10");
  });

  test("parseSupplierBalanceFile flips Hesabati supplier sign to system payable convention", () => {
    const buf = xlsxBuffer([
      ["الرقم", "اسم المورد", "الرصيد"],
      [1, "البان القصير", -290],
      [2, "شحادة الطريفي", 1450],
    ]);
    const rows = parseSupplierBalanceFile(buf, "أرصدة الموردين.xlsx");
    expect(rows.find((r) => r.name === "البان القصير")?.balance).toBe(290);
    expect(rows.find((r) => r.name === "شحادة الطريفي")?.balance).toBe(-1450);
  });

  test("parseSupplierBalanceFile preserves Arabic names with slashes", () => {
    const buf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [9, "شركة / أبناء الشني", -100],
    ]);
    const rows = parseSupplierBalanceFile(buf, "أرصدة الموردين.xlsx");
    expect(rows[0].name).toBe("شركة / أبناء الشني");
    expect(rows[0].excelBalance).toBe(-100);
  });

  test("dedupeSupplierBalanceRows prefers named row over nameless duplicate code", () => {
    const rows = [
      { rowNum: 221, code: "235", name: "شركة مرسين", phone: null, balance: 0, importType: "hesabati_supplier_balances" },
      { rowNum: 237, code: "235", name: "", phone: null, balance: 267403.89, importType: "hesabati_supplier_balances" },
    ];
    const { rows: deduped, dropped } = dedupeSupplierBalanceRows(rows);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].name).toBe("شركة مرسين");
    expect(deduped[0].balance).toBe(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].row).toBe(237);
  });

  test("parseBalanceAmount still coerces missing and invalid to 0", () => {
    expect(parseBalanceAmount(null)).toBe(0);
    expect(parseBalanceAmount("")).toBe(0);
    expect(parseBalanceAmount("abc")).toBe(0);
    expect(parseBalanceAmount(0)).toBe(0);
  });

  test("parseBalanceAmountStrict distinguishes zero from missing and invalid", () => {
    expect(parseBalanceAmountStrict(0)).toEqual({ ok: true, value: 0, reason: null });
    expect(parseBalanceAmountStrict("0")).toEqual({ ok: true, value: 0, reason: null });
    expect(parseBalanceAmountStrict("0.00")).toEqual({ ok: true, value: 0, reason: null });
    expect(parseBalanceAmountStrict(-290)).toEqual({ ok: true, value: -290, reason: null });
    expect(parseBalanceAmountStrict(null)).toEqual({ ok: false, value: null, reason: "missing" });
    expect(parseBalanceAmountStrict("")).toEqual({ ok: false, value: null, reason: "missing" });
    expect(parseBalanceAmountStrict("—")).toEqual({ ok: false, value: null, reason: "invalid" });
    expect(parseBalanceAmountStrict("abc")).toEqual({ ok: false, value: null, reason: "invalid" });
    expect(parseBalanceAmountStrict("'-12.50")).toEqual({ ok: true, value: -12.5, reason: null });
    expect(parseBalanceAmountStrict("'+100.00")).toEqual({ ok: true, value: 100, reason: null });
  });

  test("rejects unsigned ₪ أبو شلبك suppliers CSV (fresh signed export required)", () => {
    const matrix = [
      ["الرقم", "الاسم", "الهاتف", "شروط الدفع", "الرصيد (مستحق)"],
      ["148", "شركة عنبتاوي توباكو", "—", "—", "₪0.00"],
    ];
    expect(isAbuShalbakSupplierListExport(matrix, "suppliers-2026-09-13.csv")).toBe(true);
    expect(() => parseSupplierBalanceFile(systemSupplierCsvBuffer(), "suppliers-2026-09-13.csv")).toThrow(
      UNSIGNED_ABU_SHALBAK_SUPPLIER_EXPORT_ERROR
    );
  });

  test("isBalanceSummaryRow matches Hesabati totals labels", () => {
    expect(isBalanceSummaryRow("الإجمالي")).toBe(true);
    expect(isBalanceSummaryRow("الاجمالي")).toBe(true);
    expect(isBalanceSummaryRow("المجموع")).toBe(true);
    expect(isBalanceSummaryRow("total")).toBe(true);
    expect(isBalanceSummaryRow("شركة الإجمالي للتجارة")).toBe(false);
    expect(isBalanceSummaryRow("شركة عنبتاوي توباكو")).toBe(false);
  });
});

describe("hesabati import apply", () => {
  let ctx;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("applyPriceListImport updates existing product price", async () => {
    const summary = await applyPriceListImport(ctx.db, [
      { rowNum: 2, barcode: "9990001", name: "Test Product", price: 14.5, min_price: 12, max_price: null },
    ]);
    expect(summary.updated).toBe(1);
    const row = await ctx.db.get("SELECT price, min_price FROM products WHERE id = ?", [ctx.productId]);
    expect(row.price).toBe(14.5);
    expect(row.min_price).toBe(12);
  });

  test("applyCustomerBalanceImport creates customer with opening balance", async () => {
    const summary = await applyCustomerBalanceImport(ctx.db, [
      {
        rowNum: 2,
        code: "C001",
        name: "عميل تجريبي",
        phone: "0599111111",
        balance: 200,
        price_category: "credit",
        notesTag: null,
        importType: "hesabati_customer_balances",
      },
    ]);
    expect(summary.created).toBe(1);
    const c = await ctx.db.get("SELECT * FROM customers WHERE name = ?", ["عميل تجريبي"]);
    expect(c.customer_code).toBeTruthy();
    expect(c.balance).toBe(200);
    expect(c.opening_balance).toBe(200);
    expect(c.price_category).toBe("credit");
    const zaboon = await ctx.db.get("SELECT id FROM customer_balance_groups WHERE slug = ?", ["zaboon"]);
    expect(c.balance_group_id).toBe(zaboon.id);
  });

  test("applyCustomerBalanceImport assigns operator group", async () => {
    const summary = await applyCustomerBalanceImport(ctx.db, [
      {
        rowNum: 2,
        code: "OP001",
        name: "مشغل تجريبي",
        phone: null,
        balance: 50,
        price_category: "retail",
        notesTag: "مشغل",
        importType: "hesabati_operator_balances",
      },
    ]);
    expect(summary.created).toBe(1);
    const c = await ctx.db.get("SELECT * FROM customers WHERE name = ?", ["مشغل تجريبي"]);
    const mashghilin = await ctx.db.get(
      "SELECT id FROM customer_balance_groups WHERE slug = ?",
      ["mashghilin"]
    );
    expect(c.balance_group_id).toBe(mashghilin.id);
  });

  test("applyCustomerBalanceImport assigns building group", async () => {
    const summary = await applyCustomerBalanceImport(ctx.db, [
      {
        rowNum: 2,
        code: "BLD001",
        name: "عمارة تجريبية",
        phone: null,
        balance: 120,
        price_category: "corporate",
        notesTag: "عمارة",
        importType: "hesabati_building_balances",
      },
    ]);
    expect(summary.created).toBe(1);
    const c = await ctx.db.get("SELECT * FROM customers WHERE name = ?", ["عمارة تجريبية"]);
    const omara = await ctx.db.get("SELECT id FROM customer_balance_groups WHERE slug = ?", ["omara"]);
    expect(c.balance_group_id).toBe(omara.id);
  });

  test("applySupplierBalanceImport updates existing supplier to zero on re-import with overwrite", async () => {
    await applySupplierBalanceImport(ctx.db, [
      {
        rowNum: 221,
        code: "235",
        name: "شركة مرسين",
        phone: null,
        balance: 267403.89,
        systemBalance: 267403.89,
        excelBalance: -267403.89,
        importType: "hesabati_supplier_balances",
      },
    ], { openingBalanceDate: "2024-01-01" });
    const summary = await applySupplierBalanceImport(ctx.db, [
      {
        rowNum: 221,
        code: "235",
        name: "شركة مرسين",
        phone: null,
        balance: 0,
        systemBalance: 0,
        excelBalance: 0,
        importType: "hesabati_supplier_balances",
      },
      {
        rowNum: 237,
        code: "235",
        name: "",
        phone: null,
        balance: 267403.89,
        importType: "hesabati_supplier_balances",
      },
    ], { importZeroBalances: true, overwriteExistingOpeningBalances: true, openingBalanceDate: "2024-06-01" });
    expect(summary.updated).toBe(1);
    const s = await ctx.db.get("SELECT id, balance, opening_balance_source FROM suppliers WHERE name = ?", ["شركة مرسين"]);
    expect(s.balance).toBe(0);
    expect(s.opening_balance_source).toBe(HESABATI_OPENING_SOURCE);
    const entry = await ctx.db.get(
      `SELECT id FROM party_opening_entries WHERE party_type = 'supplier' AND party_id = ?`,
      [s.id]
    );
    expect(entry).toBeFalsy();
  });

  test("applySupplierBalanceImport creates supplier with opening entry metadata", async () => {
    const summary = await applySupplierBalanceImport(ctx.db, [
      {
        rowNum: 2,
        code: "S001",
        name: "مورد تجريبي",
        phone: null,
        balance: 800,
        systemBalance: 800,
        excelBalance: -800,
        importType: "hesabati_supplier_balances",
      },
    ], { openingBalanceDate: "2025-03-15" });
    expect(summary.created).toBe(1);
    const s = await ctx.db.get("SELECT * FROM suppliers WHERE name = ?", ["مورد تجريبي"]);
    expect(s.supplier_code).toBeTruthy();
    expect(s.balance).toBe(800);
    expect(s.opening_balance).toBe(800);
    expect(s.opening_balance_excel).toBe(-800);
    expect(s.opening_balance_date).toBe("2025-03-15");
    expect(s.opening_balance_source).toBe(HESABATI_OPENING_SOURCE);
    const entry = await ctx.db.get(
      `SELECT * FROM party_opening_entries WHERE party_type = 'supplier' AND party_id = ?`,
      [s.id]
    );
    expect(entry).toBeTruthy();
    expect(entry.credit).toBe(800);
    expect(entry.debit).toBe(0);
  });

  test("buildSupplierBalanceImportPlan dry-run does not write", async () => {
    const before = await ctx.db.get("SELECT COUNT(*) AS n FROM suppliers");
    const plan = await buildSupplierBalanceImportPlan(ctx.db, [
      {
        rowNum: 2,
        code: "PLAN01",
        name: "مورد المعاينة",
        phone: null,
        balance: 100,
        systemBalance: 100,
        excelBalance: -100,
        importType: "hesabati_supplier_balances",
      },
    ]);
    const after = await ctx.db.get("SELECT COUNT(*) AS n FROM suppliers");
    expect(after.n).toBe(before.n);
    expect(plan.stats.toCreate).toBe(1);
    expect(plan.rows[0].action).toBe("create");
    expect(plan.rows[0].statementBalance).toBe(-100);
    expect(plan.destination).toBe("supplier");
    expect(plan.destinationLabel).toMatch(/إدارة الموردين/);
  });

  test("supplier plan warns when the uploaded filename looks like customer balances", async () => {
    const plan = await buildSupplierBalanceImportPlan(ctx.db, [
      {
        rowNum: 2,
        code: "WARN01",
        name: "مورد تحذير الملف",
        phone: null,
        balance: 0,
        systemBalance: 0,
        excelBalance: 0,
        balanceStatus: "ok",
        importType: "hesabati_supplier_balances",
      },
    ], { filename: "حساباتي _ أرصدة العملاء (6).xlsx" });
    expect(plan.destination).toBe("supplier");
    expect(plan.destinationWarning).toMatch(/زبائن|عملاء/);
    expect(plan.rows[0].action).toBe("create");
  });

  test("re-import blocked without overwrite flag", async () => {
    await applySupplierBalanceImport(ctx.db, [
      {
        rowNum: 2,
        code: "REIMP01",
        name: "مورد إعادة",
        phone: null,
        balance: 500,
        systemBalance: 500,
        excelBalance: -500,
        importType: "hesabati_supplier_balances",
      },
    ], { openingBalanceDate: "2024-01-01" });
    const summary = await applySupplierBalanceImport(ctx.db, [
      {
        rowNum: 2,
        code: "REIMP01",
        name: "مورد إعادة",
        phone: null,
        balance: 600,
        systemBalance: 600,
        excelBalance: -600,
        importType: "hesabati_supplier_balances",
      },
    ], { openingBalanceDate: "2024-02-01" });
    expect(summary.updated).toBe(0);
    expect(summary.existing).toBeGreaterThanOrEqual(1);
    const s = await ctx.db.get("SELECT opening_balance FROM suppliers WHERE name = ?", ["مورد إعادة"]);
    expect(s.opening_balance).toBe(500);
  });

  test("statement closing matches Excel balance after import", async () => {
    await applySupplierBalanceImport(ctx.db, [
      {
        rowNum: 2,
        code: "STMT01",
        name: "مورد كشف",
        phone: null,
        balance: 290,
        systemBalance: 290,
        excelBalance: -290,
        importType: "hesabati_supplier_balances",
      },
    ], { openingBalanceDate: "2024-01-01" });
    const supplier = await ctx.db.get("SELECT * FROM suppliers WHERE name = ?", ["مورد كشف"]);
    const ledger = await buildSupplierLedger(ctx.db, supplier);
    const stmt = formatHesabatiStatement("supplier", supplier, ledger, {}, { storeName: "Test" });
    expect(stmt.rows[0].description).toBe("الرصيد المدور");
    expect(stmt.rows[0].balance).toBe(-290);
    expect(stmt.closing_balance_formatted).toBe("-290.00");
    expect(supplier.opening_balance_excel).toBe(-290);
  });
});

describe("hesabati import HTTP routes", () => {
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

  test("POST /api/admin/import/detect returns preview", async () => {
    const buf = xlsxBuffer([
      ["الرقم", "اسم الزبون", "الرصيد"],
      [1, "زبون", 100],
    ]);
    const res = await request(ctx.app)
      .post("/api/v1/admin/import/detect")
      .set(authHeader(adminToken))
      .attach("file", buf, { filename: "(4) أرصدة زبون.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.type).toBe("hesabati_customer_balances");
    expect(body.previewRows.length).toBe(1);
  });

  test("POST /api/admin/customers/upload imports balances", async () => {
    const buf = xlsxBuffer([
      ["الرقم", "اسم الزبون", "الرصيد"],
      [2, "زبون HTTP", 75],
    ]);
    const res = await request(ctx.app)
      .post("/api/v1/admin/customers/upload")
      .set(authHeader(adminToken))
      .attach("file", buf, { filename: "أرصدة زبون.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.created).toBeGreaterThanOrEqual(1);
  });

  test("POST /api/admin/suppliers/upload imports supplier balances", async () => {
    const buf = xlsxBuffer([
      ["الرقم", "اسم المورد", "الرصيد"],
      [3, "مورد HTTP", 300],
    ]);
    const res = await request(ctx.app)
      .post("/api/v1/admin/suppliers/upload")
      .set(authHeader(adminToken))
      .attach("file", buf, { filename: "أرصدة الموردين.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.created).toBeGreaterThanOrEqual(1);
  });

  test("POST /api/admin/import/supplier-balances/preview dry-run", async () => {
    const buf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [4, "مورد معاينة", -150],
    ]);
    const res = await request(ctx.app)
      .post("/api/v1/admin/import/supplier-balances/preview")
      .set(authHeader(adminToken))
      .attach("file", buf, { filename: "أرصدة الموردين.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.stats.totalRows).toBe(1);
    expect(body.rows[0].excelBalance).toBe(-150);
    expect(body.rows[0].systemBalance).toBe(150);
    expect(body.rows[0].action).toBe("create");
    expect(body.destination).toBe("supplier");
    expect(body.destinationLabel).toMatch(/إدارة الموردين/);
  });

  test("POST supplier-balances/preview warns when filename looks like customer balances", async () => {
    const buf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [6, "مورد من ملف عملاء", 0],
    ]);
    const res = await request(ctx.app)
      .post("/api/v1/admin/import/supplier-balances/preview")
      .set(authHeader(adminToken))
      .attach("file", buf, {
        filename: "حساباتي _ أرصدة العملاء (6).xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.destination).toBe("supplier");
    expect(body.destinationWarning).toMatch(/زبائن|عملاء|موردين/);
    expect(body.rows[0].action).toBe("create");
  });

  test("POST /api/admin/import/supplier-balances/confirm creates zero-balance supplier without import_zero_balances", async () => {
    const buf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [88, "مورد صفر HTTP", 0],
    ]);
    const res = await request(ctx.app)
      .post("/api/v1/admin/import/supplier-balances/confirm?opening_balance_date=2024-07-01")
      .set(authHeader(adminToken))
      .attach("file", buf, { filename: "أرصدة الموردين.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.created).toBeGreaterThanOrEqual(1);
    const s = await ctx.db.get("SELECT * FROM suppliers WHERE name = ?", ["مورد صفر HTTP"]);
    expect(s).toBeTruthy();
    expect(s.balance).toBe(0);
    expect(s.opening_balance).toBe(0);
    expect(s.opening_balance_source).toBe(HESABATI_OPENING_SOURCE);
    expect(s.opening_balance_date).toBeNull();
    const entry = await ctx.db.get(
      `SELECT id FROM party_opening_entries WHERE party_type = 'supplier' AND party_id = ?`,
      [s.id]
    );
    expect(entry).toBeFalsy();
  });

  test("POST /api/admin/import/supplier-balances/confirm imports", async () => {
    const buf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [5, "مورد تأكيد", 200],
    ]);
    const res = await request(ctx.app)
      .post("/api/v1/admin/import/supplier-balances/confirm?opening_balance_date=2024-05-01")
      .set(authHeader(adminToken))
      .attach("file", buf, { filename: "أرصدة الموردين.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.created).toBeGreaterThanOrEqual(1);
    const s = await ctx.db.get("SELECT opening_balance_date, opening_balance_source FROM suppliers WHERE name = ?", ["مورد تأكيد"]);
    expect(s.opening_balance_date).toBe("2024-05-01");
    expect(s.opening_balance_source).toBe(HESABATI_OPENING_SOURCE);
  });

  test("POST /api/admin/products/upload handles price list", async () => {
    const buf = xlsxBuffer([
      ["باركود", "الاسم", "مفرق", "جملة"],
      ["9990001", "Test Product", 11, 9],
    ]);
    const res = await request(ctx.app)
      .post("/api/v1/admin/products/upload")
      .set(authHeader(adminToken))
      .attach("file", buf, { filename: "قائمة الأسعار.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.type).toBe("hesabati_price_list");
    expect(body.updated).toBeGreaterThanOrEqual(1);
  });
});

describe("supplier balance import regression", () => {
  let ctx;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("explicit Excel zero creates supplier without opening entry", async () => {
    const buf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [401, "مورد رصيد صفر", 0],
    ]);
    const rows = parseSupplierBalanceFile(buf, "أرصدة الموردين.xlsx");
    expect(rows[0].excelBalance).toBe(0);
    expect(rows[0].systemBalance).toBe(0);
    expect(rows[0].balanceStatus).toBe("ok");
    const summary = await applySupplierBalanceImport(ctx.db, rows, { openingBalanceDate: "2024-08-01" });
    expect(summary.created).toBe(1);
    expect(summary.rejected).toBe(0);
    const s = await ctx.db.get("SELECT * FROM suppliers WHERE supplier_code = ?", ["401"]);
    expect(s.name).toBe("مورد رصيد صفر");
    expect(s.balance).toBe(0);
    expect(s.opening_balance).toBe(0);
    expect(s.opening_balance_excel).toBe(0);
    expect(s.opening_balance_source).toBe(HESABATI_OPENING_SOURCE);
    expect(s.opening_balance_date).toBeNull();
    const entry = await ctx.db.get(
      `SELECT id FROM party_opening_entries WHERE party_type = 'supplier' AND party_id = ?`,
      [s.id]
    );
    expect(entry).toBeFalsy();
  });

  test("nonzero Excel minus becomes system payable credit", async () => {
    const buf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [402, "مورد رصيد سالب", -290],
    ]);
    const rows = parseSupplierBalanceFile(buf, "أرصدة الموردين.xlsx");
    expect(rows[0].excelBalance).toBe(-290);
    expect(rows[0].systemBalance).toBe(290);
    const summary = await applySupplierBalanceImport(ctx.db, rows, { openingBalanceDate: "2024-08-01" });
    expect(summary.created).toBe(1);
    const s = await ctx.db.get("SELECT * FROM suppliers WHERE supplier_code = ?", ["402"]);
    expect(s.balance).toBe(290);
    expect(s.opening_balance).toBe(290);
    expect(s.opening_balance_excel).toBe(-290);
    expect(s.opening_balance_date).toBe("2024-08-01");
    const entry = await ctx.db.get(
      `SELECT * FROM party_opening_entries WHERE party_type = 'supplier' AND party_id = ?`,
      [s.id]
    );
    expect(entry).toBeTruthy();
    expect(entry.credit).toBe(290);
    expect(entry.debit).toBe(0);
  });

  test("missing balance is rejected and does not insert", async () => {
    const before = await ctx.db.get("SELECT COUNT(*) AS n FROM suppliers");
    const buf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [403, "مورد بلا رصيد"],
    ]);
    const rows = parseSupplierBalanceFile(buf, "أرصدة الموردين.xlsx");
    expect(rows[0].balanceStatus).toBe("missing");
    expect(rows[0].excelBalance).toBeNull();
    const summary = await applySupplierBalanceImport(ctx.db, rows);
    expect(summary.created).toBe(0);
    expect(summary.rejected).toBe(1);
    expect(summary.errors.some((e) => e.reason === "الرصيد مفقود")).toBe(true);
    const after = await ctx.db.get("SELECT COUNT(*) AS n FROM suppliers");
    expect(after.n).toBe(before.n);
    const s = await ctx.db.get("SELECT id FROM suppliers WHERE supplier_code = ?", ["403"]);
    expect(s).toBeFalsy();
  });

  test("invalid balance is rejected and does not insert", async () => {
    const before = await ctx.db.get("SELECT COUNT(*) AS n FROM suppliers");
    const buf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [404, "مورد رصيد باطل", "—"],
    ]);
    const rows = parseSupplierBalanceFile(buf, "أرصدة الموردين.xlsx");
    expect(rows[0].balanceStatus).toBe("invalid");
    const summary = await applySupplierBalanceImport(ctx.db, rows);
    expect(summary.created).toBe(0);
    expect(summary.rejected).toBe(1);
    expect(summary.errors.some((e) => e.reason === "الرصيد غير صالح")).toBe(true);
    const after = await ctx.db.get("SELECT COUNT(*) AS n FROM suppliers");
    expect(after.n).toBe(before.n);
  });

  test("trailing summary row is rejected and not imported as a supplier", async () => {
    const buf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [405, "مورد قبل الإجمالي", -10],
      ["", "الإجمالي", 9999],
      ["", "المجموع", 8888],
    ]);
    const rows = parseSupplierBalanceFile(buf, "أرصدة الموردين.xlsx");
    const summary = await applySupplierBalanceImport(ctx.db, rows, { openingBalanceDate: "2024-08-01" });
    expect(summary.created).toBe(1);
    expect(summary.rejected).toBe(2);
    expect(summary.errors.filter((e) => e.reason === "صف إجمالي — ليس مورداً")).toHaveLength(2);
    const total = await ctx.db.get("SELECT id FROM suppliers WHERE name = ?", ["الإجمالي"]);
    const sum = await ctx.db.get("SELECT id FROM suppliers WHERE name = ?", ["المجموع"]);
    expect(total).toBeFalsy();
    expect(sum).toBeFalsy();
  });

  test("repeat import adds missing zeros without duplicating or rewriting existing", async () => {
    const firstBuf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [410, "مورد موجود أولا", -50],
      [411, "مورد صفر أولا", 0],
    ]);
    const first = await applySupplierBalanceImport(ctx.db, parseSupplierBalanceFile(firstBuf, "أرصدة الموردين.xlsx"), {
      openingBalanceDate: "2024-01-01",
    });
    expect(first.created).toBe(2);

    const existingRow = await ctx.db.get("SELECT * FROM suppliers WHERE supplier_code = ?", ["410"]);
    expect(existingRow.opening_balance).toBe(50);
    const openingsBefore = await ctx.db.get(
      `SELECT COUNT(*) AS n FROM party_opening_entries WHERE party_type = 'supplier'`
    );

    const secondBuf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [410, "مورد موجود أولا", -999],
      [411, "مورد صفر أولا", 0],
      [412, "مورد صفر لاحق", 0],
    ]);
    const second = await applySupplierBalanceImport(ctx.db, parseSupplierBalanceFile(secondBuf, "أرصدة الموردين.xlsx"), {
      openingBalanceDate: "2024-09-01",
    });
    expect(second.created).toBe(1);
    expect(second.existing).toBe(2);
    expect(second.updated).toBe(0);
    expect(second.rejected).toBe(0);

    const unchanged = await ctx.db.get("SELECT * FROM suppliers WHERE supplier_code = ?", ["410"]);
    expect(unchanged.id).toBe(existingRow.id);
    expect(unchanged.opening_balance).toBe(50);
    expect(unchanged.balance).toBe(50);
    expect(unchanged.opening_balance_date).toBe("2024-01-01");
    const added = await ctx.db.get("SELECT * FROM suppliers WHERE supplier_code = ?", ["412"]);
    expect(added.name).toBe("مورد صفر لاحق");
    expect(added.balance).toBe(0);
    const openingsAfter = await ctx.db.get(
      `SELECT COUNT(*) AS n FROM party_opening_entries WHERE party_type = 'supplier'`
    );
    expect(openingsAfter.n).toBe(openingsBefore.n);
  });

  test("does not merge similar supplier names with different Hesabati IDs", async () => {
    const buf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [148, "شركة عنبتاوي توباكو", 0],
      [171, "شركة عنبتاوي توباكو / دخان", -25],
    ]);
    const summary = await applySupplierBalanceImport(ctx.db, parseSupplierBalanceFile(buf, "أرصدة الموردين.xlsx"), {
      openingBalanceDate: "2024-08-01",
    });
    expect(summary.created).toBe(2);
    const a = await ctx.db.get("SELECT * FROM suppliers WHERE supplier_code = ?", ["148"]);
    const b = await ctx.db.get("SELECT * FROM suppliers WHERE supplier_code = ?", ["171"]);
    expect(a.name).toBe("شركة عنبتاوي توباكو");
    expect(b.name).toBe("شركة عنبتاوي توباكو / دخان");
    expect(a.id).not.toBe(b.id);
    expect(a.balance).toBe(0);
    expect(b.balance).toBe(25);
  });
});

describe("hesabati supplier fixture file", () => {
  let ctx;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  function findOptionalSupplierFixture() {
    const candidates = [
      SUPPLIER_FIXTURE,
      path.join(__dirname, "../../data/imports/حساباتي _ أرصدة العملاء (6).xlsx"),
      path.join(__dirname, "../fixtures/hesabati/حساباتي _ أرصدة العملاء (6).xlsx"),
      path.join(__dirname, "../fixtures/hesabati/حساباتي _ أرصدة الموردين (2).xlsx"),
    ];
    return candidates.find((p) => fs.existsSync(p)) || null;
  }

  test("parses real Hesabati supplier balances file when fixture present", async () => {
    const fixturePath = findOptionalSupplierFixture();
    if (!fixturePath) {
      return;
    }
    const buffer = fs.readFileSync(fixturePath);
    const rows = parseSupplierBalanceFile(buffer, path.basename(fixturePath));
    expect(rows.length).toBeGreaterThan(0);
    const plan = await buildSupplierBalanceImportPlan(ctx.db, rows);
    expect(plan.stats.totalRows).toBeGreaterThan(0);
    expect(plan.stats.totalRows).toBeLessThanOrEqual(rows.length);
    expect(plan.stats.toCreate + plan.stats.matched + plan.stats.invalid + plan.stats.existing + plan.stats.skipped).toBeGreaterThan(0);
  });

  test("accounts for every named record in an isolated import when fixture present", async () => {
    const fixturePath = findOptionalSupplierFixture();
    if (!fixturePath) {
      return;
    }
    const buffer = fs.readFileSync(fixturePath);
    const rows = parseSupplierBalanceFile(buffer, path.basename(fixturePath));
    const named = rows.filter((r) => String(r.name ?? "").trim() && !isBalanceSummaryRow(r.name));
    const summary = await applySupplierBalanceImport(ctx.db, rows, { openingBalanceDate: "2024-01-01" });
    expect(summary.created + summary.existing + summary.updated + summary.rejected + summary.skipped).toBeGreaterThanOrEqual(named.length);
    expect(summary.created + summary.existing + summary.updated).toBe(named.filter((r) => r.balanceStatus === "ok").length);
    if (named.length === 237) {
      expect(summary.created + summary.existing).toBe(237);
      expect(summary.errors.every((e) => e.reason === "صف إجمالي — ليس مورداً" || e.reason === "الاسم مفقود" || e.reason.includes("مكرر"))).toBe(true);
    }
  });
});
