import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import {
  formatHesabatiStatement,
  formatSupplierHesabatiStatement,
  formatExcelSignedAmount,
} from "../utils/hesabatiStatementFormat.js";
import { buildSupplierLedger } from "../utils/supplierLedger.js";
import { buildCustomerLedger } from "../utils/customerLedger.js";
import { HESABATI_OPENING_SOURCE } from "../utils/supplierImport.js";

describe("hesabatiStatementFormat", () => {
  test("formatExcelSignedAmount uses prefix minus", () => {
    expect(formatExcelSignedAmount(-25659)).toBe("-25,659.00");
    expect(formatExcelSignedAmount(10000)).toBe("10,000.00");
  });

  test("supplier imported opening row uses Excel sign and الرصيد المدور", () => {
    const ledger = {
      excel_opening_balance: -25659,
      excel_closing_balance: -25659,
      opening_entry: { id: 1, entry_date: "2024-01-01" },
      opening: { ev_date: "2024-01-01", ref_id: 1 },
      events: [],
    };
    const party = {
      id: 1,
      name: "شركة أبناء الشلبي للتجارة",
      supplier_code: "2",
      contact_phone: null,
      opening_balance: 25659,
      opening_balance_excel: -25659,
      opening_balance_date: "2024-01-01",
      opening_balance_source: HESABATI_OPENING_SOURCE,
      balance: 25659,
    };
    const out = formatSupplierHesabatiStatement(party, ledger);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].description).toBe("الرصيد المدور");
    expect(out.rows[0].line_no).toBe("2");
    expect(out.rows[0].debit).toBe(0);
    expect(out.rows[0].credit).toBe(25659);
    expect(out.rows[0].balance).toBe(-25659);
    expect(out.rows[0].balance_formatted).toBe("-25,659.00");
    expect(out.rows[0].notes).toBe("مستورد من حساباتي");
    expect(out.totals.final_balance).toBe(-25659);
  });

  test("supplier positive Excel opening", () => {
    const ledger = {
      excel_opening_balance: 10000,
      excel_closing_balance: 10000,
      opening: { ev_date: "2024-02-01" },
      events: [],
    };
    const party = {
      id: 2,
      name: "مورد موجب",
      supplier_code: "5",
      opening_balance: -10000,
      opening_balance_excel: 10000,
      opening_balance_source: HESABATI_OPENING_SOURCE,
      balance: -10000,
    };
    const out = formatSupplierHesabatiStatement(party, ledger);
    expect(out.rows[0].debit).toBe(10000);
    expect(out.rows[0].credit).toBe(0);
    expect(out.rows[0].balance).toBe(10000);
  });

  test("supplier purchase and payment rows use Excel running balance", () => {
    const ledger = {
      excel_opening_balance: 0,
      excel_closing_balance: -600,
      opening: { ev_date: null },
      events: [
        {
          ev_type: "purchase",
          ev_date: "2024-01-05",
          debit: 0,
          credit: 1000,
          ref_id: 42,
          running_balance: 1000,
        },
        {
          ev_type: "payment",
          ev_date: "2024-01-06",
          debit: 400,
          credit: 0,
          ref_id: 7,
          running_balance: 600,
        },
      ],
    };
    const out = formatSupplierHesabatiStatement(
      { id: 1, name: "Test Supplier", supplier_code: "5", contact_phone: "050", opening_balance: 0, balance: 600 },
      ledger
    );
    expect(out.rows).toHaveLength(3);
    expect(out.rows[1].description).toBe("مشتريات فاتورة");
    expect(out.rows[1].credit).toBe(1000);
    expect(out.rows[1].balance).toBe(-1000);
    expect(out.rows[2].description).toBe("دفع سند");
    expect(out.rows[2].debit).toBe(400);
    expect(out.rows[2].balance_formatted).toBe("-600.00");
  });

  test("customer sale and receipt rows unchanged", () => {
    const ledger = {
      opening: {
        ev_type: "opening",
        ev_date: null,
        debit: 100,
        credit: 0,
        ref_id: null,
        running_balance: 100,
      },
      events: [
        {
          ev_type: "sale",
          ev_date: "2024-02-01",
          debit: 50,
          credit: 0,
          ref_id: 10,
          running_balance: 150,
        },
        {
          ev_type: "payment",
          ev_date: "2024-02-02",
          debit: 0,
          credit: 30,
          ref_id: 3,
          running_balance: 120,
        },
      ],
      closing_balance: 120,
    };
    const out = formatHesabatiStatement(
      "customer",
      { id: 2, name: "Test Customer", customer_code: "12", phone: "059", opening_balance: 100, balance: 120 },
      ledger
    );
    expect(out.rows[1].description).toBe("مبيعات فاتورة");
    expect(out.rows[2].description).toBe("قبض سند");
    expect(out.rows[2].balance_formatted).toBe("120.00");
  });
});

