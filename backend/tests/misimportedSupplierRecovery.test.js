import XLSX from "xlsx";
import request from "supertest";
import { applyCustomerBalanceImport } from "../utils/customerImport.js";
import { parseSupplierBalanceFile, applySupplierBalanceImport } from "../utils/supplierImport.js";
import {
  planMisimportedSupplierRecovery,
  applyMisimportedSupplierRecovery,
  customerMatchesMisimportFingerprint,
} from "../utils/misimportedSupplierRecovery.js";
import { getBalanceGroupIdForImportType } from "../utils/balanceGroups.js";
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

describe("misimported supplier recovery", () => {
  let ctx;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("customer zero-balance import creates عميل آجل and does not store Excel الرقم as customer_code", async () => {
    const summary = await applyCustomerBalanceImport(
      ctx.db,
      [
        {
          rowNum: 2,
          code: "148",
          name: "شركة عنبتاوي توباكو",
          phone: null,
          balance: 0,
          price_category: "credit",
          notesTag: null,
          importType: "hesabati_customer_balances",
        },
      ],
      { importZeroBalances: true }
    );
    expect(summary.created).toBe(1);
    const c = await ctx.db.get("SELECT * FROM customers WHERE name = ?", ["شركة عنبتاوي توباكو"]);
    expect(c.price_category).toBe("credit");
    expect(c.opening_balance).toBe(0);
    expect(c.balance).toBe(0);
    expect(String(c.customer_code)).not.toBe("148");
    expect(c.id).not.toBe(148);
    const zaboonId = await getBalanceGroupIdForImportType(ctx.db, "hesabati_customer_balances");
    expect(customerMatchesMisimportFingerprint(c, zaboonId)).toBe(true);
  });

  test("supplier import of the same zeros creates suppliers without duplicating on repeat", async () => {
    const buf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [171, "شركة عنبتاوي توباكو / دخان", 0],
    ]);
    const rows = parseSupplierBalanceFile(buf, "missing-suppliers.xlsx");
    const first = await applySupplierBalanceImport(ctx.db, rows, { openingBalanceDate: "2024-08-01" });
    expect(first.created).toBe(1);
    expect(first.destination).toBe("supplier");
    const second = await applySupplierBalanceImport(ctx.db, rows, { openingBalanceDate: "2024-09-01" });
    expect(second.created).toBe(0);
    expect(second.existing).toBe(1);
    const count = await ctx.db.get(
      `SELECT COUNT(*) AS n FROM suppliers WHERE supplier_code = ?`,
      ["171"]
    );
    expect(count.n).toBe(1);
    const openings = await ctx.db.get(
      `SELECT COUNT(*) AS n FROM party_opening_entries poe
       JOIN suppliers s ON s.id = poe.party_id
       WHERE s.supplier_code = '171'`
    );
    expect(openings.n).toBe(0);
  });

  test("recovery matches fingerprint, not Excel ID = customer id/code", async () => {
    const zaboonId = await getBalanceGroupIdForImportType(ctx.db, "hesabati_customer_balances");
    await ctx.db.run(
      `INSERT INTO customers (id, name, price_category, opening_balance, balance, customer_code, notes, balance_group_id)
       VALUES (99, 'شخص آخر', 'retail', 0, 0, 'OTHER-99', NULL, ?)`,
      [zaboonId]
    );
    await applyCustomerBalanceImport(
      ctx.db,
      [
        {
          rowNum: 2,
          code: "99",
          name: "مورد تسعون",
          phone: null,
          balance: 0,
          price_category: "credit",
          notesTag: null,
          importType: "hesabati_customer_balances",
        },
      ],
      { importZeroBalances: true }
    );
    const mistaken = await ctx.db.get("SELECT * FROM customers WHERE name = ?", ["مورد تسعون"]);
    expect(mistaken.id).not.toBe(99);
    expect(String(mistaken.customer_code)).not.toBe("99");

    const buf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [99, "مورد تسعون", 0],
    ]);
    const plan = await planMisimportedSupplierRecovery(ctx.db, buf, "missing-suppliers.xlsx");
    const row = plan.rows.find((r) => r.excelCode === "99");
    expect(row.customerAction).toBe("delete_safe");
    expect(row.customerId).toBe(mistaken.id);
    expect(row.usedExcelIdAsCustomerKey).toBe(false);
    expect(row.excelCodeEqualsCustomerId).toBe(false);
    expect(row.supplierAction).toBe("create");
    const other = await ctx.db.get("SELECT name FROM customers WHERE id = 99");
    expect(other.name).toBe("شخص آخر");
  });

  test("same name without fingerprint is review_mismatch and is not deleted", async () => {
    const zaboonId = await getBalanceGroupIdForImportType(ctx.db, "hesabati_customer_balances");
    await ctx.db.run(
      `INSERT INTO customers (name, price_category, opening_balance, balance, customer_code, notes, balance_group_id)
       VALUES ('مورد نقدي', 'retail', 0, 0, 'C-CASH', NULL, ?)`,
      [zaboonId]
    );
    const buf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [501, "مورد نقدي", 0],
    ]);
    const plan = await planMisimportedSupplierRecovery(ctx.db, buf, "missing-suppliers.xlsx");
    const row = plan.rows.find((r) => r.excelCode === "501");
    expect(row.customerAction).toBe("review_mismatch");
    const applied = await applyMisimportedSupplierRecovery(ctx.db, buf, "missing-suppliers.xlsx", {
      deleteCustomers: true,
    });
    expect(applied.customersDeleted).toBe(0);
    const still = await ctx.db.get("SELECT id FROM customers WHERE name = ?", ["مورد نقدي"]);
    expect(still).toBeTruthy();
    const supplier = await ctx.db.get("SELECT * FROM suppliers WHERE supplier_code = ?", ["501"]);
    expect(supplier).toBeTruthy();
  });

  test("fingerprint customer with a sale is review_linked and is not deleted", async () => {
    await applyCustomerBalanceImport(
      ctx.db,
      [
        {
          rowNum: 2,
          code: "502",
          name: "مورد له مبيعات",
          phone: null,
          balance: 0,
          price_category: "credit",
          notesTag: null,
          importType: "hesabati_customer_balances",
        },
      ],
      { importZeroBalances: true }
    );
    const c = await ctx.db.get("SELECT * FROM customers WHERE name = ?", ["مورد له مبيعات"]);
    const admin = await ctx.db.get("SELECT id FROM users WHERE username = ?", ["testadmin"]);
    await ctx.db.run(
      `INSERT INTO transactions (cashier_id, items_json, subtotal, tax, total, payment_method, customer_id, status)
       VALUES (?, '[]', 10, 0, 10, 'cash', ?, 'completed')`,
      [admin.id, c.id]
    );
    const buf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [502, "مورد له مبيعات", 0],
    ]);
    const plan = await planMisimportedSupplierRecovery(ctx.db, buf, "missing-suppliers.xlsx");
    const row = plan.rows.find((r) => r.excelCode === "502");
    expect(row.customerAction).toBe("review_linked");
    expect(row.links).toContain("مبيعات");
    const applied = await applyMisimportedSupplierRecovery(ctx.db, buf, "missing-suppliers.xlsx", {
      deleteCustomers: true,
    });
    expect(applied.customersDeleted).toBe(0);
    const still = await ctx.db.get("SELECT id FROM customers WHERE id = ?", [c.id]);
    expect(still).toBeTruthy();
  });

  test("apply creates missing supplier and deletes only safe mistaken customer", async () => {
    await applyCustomerBalanceImport(
      ctx.db,
      [
        {
          rowNum: 2,
          code: "503",
          name: "مورد آمن للحذف",
          phone: null,
          balance: 0,
          price_category: "credit",
          notesTag: null,
          importType: "hesabati_customer_balances",
        },
      ],
      { importZeroBalances: true }
    );
    const before = await ctx.db.get("SELECT * FROM customers WHERE name = ?", ["مورد آمن للحذف"]);
    const buf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [503, "مورد آمن للحذف", 0],
    ]);
    const dry = await applyMisimportedSupplierRecovery(ctx.db, buf, "missing-suppliers.xlsx", {
      deleteCustomers: false,
    });
    expect(dry.suppliersCreated).toBe(1);
    expect(dry.customersDeleted).toBe(0);
    expect(await ctx.db.get("SELECT id FROM customers WHERE id = ?", [before.id])).toBeTruthy();

    const applied = await applyMisimportedSupplierRecovery(ctx.db, buf, "missing-suppliers.xlsx", {
      deleteCustomers: true,
    });
    expect(applied.suppliersCreated).toBe(0);
    expect(applied.suppliersExisting).toBe(1);
    expect(applied.customersDeleted).toBe(1);
    expect(await ctx.db.get("SELECT id FROM customers WHERE id = ?", [before.id])).toBeFalsy();
    const supplier = await ctx.db.get("SELECT * FROM suppliers WHERE supplier_code = ?", ["503"]);
    expect(supplier.name).toBe("مورد آمن للحذف");
    expect(supplier.balance).toBe(0);
  });

  test("ambiguous duplicate fingerprint names stay for review", async () => {
    const zaboonId = await getBalanceGroupIdForImportType(ctx.db, "hesabati_customer_balances");
    await ctx.db.run(
      `INSERT INTO customers (name, price_category, opening_balance, balance, customer_code, notes, balance_group_id)
       VALUES ('اسم مكرر', 'credit', 0, 0, 'DUP-A', NULL, ?)`,
      [zaboonId]
    );
    await ctx.db.run(
      `INSERT INTO customers (name, price_category, opening_balance, balance, customer_code, notes, balance_group_id)
       VALUES ('اسم مكرر', 'credit', 0, 0, 'DUP-B', NULL, ?)`,
      [zaboonId]
    );
    const buf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [504, "اسم مكرر", 0],
    ]);
    const plan = await planMisimportedSupplierRecovery(ctx.db, buf, "missing-suppliers.xlsx");
    expect(plan.rows.find((r) => r.excelCode === "504").customerAction).toBe("review_ambiguous");
    const applied = await applyMisimportedSupplierRecovery(ctx.db, buf, "missing-suppliers.xlsx", {
      deleteCustomers: true,
    });
    expect(applied.customersDeleted).toBe(0);
    const n = await ctx.db.get(`SELECT COUNT(*) AS n FROM customers WHERE name = 'اسم مكرر'`);
    expect(n.n).toBe(2);
  });
});

