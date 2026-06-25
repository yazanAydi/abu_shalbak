import request from "supertest";
import XLSX from "xlsx";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import {
  parseHesabatiStatementMatrix,
  parseHesabatiStatementFile,
  verifyStatementRunningBalances,
} from "../utils/statementHistoryImport.js";
import { pdfTextToStatementMatrix } from "../utils/statementPdfImport.js";
import {
  buildStatementHistoryImportPlan,
  applyStatementHistoryImport,
  countExistingHistory,
} from "../utils/statementHistoryService.js";
import { getAccountStatement } from "../utils/accountStatementService.js";
import { mergePartyAccountStatement } from "../utils/accountStatementMerge.js";
import { HESABATI_OPENING_SOURCE } from "../utils/supplierImport.js";

function sampleStatementMatrix() {
  return [
    ["الرقم", "البيان", "التاريخ", "مدين", "دائن", "الرصيد", "ملاحظات"],
    ["2", "الرصيد المدور", "2024-01-01", "", "25,659.00", "-25,659.00", ""],
    ["42", "فاتورة مشتريات", "2024-01-05", "", "1,000.00", "-26,659.00", ""],
    ["7", "سند دفع", "2024-01-06", "400.00", "", "-26,259.00", ""],
  ];
}

function matrixToXlsxBuffer(matrix) {
  const ws = XLSX.utils.aoa_to_sheet(matrix);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

describe("statementHistoryImport", () => {
  /** @type {Awaited<ReturnType<typeof createTestContext>>} */
  let ctx;
  let adminToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    const loginRes = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = loginRes.body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("parseHesabatiStatementMatrix reads kashf columns", () => {
    const { rows, invalid, duplicates } = parseHesabatiStatementMatrix(sampleStatementMatrix());
    expect(rows).toHaveLength(3);
    expect(invalid).toBe(0);
    expect(duplicates).toBe(0);
    expect(rows[0].description).toBe("الرصيد المدور");
    expect(rows[0].credit).toBe(25659);
    expect(rows[0].running_balance).toBe(-25659);
    expect(rows[0].entry_date).toBe("2024-01-01");
  });

  test("verifyStatementRunningBalances detects chain mismatches", () => {
    const { rows } = parseHesabatiStatementMatrix(sampleStatementMatrix());
    const warnings = verifyStatementRunningBalances(rows);
    expect(warnings).toHaveLength(0);
  });

  test("pdfTextToStatementMatrix parses kashf text lines", () => {
    const text = `
كشف حساب مورد
الرقم  البيان  التاريخ  مدين  دائن  الرصيد  ملاحظات
2  الرصيد المدور  01/01/2024    25,659.00  -25,659.00
42  فاتورة مشتريات  05/01/2024    1,000.00  -26,659.00
7  سند دفع  06/01/2024  400.00    -26,259.00
`;
    const matrix = pdfTextToStatementMatrix(text);
    const { rows } = parseHesabatiStatementMatrix(matrix);
    expect(rows).toHaveLength(3);
    expect(rows[0].description).toBe("الرصيد المدور");
    expect(rows[0].running_balance).toBe(-25659);
    expect(rows[2].debit).toBe(400);
  });

  test("preview dry-run does not write to DB", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, opening_balance, balance) VALUES (?, ?, ?, ?)`,
      ["مورد كشف", "SH1", 0, 0]
    );
    const { rows } = parseHesabatiStatementMatrix(sampleStatementMatrix());
    const plan = await buildStatementHistoryImportPlan(ctx.db, "supplier", ins.lastID, rows, {
      invalidRows: 0,
      duplicateRows: 0,
    });
    expect(plan.blocked).toBe(false);
    expect(plan.stats.totalRows).toBe(3);
    const count = await countExistingHistory(ctx.db, "supplier", ins.lastID);
    expect(count).toBe(0);
  });

  test("confirm import saves rows for supplier only", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, opening_balance, balance) VALUES (?, ?, ?, ?)`,
      ["شركة أبناء الشلبي للتجارة", "2", 25659, 25659]
    );
    const supplierId = ins.lastID;
    const { rows } = parseHesabatiStatementMatrix(sampleStatementMatrix());
    const result = await applyStatementHistoryImport(ctx.db, "supplier", supplierId, rows, {
      sourceFileName: "kashf.xlsx",
    });
    expect(result.importedRows).toBe(3);

    const saved = await ctx.db.all(
      `SELECT * FROM account_statement_entries WHERE party_type = 'supplier' AND party_id = ? ORDER BY row_order`,
      [supplierId]
    );
    expect(saved).toHaveLength(3);
    expect(saved[0].description).toBe("الرصيد المدور");
    expect(saved[2].running_balance).toBe(-26259);
  });

  test("GET supplier statement shows imported history and hides opening-only row", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, opening_balance, opening_balance_excel, opening_balance_source, balance)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["شركة أبناء الشلبي للتجارة", "2", 25659, -25659, HESABATI_OPENING_SOURCE, 25659]
    );
    const supplierId = ins.lastID;
    await ctx.db.run(
      `INSERT INTO party_opening_entries (party_type, party_id, entry_date, description, debit, credit, source_type)
       VALUES ('supplier', ?, '2024-01-01', 'الرصيد المدور', 0, 25659, 'opening_balance_import')`,
      [supplierId]
    );
    const { rows } = parseHesabatiStatementMatrix(sampleStatementMatrix());
    await applyStatementHistoryImport(ctx.db, "supplier", supplierId, rows);

    const report = await getAccountStatement(ctx.db, {
      partyType: "supplier",
      partyId: supplierId,
      useDefaultRange: false,
    });

    expect(report.rows.length).toBeGreaterThanOrEqual(3);
    expect(report.rows[0].description).toBe("الرصيد المدور");
    expect(report.rows[0].runningBalanceFormatted).toBe("-25,659.00");
    const openingOnly = report.rows.filter((r) => r.notes === "مستورد من حساباتي" && r.description === "الرصيد المدور");
    expect(openingOnly.length).toBe(0);
  });

  test("live purchase after history updates final balance", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, opening_balance, balance) VALUES (?, ?, ?, ?)`,
      ["مورد مع فاتورة", "S9", 0, 0]
    );
    const supplierId = ins.lastID;
    const { rows } = parseHesabatiStatementMatrix([
      ["الرقم", "البيان", "التاريخ", "مدين", "دائن", "الرصيد", "ملاحظات"],
      ["1", "الرصيد المدور", "2024-01-01", "", "500.00", "-500.00", ""],
    ]);
    await applyStatementHistoryImport(ctx.db, "supplier", supplierId, rows);

    await ctx.db.run(
      `INSERT INTO purchase_invoices (supplier_id, invoice_date, total, status) VALUES (?, ?, ?, 'posted')`,
      [supplierId, "2024-02-01", 200]
    );

    const report = await getAccountStatement(ctx.db, {
      partyType: "supplier",
      partyId: supplierId,
      useDefaultRange: false,
    });
    const last = report.rows[report.rows.length - 1];
    expect(last.description).toBe("مشتريات فاتورة");
    expect(last.runningBalanceFormatted).toBe("-700.00");
  });

  test("re-import blocked without overwrite; overwrite replaces rows", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, opening_balance, balance) VALUES (?, ?, ?, ?)`,
      ["مورد إعادة", "R1", 0, 0]
    );
    const supplierId = ins.lastID;
    const matrix1 = [
      ["الرقم", "البيان", "التاريخ", "مدين", "دائن", "الرصيد", "ملاحظات"],
      ["1", "الرصيد المدور", "2024-01-01", "", "100.00", "-100.00", ""],
      ["2", "صف إضافي", "2024-01-02", "", "50.00", "-150.00", ""],
    ];
    const { rows: rows1 } = parseHesabatiStatementMatrix(matrix1);
    await applyStatementHistoryImport(ctx.db, "supplier", supplierId, rows1);

    const matrix2 = [
      ["الرقم", "البيان", "التاريخ", "مدين", "دائن", "الرصيد", "ملاحظات"],
      ["1", "الرصيد المدور", "2024-01-01", "", "200.00", "-200.00", ""],
    ];
    const { rows: rows2 } = parseHesabatiStatementMatrix(matrix2);
    const blockedPlan = await buildStatementHistoryImportPlan(ctx.db, "supplier", supplierId, rows2);
    expect(blockedPlan.blocked).toBe(true);

    await applyStatementHistoryImport(ctx.db, "supplier", supplierId, rows2, { overwriteExisting: true });
    const count = await countExistingHistory(ctx.db, "supplier", supplierId);
    expect(count).toBe(1);
  });

  test("customer workflow mirror", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, opening_balance, balance) VALUES (?, ?, ?, ?)`,
      ["عميل كشف", "C1", 1000, 1000]
    );
    const customerId = ins.lastID;
    const { rows } = parseHesabatiStatementMatrix([
      ["الرقم", "البيان", "التاريخ", "مدين", "دائن", "الرصيد", "ملاحظات"],
      ["C1", "الرصيد المدور", "2024-01-01", "1,000.00", "", "1,000.00", ""],
      ["10", "مبيعات", "2024-01-05", "500.00", "", "1,500.00", ""],
    ]);
    await applyStatementHistoryImport(ctx.db, "customer", customerId, rows);

    const report = await getAccountStatement(ctx.db, {
      partyType: "customer",
      partyId: customerId,
      useDefaultRange: false,
    });
    expect(report.rows).toHaveLength(2);
    expect(report.rows[1].runningBalanceFormatted).toBe("1,500.00");
  });

  test("date-range filter adds carried-forward opening row", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, opening_balance, balance) VALUES (?, ?, ?, ?)`,
      ["مورد نطاق", "DR1", 0, 0]
    );
    const supplierId = ins.lastID;
    const { rows } = parseHesabatiStatementMatrix(sampleStatementMatrix());
    await applyStatementHistoryImport(ctx.db, "supplier", supplierId, rows);

    const report = await getAccountStatement(ctx.db, {
      partyType: "supplier",
      partyId: supplierId,
      from: "2024-01-05",
      to: "2024-01-31",
      useDefaultRange: false,
    });
    expect(report.rows[0].description).toBe("الرصيد المدور");
    expect(report.rows[0].runningBalanceFormatted).toBe("-25,659.00");
    expect(report.rows.some((r) => r.description === "فاتورة مشتريات")).toBe(true);
  });

  test("API preview and confirm endpoints", async () => {
    const ins = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, opening_balance, balance) VALUES (?, ?, ?, ?)`,
      ["مورد API", "API1", 0, 0]
    );
    const supplierId = ins.lastID;
    const buffer = matrixToXlsxBuffer(sampleStatementMatrix());

    const previewRes = await request(ctx.app)
      .post(`/api/v1/suppliers/${supplierId}/statement-history/preview`)
      .set(authHeader(adminToken))
      .attach("file", buffer, "kashf.xlsx");
    expect(previewRes.status).toBe(200);
    expect(previewRes.body.data.stats.totalRows).toBe(3);

    const confirmRes = await request(ctx.app)
      .post(`/api/v1/suppliers/${supplierId}/statement-history/confirm`)
      .set(authHeader(adminToken))
      .attach("file", buffer, "kashf.xlsx");
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.data.importedRows).toBe(3);

    const stmtRes = await request(ctx.app)
      .get(`/api/v1/suppliers/${supplierId}/statement`)
      .set(authHeader(adminToken));
    expect(stmtRes.status).toBe(200);
    expect(stmtRes.body.data.rows.length).toBeGreaterThanOrEqual(3);
  });

  test("mergePartyAccountStatement chains live from last history balance", async () => {
    const party = { id: 1, name: "Test", supplier_code: "1", contact_phone: null, balance: 0 };
    const allHistory = [
      {
        id: 1,
        legacy_reference_number: "1",
        entry_date: "2024-01-01",
        description: "الرصيد المدور",
        debit: 0,
        credit: 500,
        running_balance: -500,
        notes: null,
      },
    ];
    const ledger = {
      events: [
        { ev_type: "purchase", ev_date: "2024-02-01", debit: 0, credit: 200, ref_id: 99, notes: "" },
      ],
    };
    const merged = await mergePartyAccountStatement(
      ctx.db,
      "supplier",
      party,
      ledger,
      allHistory,
      {},
      {}
    );
    expect(merged.rows).toHaveLength(2);
    expect(merged.rows[1].balance_formatted).toBe("-700.00");
  });
});
