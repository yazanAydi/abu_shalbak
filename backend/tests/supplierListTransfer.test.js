import request from "supertest";
import XLSX from "xlsx";
import { parseSupplierBalanceFile, importSupplierBalancesFromBuffer, previewSupplierBalancesFromBuffer } from "../utils/supplierImport.js";
import {
  buildAbuShalbakSupplierListCsv,
  applySupplierListTransfer,
  SUPPLIER_CSV_TRANSFER_SOURCE,
  TRANSFER_OPENING_ENTRY_SOURCE_TYPE,
  ABU_SHALBAK_SUPPLIER_LIST_TYPE,
} from "../utils/supplierListTransfer.js";
import { UNSIGNED_ABU_SHALBAK_SUPPLIER_EXPORT_ERROR, ABU_SHALBAK_SUPPLIER_LIST_RECOVERY_ERROR } from "../utils/importDetect.js";
import { planMisimportedSupplierRecovery } from "../utils/misimportedSupplierRecovery.js";
import { HESABATI_OPENING_SOURCE } from "../utils/supplierImport.js";
import { createTestContext, destroyTestContext, login, authHeader } from "./helpers.js";

function xlsxBuffer(rows) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function signedTransferCsv(suppliers) {
  return Buffer.from(buildAbuShalbakSupplierListCsv(suppliers), "utf8");
}

describe("supplier list CSV transfer", () => {
  test("export helper produces signed CSV: payable +100, credit -40, zero 0.00", () => {
    const csv = buildAbuShalbakSupplierListCsv([
      { supplier_code: "1", name: "مستحق", contact_phone: "0599", payment_terms: "صافي 30", balance: 100 },
      { supplier_code: "2", name: "دائن", contact_phone: "", payment_terms: "", balance: -40 },
      { supplier_code: "3", name: "صفر", balance: 0 },
    ]);
    expect(csv).toContain("الرصيد (مستحق)");
    expect(csv).toContain('"100.00"');
    expect(csv).toContain("\"'-40.00\"");
    expect(csv).toContain('"0.00"');
    expect(csv).not.toContain("₪");
    expect(csv).not.toContain("—");
  });

  test("parses signed system CSV without Hesabati sign flip", () => {
    const buf = signedTransferCsv([
      { supplier_code: "1", name: "مستحق", balance: 100 },
      { supplier_code: "2", name: "دائن", balance: -40 },
      { supplier_code: "3", name: "صفر", balance: 0 },
    ]);
    const rows = parseSupplierBalanceFile(buf, "suppliers-2026-09-13.csv");
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.importType === ABU_SHALBAK_SUPPLIER_LIST_TYPE)).toBe(true);
    expect(rows.find((r) => r.name === "مستحق")?.systemBalance).toBe(100);
    expect(rows.find((r) => r.name === "دائن")?.systemBalance).toBe(-40);
    expect(rows.find((r) => r.name === "صفر")?.systemBalance).toBe(0);
  });

  test("Hesabati xlsx still flips -290 to system +290", () => {
    const buf = xlsxBuffer([
      ["الرقم", "الاسم", "الرصيد"],
      [1, "البان القصير", -290],
    ]);
    const rows = parseSupplierBalanceFile(buf, "أرصدة الموردين.xlsx");
    expect(rows[0].importType).toBe("hesabati_supplier_balances");
    expect(rows[0].excelBalance).toBe(-290);
    expect(rows[0].systemBalance).toBe(290);
  });

  test("old unsigned ₪ export is rejected", () => {
    const csv =
      "\uFEFF\"الرقم\",\"الاسم\",\"الهاتف\",\"شروط الدفع\",\"الرصيد (مستحق)\"\n" +
      "\"1\",\"مورد\",\"\",\"\",\"₪100.00\"\n";
    expect(() => parseSupplierBalanceFile(Buffer.from(csv, "utf8"), "suppliers-2026-09-08.csv")).toThrow(
      UNSIGNED_ABU_SHALBAK_SUPPLIER_EXPORT_ERROR
    );
  });
});