describe("hesabati statement API", () => {
  let ctx;
  let adminToken;
  let supplierId;
  let importedSupplierId;
  let customerId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123");
    adminToken = adminLogin.body.token;

    const sup = await ctx.db.run(
      `INSERT INTO suppliers (name, supplier_code, balance, opening_balance)
       VALUES (?, ?, ?, ?)`,
      ["Test Supplier", "1", 500, 500]
    );
    supplierId = sup.lastID;

    await ctx.db.run(
      `INSERT INTO purchase_invoices (supplier_id, invoice_date, total, status)
       VALUES (?, ?, ?, 'posted')`,
      [supplierId, "2024-03-01", 200]
    );

    const imported = await ctx.db.run(
      `INSERT INTO suppliers
        (name, supplier_code, balance, opening_balance, opening_balance_excel,
         opening_balance_date, opening_balance_source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["شركة أبناء الشلبي للتجارة", "2", 25659, 25659, -25659, "2024-01-01", HESABATI_OPENING_SOURCE]
    );
    importedSupplierId = imported.lastID;
    await ctx.db.run(
      `INSERT INTO party_opening_entries
        (party_type, party_id, entry_date, description, debit, credit, source_type, notes)
       VALUES ('supplier', ?, ?, 'رصيد افتتاحي من نظام حساباتي', 0, 25659, 'opening_balance_import', 'Imported from Hesabati supplier balances file')`,
      [importedSupplierId, "2024-01-01"]
    );

    const cust = await ctx.db.run(
      `INSERT INTO customers (name, customer_code, balance, opening_balance)
       VALUES (?, ?, ?, ?)`,
      ["Test Customer", "2", 300, 300]
    );
    customerId = cust.lastID;

    const adminUser = await ctx.db.get("SELECT id FROM users WHERE username = 'testadmin'");

    const vIns = await ctx.db.run(
      `INSERT INTO vouchers (voucher_type, voucher_no, voucher_date, status, total_amount, recorded_by_id)
       VALUES ('receipt', 1, '2024-03-02', 'posted', 75, ?)`,
      [adminUser.id]
    );
    await ctx.db.run(
      `INSERT INTO voucher_lines (voucher_id, line_type, amount, amount_nis, customer_id)
       VALUES (?, 'cash', 75, 75, ?)`,
      [vIns.lastID, customerId]
    );
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("buildSupplierLedger includes excel opening for imported supplier", async () => {
    const supplier = await ctx.db.get("SELECT * FROM suppliers WHERE id = ?", [importedSupplierId]);
    const ledger = await buildSupplierLedger(ctx.db, supplier);
    expect(ledger.excel_opening_balance).toBe(-25659);
    expect(ledger.opening_entry).toBeTruthy();
  });

  test("GET imported supplier statement shows opening row", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/suppliers/${importedSupplierId}/statement?from=2024-01-01&to=2024-12-31`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.party.code).toBe("2");
    expect(body.rows[0].description).toBe("الرصيد المدور");
    expect(body.rows[0].credit).toBe(25659);
    expect(body.rows[0].runningBalance).toBe(-25659);
    expect(body.rows[0].runningBalanceFormatted).toBe("-25,659.00");
    expect(body.rows[0].notes).toBe("مستورد من حساباتي");
    expect(body.totals.finalBalance).toBe(-25659);
    expect(body.totals.finalBalanceFormatted).toBe("-25,659.00");
  });

  test("buildSupplierLedger includes purchases", async () => {
    const supplier = await ctx.db.get("SELECT * FROM suppliers WHERE id = ?", [supplierId]);
    const ledger = await buildSupplierLedger(ctx.db, supplier);
    expect(ledger.events.some((e) => e.ev_type === "purchase")).toBe(true);
  });

  test("GET supplier statement returns Hesabati rows", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/suppliers/${supplierId}/statement`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.party_type).toBe("supplier");
    expect(Array.isArray(body.rows)).toBe(true);
    const descriptions = body.formatted?.rows?.map((r) => r.description) || body.rows.map((r) => r.description);
    expect(descriptions.some((d) => d === "مشتريات فاتورة")).toBe(true);
    expect(descriptions.some((d) => d === "الرصيد المدور")).toBe(true);
  });

  test("buildCustomerLedger includes receipt vouchers", async () => {
    const customer = await ctx.db.get("SELECT * FROM customers WHERE id = ?", [customerId]);
    const ledger = await buildCustomerLedger(ctx.db, customer);
    expect(ledger.events.some((e) => e.ev_type === "payment")).toBe(true);
  });

  test("GET customer statement returns Hesabati rows", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/customers/${customerId}/statement`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.party_type).toBe("customer");
    const descriptions = body.formatted?.rows?.map((r) => r.description) || body.rows.map((r) => r.description);
    expect(descriptions.some((d) => d === "قبض سند")).toBe(true);
  });

  test("GET reports account-statement unified endpoint", async () => {
    const res = await request(ctx.app)
      .get(`/api/v1/reports/account-statement?partyType=supplier&partyId=${importedSupplierId}&from=2024-01-01&to=2024-12-31`)
      .set(authHeader(adminToken));
    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body;
    expect(body.report_title).toBe("كشف حساب مورد");
    expect(body.totals).toBeDefined();
    expect(body.totals.finalBalance).toBe(-25659);
  });
});