describe("misimported supplier recovery HTTP", () => {
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

  test("preview and confirm recovery endpoints", async () => {
    await applyCustomerBalanceImport(
      ctx.db,
      [
        {
          rowNum: 2,
          code: "777",
          name: "مورد HTTP استرداد",
          phone: null,
          balance: 0,
          price_category: "credit",
          notesTag: null,
          importType: "hesabati_customer_balances",
        },
      ],
      { importZeroBalances: true }
    );
    const buf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [777, "مورد HTTP استرداد", 0],
    ]);
    const preview = await request(ctx.app)
      .post("/api/v1/admin/import/supplier-recovery/preview")
      .set(authHeader(adminToken))
      .attach("file", buf, { filename: "missing-suppliers.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    expect(preview.status).toBe(200);
    const plan = preview.body.data ?? preview.body;
    expect(plan.destination).toBe("supplier");
    expect(plan.stats.suppliersToCreate).toBe(1);
    expect(plan.stats.customersSafeToDelete).toBe(1);

    const confirm = await request(ctx.app)
      .post("/api/v1/admin/import/supplier-recovery/confirm?delete_customers=1")
      .set(authHeader(adminToken))
      .attach("file", buf, { filename: "missing-suppliers.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    expect(confirm.status).toBe(200);
    const body = confirm.body.data ?? confirm.body;
    expect(body.suppliersCreated).toBe(1);
    expect(body.customersDeleted).toBe(1);
    expect(await ctx.db.get("SELECT id FROM customers WHERE name = ?", ["مورد HTTP استرداد"])).toBeFalsy();
    expect(await ctx.db.get("SELECT id FROM suppliers WHERE supplier_code = ?", ["777"])).toBeTruthy();
  });
});