describe("supplier list transfer between two isolated databases", () => {
  let source;
  let dest;

  beforeAll(async () => {
    source = await createTestContext();
    dest = await createTestContext();
    await source.db.run(
      `INSERT INTO suppliers (name, supplier_code, contact_phone, payment_terms, opening_balance, balance)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["مورد مستحق", "10", "0599000001", "صافي 30", 100, 100]
    );
    await source.db.run(
      `INSERT INTO suppliers (name, supplier_code, opening_balance, balance)
       VALUES (?, ?, ?, ?)`,
      ["مورد دائن", "11", -40, -40]
    );
    await source.db.run(
      `INSERT INTO suppliers (name, supplier_code, opening_balance, balance)
       VALUES (?, ?, ?, ?)`,
      ["مورد صفر", "12", 0, 0]
    );
    await source.db.run(
      `INSERT INTO suppliers (name, supplier_code, opening_balance, balance)
       VALUES (?, ?, ?, ?)`,
      ["oo", "test", 0, 0]
    );
  });

  afterAll(async () => {
    await destroyTestContext(source);
    await destroyTestContext(dest);
  });

  function sourceCatalogCsv() {
    return signedTransferCsv([
      { supplier_code: "10", name: "مورد مستحق", contact_phone: "0599000001", payment_terms: "صافي 30", balance: 100 },
      { supplier_code: "11", name: "مورد دائن", balance: -40 },
      { supplier_code: "12", name: "مورد صفر", balance: 0 },
      { supplier_code: "test", name: "oo", balance: 0 },
    ]);
  }

  test("imports payable, credit, and zero into a second DB; credit stays negative; zero has no opening", async () => {
    const summary = await importSupplierBalancesFromBuffer(
      dest.db,
      sourceCatalogCsv(),
      "suppliers-2026-09-13.csv",
      { openingBalanceDate: "2026-09-13" }
    );
    expect(summary.type).toBe(ABU_SHALBAK_SUPPLIER_LIST_TYPE);
    expect(summary.created).toBe(3);
    expect(summary.excluded).toBe(1);

    const payable = await dest.db.get("SELECT * FROM suppliers WHERE name = ?", ["مورد مستحق"]);
    const credit = await dest.db.get("SELECT * FROM suppliers WHERE name = ?", ["مورد دائن"]);
    const zero = await dest.db.get("SELECT * FROM suppliers WHERE name = ?", ["مورد صفر"]);
    const testRow = await dest.db.get("SELECT * FROM suppliers WHERE name = ?", ["oo"]);

    expect(payable.balance).toBe(100);
    expect(payable.opening_balance).toBe(100);
    expect(payable.opening_balance_source).toBe(SUPPLIER_CSV_TRANSFER_SOURCE);
    expect(payable.supplier_code).toBe("10");
    expect(credit.balance).toBe(-40);
    expect(credit.opening_balance).toBe(-40);
    expect(zero.balance).toBe(0);
    expect(zero.opening_balance_date).toBeNull();
    expect(testRow).toBeFalsy();

    const payableEntry = await dest.db.get(
      `SELECT * FROM party_opening_entries WHERE party_type = 'supplier' AND party_id = ?`,
      [payable.id]
    );
    const zeroEntry = await dest.db.get(
      `SELECT * FROM party_opening_entries WHERE party_type = 'supplier' AND party_id = ?`,
      [zero.id]
    );
    expect(payableEntry.source_type).toBe(TRANSFER_OPENING_ENTRY_SOURCE_TYPE);
    expect(zeroEntry).toBeFalsy();
    expect(credit.opening_balance_source).not.toBe(HESABATI_OPENING_SOURCE);
  });

  test("same الرقم on dest for another name creates a new supplier and leaves dest unchanged", async () => {
    const isolated = await createTestContext();
    try {
      await isolated.db.run(
        `INSERT INTO suppliers (name, supplier_code, opening_balance, balance) VALUES (?, ?, ?, ?)`,
        ["شخص آخر", "10", 7, 7]
      );
      const csv = signedTransferCsv([
        { supplier_code: "10", name: "مورد من المصدر", balance: 100 },
      ]);
      const plan = await previewSupplierBalancesFromBuffer(isolated.db, csv, "suppliers-2026-09-13.csv");
      expect(plan.rows[0].action).toBe("create");
      expect(plan.rows[0].codeReassigned).toBe(true);
      expect(plan.stats.conflicts).toBe(1);

      const summary = await applySupplierListTransfer(isolated.db, parseSupplierBalanceFile(csv, "suppliers-2026-09-13.csv"), {
        openingBalanceDate: "2026-09-13",
      });
      expect(summary.created).toBe(1);
      expect(summary.conflicts).toBe(1);

      const original = await isolated.db.get("SELECT * FROM suppliers WHERE supplier_code = ?", ["10"]);
      expect(original.name).toBe("شخص آخر");
      expect(original.balance).toBe(7);

      const created = await isolated.db.get("SELECT * FROM suppliers WHERE name = ?", ["مورد من المصدر"]);
      expect(created).toBeTruthy();
      expect(created.supplier_code).not.toBe("10");
      expect(created.balance).toBe(100);
    } finally {
      await destroyTestContext(isolated);
    }
  });

  test("same الاسم already on dest is existing and dest balance is unchanged", async () => {
    const isolated = await createTestContext();
    try {
      await isolated.db.run(
        `INSERT INTO suppliers (name, supplier_code, opening_balance, balance) VALUES (?, ?, ?, ?)`,
        ["مورد موجود", "99", 50, 50]
      );
      const csv = signedTransferCsv([
        { supplier_code: "1", name: "مورد موجود", balance: 100 },
      ]);
      const plan = await previewSupplierBalancesFromBuffer(isolated.db, csv, "suppliers-2026-09-13.csv");
      expect(plan.rows[0].action).toBe("existing");

      const summary = await importSupplierBalancesFromBuffer(isolated.db, csv, "suppliers-2026-09-13.csv", {
        overwriteExistingOpeningBalances: true,
        force: true,
        openingBalanceDate: "2026-09-13",
      });
      expect(summary.created).toBe(0);
      expect(summary.existing).toBe(1);
      const row = await isolated.db.get("SELECT * FROM suppliers WHERE name = ?", ["مورد موجود"]);
      expect(row.balance).toBe(50);
      expect(row.supplier_code).toBe("99");
      const openings = await isolated.db.all(
        `SELECT * FROM party_opening_entries WHERE party_type = 'supplier' AND party_id = ?`,
        [row.id]
      );
      expect(openings).toHaveLength(0);
    } finally {
      await destroyTestContext(isolated);
    }
  });

  test("repeat import creates nothing and adds no opening rows", async () => {
    const first = await importSupplierBalancesFromBuffer(
      dest.db,
      sourceCatalogCsv(),
      "suppliers-2026-09-13.csv",
      { openingBalanceDate: "2026-09-13" }
    );
    expect(first.created).toBe(0);
    expect(first.existing).toBe(3);

    const openings = await dest.db.get(
      `SELECT COUNT(*) AS n FROM party_opening_entries WHERE source_type = ?`,
      [TRANSFER_OPENING_ENTRY_SOURCE_TYPE]
    );
    expect(Number(openings.n)).toBe(2);
  });

  test("oo / test included when include_test_rows=1", async () => {
    const isolated = await createTestContext();
    try {
      const csv = signedTransferCsv([{ supplier_code: "test", name: "oo", balance: 0 }]);
      const excluded = await previewSupplierBalancesFromBuffer(isolated.db, csv, "suppliers-2026-09-13.csv");
      expect(excluded.rows[0].action).toBe("exclude");
      expect(excluded.stats.excluded).toBe(1);

      const included = await importSupplierBalancesFromBuffer(isolated.db, csv, "suppliers-2026-09-13.csv", {
        includeTestRows: true,
        openingBalanceDate: "2026-09-13",
      });
      expect(included.created).toBe(1);
      expect(included.excluded).toBe(0);
      const row = await isolated.db.get("SELECT * FROM suppliers WHERE name = ?", ["oo"]);
      expect(row.supplier_code).toBe("test");
    } finally {
      await destroyTestContext(isolated);
    }
  });

  test("recovery rejects a system supplier list CSV", async () => {
    await expect(
      planMisimportedSupplierRecovery(dest.db, sourceCatalogCsv(), "suppliers-2026-09-13.csv")
    ).rejects.toThrow(ABU_SHALBAK_SUPPLIER_LIST_RECOVERY_ERROR);
  });
});

describe("supplier list transfer HTTP and catalog export", () => {
  let ctx;
  let token;

  beforeAll(async () => {
    ctx = await createTestContext();
    const loginRes = await login(ctx.app, "testadmin", "adminpass123");
    token = loginRes.body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  test("GET /api/suppliers?all=1 returns more than the default 500 cap", async () => {
    for (let i = 0; i < 510; i += 1) {
      await ctx.db.run("INSERT INTO suppliers (name, supplier_code) VALUES (?, ?)", [`كتالوج ${i}`, `ALL${i}`]);
    }
    const limited = await request(ctx.app).get("/api/v1/suppliers").set(authHeader(token));
    const all = await request(ctx.app).get("/api/v1/suppliers?all=1").set(authHeader(token));
    const limitedRows = limited.body.data ?? limited.body;
    const allRows = all.body.data ?? all.body;
    expect(limited.status).toBe(200);
    expect(all.status).toBe(200);
    expect(limitedRows.length).toBe(500);
    expect(allRows.length).toBeGreaterThan(500);
  });

  test("POST supplier-balances/preview and confirm transfer a signed CSV", async () => {
    const csv = signedTransferCsv([
      { supplier_code: "T1", name: "مورد نقل HTTP", balance: -12.5 },
    ]);
    const preview = await request(ctx.app)
      .post("/api/v1/admin/import/supplier-balances/preview")
      .set(authHeader(token))
      .attach("file", csv, { filename: "suppliers-2026-09-13.csv", contentType: "text/csv" });
    expect(preview.status).toBe(200);
    const previewBody = preview.body.data ?? preview.body;
    expect(previewBody.type).toBe(ABU_SHALBAK_SUPPLIER_LIST_TYPE);
    expect(previewBody.destination).toBe("supplier");
    expect(previewBody.overwriteIgnored).toBe(true);
    expect(previewBody.rows[0].systemBalance).toBe(-12.5);
    expect(previewBody.rows[0].action).toBe("create");

    const confirm = await request(ctx.app)
      .post("/api/v1/admin/import/supplier-balances/confirm?opening_balance_date=2026-09-13")
      .set(authHeader(token))
      .attach("file", csv, { filename: "suppliers-2026-09-13.csv", contentType: "text/csv" });
    expect(confirm.status).toBe(200);
    const confirmBody = confirm.body.data ?? confirm.body;
    expect(confirmBody.created).toBe(1);
    const row = await ctx.db.get("SELECT * FROM suppliers WHERE name = ?", ["مورد نقل HTTP"]);
    expect(row.balance).toBe(-12.5);
    expect(row.opening_balance_source).toBe(SUPPLIER_CSV_TRANSFER_SOURCE);
  });
});
