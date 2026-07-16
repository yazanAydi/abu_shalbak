import { readXlsxMatrix, findHeaderRowIndex } from "./xlsxHelpers.js";
import { detectImportType } from "./importDetect.js";
import { round2 } from "./tax.js";
import { hesabatiBalanceDisplay } from "./hesabatiStatementFormat.js";
import {
  normalizeArabicNameForMatch,
  parseBalanceSheetMatrix,
  supplierHasLedgerActivity,
  hesabatiToSystemSupplierBalance,
  openingBalanceToDebitCredit,
} from "./balanceSheetImport.js";
import { assignEntityCodeIfMissing, ensureEntityCode } from "./entityCodes.js";
import { shopTodayYmd } from "./shopTime.js";

export const HESABATI_OPENING_SOURCE = "hesabati_import";
export const OPENING_ENTRY_SOURCE_TYPE = "opening_balance_import";
export const OPENING_ENTRY_DESCRIPTION = "رصيد افتتاحي من نظام حساباتي";
export const OPENING_ENTRY_NOTES = "Imported from Hesabati supplier balances file";

/**
 * @param {Buffer} buffer
 * @param {string} filename
 */
export function parseSupplierBalanceFile(buffer, filename) {
  const { matrix } = readXlsxMatrix(buffer);
  if (!matrix.length) return [];

  const detected = detectImportType(matrix, filename);
  const headerIdx =
    detected.headerRowIndex >= 0
      ? detected.headerRowIndex
      : findHeaderRowIndex(matrix, (headers) => {
          const hasBalance = headers.some((h) => /^الرصيد$|^رصيد|^balance$/i.test(h));
          const hasName = headers.some((h) => /^الاسم$|^اسم|^name$/i.test(h));
          return hasBalance && hasName;
        });

  if (headerIdx < 0) {
    throw new Error("الملف لا يطابق تنسيق أرصدة الموردين من حساباتي.");
  }

  return parseBalanceSheetMatrix(matrix, headerIdx).map((r) => {
    const excelBalance = round2(Number(r.balance) || 0);
    const systemBalance = hesabatiToSystemSupplierBalance(excelBalance);
    return {
      ...r,
      excelBalance,
      balance: systemBalance,
      systemBalance,
      importType: "hesabati_supplier_balances",
    };
  });
}

/**
 * @param {ReturnType<parseSupplierBalanceFile>[number][]} rows
 */
export function dedupeSupplierBalanceRows(rows) {
  /** @type {Map<string, ReturnType<parseSupplierBalanceFile>[number]>} */
  const byCode = new Map();
  /** @type {ReturnType<parseSupplierBalanceFile>[number][]} */
  const withoutCode = [];
  /** @type {{ row: number, reason: string, code?: string }[]} */
  const dropped = [];

  for (const row of rows) {
    const code = row.code != null ? String(row.code).trim() : "";
    if (!code) {
      withoutCode.push(row);
      continue;
    }

    const prev = byCode.get(code);
    if (!prev) {
      byCode.set(code, row);
      continue;
    }

    const prevNamed = Boolean(String(prev.name ?? "").trim());
    const rowNamed = Boolean(String(row.name ?? "").trim());

    if (rowNamed && !prevNamed) {
      byCode.set(code, row);
      continue;
    }
    if (!rowNamed && prevNamed) {
      dropped.push({
        row: row.rowNum,
        code,
        reason: "صف مكرر بدون اسم — وُجد صف آخر بنفس الرقم يحمل الاسم",
      });
      continue;
    }

    byCode.set(code, row);
  }

  return {
    rows: [...byCode.values(), ...withoutCode].sort((a, b) => a.rowNum - b.rowNum),
    dropped,
  };
}

/**
 * @param {object} db
 * @param {ReturnType<parseSupplierBalanceFile>[number]} row
 * @param {string} name
 */
async function findExistingSupplier(db, row, name) {
  if (row.code) {
    const byCode = await db.get(`SELECT * FROM suppliers WHERE supplier_code = ?`, [row.code]);
    if (byCode) return byCode;
  }
  const normalized = normalizeArabicNameForMatch(name);
  if (!normalized) return null;
  const candidates = await db.all(`SELECT * FROM suppliers`);
  return candidates.find((s) => normalizeArabicNameForMatch(s.name) === normalized) || null;
}

/**
 * @param {object} db
 * @param {number} supplierId
 */
async function supplierHasHesabatiOpening(db, supplierId) {
  const supplier = await db.get(`SELECT opening_balance_source FROM suppliers WHERE id = ?`, [supplierId]);
  if (supplier?.opening_balance_source === HESABATI_OPENING_SOURCE) return true;
  const entry = await db.get(
    `SELECT id FROM party_opening_entries
     WHERE party_type = 'supplier' AND party_id = ? AND source_type = ?`,
    [supplierId, OPENING_ENTRY_SOURCE_TYPE]
  );
  return Boolean(entry);
}

/**
 * @param {ReturnType<parseSupplierBalanceFile>[number][]} rows
 */
function detectDuplicateNames(rows) {
  /** @type {Map<string, { name: string, codes: Set<string> }>} */
  const byNorm = new Map();
  for (const row of rows) {
    const name = String(row.name ?? "").trim();
    if (!name) continue;
    const norm = normalizeArabicNameForMatch(name);
    if (!norm) continue;
    const code = row.code != null ? String(row.code).trim() : "";
    if (!byNorm.has(norm)) {
      byNorm.set(norm, { name, codes: new Set() });
    }
    if (code) byNorm.get(norm).codes.add(code);
  }
  return [...byNorm.values()]
    .filter((v) => v.codes.size > 1)
    .map((v) => ({ name: v.name, codes: [...v.codes] }));
}

/**
 * @param {object} db
 * @param {ReturnType<parseSupplierBalanceFile>[number]} row
 * @param {string} name
 * @param {{ importZeroBalances?: boolean, overwriteExistingOpeningBalances?: boolean, force?: boolean }} options
 */
async function classifySupplierBalanceRow(db, row, name, options = {}) {
  const importZeroBalances = Boolean(options.importZeroBalances);
  const overwriteExistingOpeningBalances = Boolean(options.overwriteExistingOpeningBalances);
  const force = Boolean(options.force);

  const excelBalance = round2(Number(row.excelBalance ?? row.balance) || 0);
  const systemBalance = round2(Number(row.systemBalance ?? row.balance) || 0);
  const statementBalance = hesabatiBalanceDisplay("supplier", systemBalance).hesabatiBalance;
  const isZero = Math.abs(systemBalance) < 0.009;

  const existing = await findExistingSupplier(db, row, name);

  if (!existing) {
    if (!importZeroBalances && isZero) {
      return {
        action: "skip",
        reason: "رصيد صفر — لم يُستورد (فعّل خيار رصيد صفر)",
        excelBalance,
        systemBalance,
        statementBalance,
        supplierId: null,
      };
    }
    return {
      action: "create",
      reason: "مورد جديد",
      excelBalance,
      systemBalance,
      statementBalance,
      supplierId: null,
    };
  }

  const hasHesabatiOpening = await supplierHasHesabatiOpening(db, existing.id);
  const hasActivity = await supplierHasLedgerActivity(db, existing.id);

  if (hasHesabatiOpening && !overwriteExistingOpeningBalances) {
    return {
      action: "skip",
      reason: "لديه رصيد افتتاحي من حساباتي — فعّل التجاوز لإعادة الاستيراد",
      excelBalance,
      systemBalance,
      statementBalance,
      supplierId: existing.id,
    };
  }

  if (hasActivity && !force && !overwriteExistingOpeningBalances) {
    return {
      action: "skip",
      reason: "المورد له حركات محاسبية — فعّل التجاوز أو force=1",
      excelBalance,
      systemBalance,
      statementBalance,
      supplierId: existing.id,
    };
  }

  return {
    action: "update",
    reason: hasHesabatiOpening ? "تحديث رصيد افتتاحي" : "تحديث مورد موجود",
    excelBalance,
    systemBalance,
    statementBalance,
    supplierId: existing.id,
  };
}

/**
 * @param {object} db
 * @param {ReturnType<parseSupplierBalanceFile>[number][]} rows
 * @param {{ importZeroBalances?: boolean, overwriteExistingOpeningBalances?: boolean, force?: boolean, droppedDuplicates?: object[], sampleLimit?: number }} [options]
 */
export async function buildSupplierBalanceImportPlan(db, rows, options = {}) {
  const { rows: dedupedRows, dropped } = dedupeSupplierBalanceRows(rows);
  const duplicateNames = detectDuplicateNames(dedupedRows);
  const sampleLimit = options.sampleLimit ?? 20;

  /** @type {object[]} */
  const planRows = [];
  /** @type {{ row: number, reason: string, name?: string, code?: string }[]} */
  const errors = [...(options.droppedDuplicates || []), ...dropped];

  let matched = 0;
  let toCreate = 0;
  let invalid = 0;
  let alreadyImported = 0;
  let totalPositiveExcel = 0;
  let totalNegativeExcel = 0;

  for (const row of dedupedRows) {
    const name = String(row.name ?? "").trim();
    if (!name) {
      errors.push({ row: row.rowNum, reason: "الاسم مفقود" });
      invalid++;
      planRows.push({
        rowNum: row.rowNum,
        code: row.code,
        name: "",
        excelBalance: row.excelBalance ?? 0,
        systemBalance: row.systemBalance ?? row.balance,
        statementBalance: hesabatiBalanceDisplay("supplier", row.systemBalance ?? row.balance).hesabatiBalance,
        action: "invalid",
        reason: "الاسم مفقود",
        supplierId: null,
      });
      continue;
    }

    const excelBalance = round2(Number(row.excelBalance ?? 0) || 0);
    if (excelBalance > 0) totalPositiveExcel = round2(totalPositiveExcel + excelBalance);
    if (excelBalance < 0) totalNegativeExcel = round2(totalNegativeExcel + excelBalance);

    const classified = await classifySupplierBalanceRow(db, row, name, options);

    if (classified.action === "create") toCreate++;
    if (classified.action === "update") matched++;
    if (classified.action === "skip" && classified.reason.includes("رصيد افتتاحي")) alreadyImported++;
    if (classified.action === "invalid") invalid++;

    planRows.push({
      rowNum: row.rowNum,
      code: row.code,
      name,
      excelBalance: classified.excelBalance,
      systemBalance: classified.systemBalance,
      statementBalance: classified.statementBalance,
      action: classified.action,
      reason: classified.reason,
      supplierId: classified.supplierId,
    });
  }

  const skipped = planRows.filter((r) => r.action === "skip").length;
  const netTotalExcel = round2(totalPositiveExcel + totalNegativeExcel);

  return {
    type: "hesabati_supplier_balances",
    stats: {
      totalRows: dedupedRows.length,
      matched,
      toCreate,
      invalid,
      duplicateNames: duplicateNames.length,
      alreadyImported,
      skipped,
      totalPositiveExcel,
      totalNegativeExcel,
      netTotalExcel,
    },
    rows: planRows.slice(0, sampleLimit),
    allRows: planRows,
    duplicateNames,
    errors,
  };
}

/**
 * @param {object} db
 * @param {number} supplierId
 * @param {number} systemBalance
 * @param {string} entryDate
 * @param {string} [sourceId]
 */
async function upsertSupplierOpeningEntry(db, supplierId, systemBalance, entryDate, sourceId = null) {
  const { debit, credit } = openingBalanceToDebitCredit(systemBalance);
  const existing = await db.get(
    `SELECT id FROM party_opening_entries
     WHERE party_type = 'supplier' AND party_id = ? AND source_type = ?`,
    [supplierId, OPENING_ENTRY_SOURCE_TYPE]
  );

  if (existing) {
    await db.run(
      `UPDATE party_opening_entries
       SET entry_date = ?, description = ?, debit = ?, credit = ?, source_id = ?, notes = ?
       WHERE id = ?`,
      [entryDate, OPENING_ENTRY_DESCRIPTION, debit, credit, sourceId, OPENING_ENTRY_NOTES, existing.id]
    );
    return existing.id;
  }

  const ins = await db.run(
    `INSERT INTO party_opening_entries
      (party_type, party_id, entry_date, description, debit, credit, source_type, source_id, notes)
     VALUES ('supplier', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [supplierId, entryDate, OPENING_ENTRY_DESCRIPTION, debit, credit, OPENING_ENTRY_SOURCE_TYPE, sourceId, OPENING_ENTRY_NOTES]
  );
  return ins.lastID;
}

/**
 * @param {object} db
 * @param {ReturnType<parseSupplierBalanceFile>[number][]} rows
 * @param {{ importZeroBalances?: boolean, force?: boolean, overwriteExistingOpeningBalances?: boolean, openingBalanceDate?: string, sourceId?: string, droppedDuplicates?: object[] }} [options]
 */
export async function applySupplierBalanceImport(db, rows, options = {}) {
  const importZeroBalances = Boolean(options.importZeroBalances);
  const force = Boolean(options.force);
  const overwriteExistingOpeningBalances = Boolean(options.overwriteExistingOpeningBalances);
  const openingBalanceDate = options.openingBalanceDate || shopTodayYmd();
  const sourceId = options.sourceId || null;

  const plan = await buildSupplierBalanceImportPlan(db, rows, {
    importZeroBalances,
    force,
    overwriteExistingOpeningBalances,
    droppedDuplicates: options.droppedDuplicates,
    sampleLimit: Number.MAX_SAFE_INTEGER,
  });

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [...plan.errors];

  await db.run("BEGIN IMMEDIATE");
  try {
    for (const planRow of plan.allRows) {
      if (planRow.action === "invalid" || planRow.action === "skip") {
        skipped++;
        continue;
      }

      const row = rows.find((r) => r.rowNum === planRow.rowNum);
      if (!row) {
        skipped++;
        continue;
      }

      const name = String(row.name ?? "").trim();
      const systemBalance = round2(Number(row.systemBalance ?? row.balance) || 0);
      const excelBalance = round2(Number(row.excelBalance ?? -systemBalance) || 0);

      if (planRow.action === "create") {
        const supplierCode = await ensureEntityCode(db, "supplier", row.code);
        const ins = await db.run(
          `INSERT INTO suppliers
            (name, contact_phone, supplier_code, opening_balance, opening_balance_excel, balance,
             opening_balance_date, opening_balance_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [name, row.phone || null, supplierCode, systemBalance, excelBalance, systemBalance, openingBalanceDate, HESABATI_OPENING_SOURCE]
        );
        await upsertSupplierOpeningEntry(db, ins.lastID, systemBalance, openingBalanceDate, sourceId);
        created++;
        continue;
      }

      if (planRow.action === "update") {
        const existing = await db.get(`SELECT * FROM suppliers WHERE id = ?`, [planRow.supplierId]);
        if (!existing) {
          errors.push({ row: row.rowNum, name, reason: "المورد غير موجود" });
          skipped++;
          continue;
        }

        const oldOpening = round2(Number(existing.opening_balance) || 0);
        const oldBalance = round2(Number(existing.balance) || 0);
        const hasActivity = await supplierHasLedgerActivity(db, existing.id);
        const newBalance = hasActivity
          ? round2(oldBalance - oldOpening + systemBalance)
          : systemBalance;

        await db.run(
          `UPDATE suppliers SET name = ?, contact_phone = COALESCE(?, contact_phone),
              opening_balance = ?, opening_balance_excel = ?, balance = ?,
              opening_balance_date = ?, opening_balance_source = ?
           WHERE id = ?`,
          [name, row.phone, systemBalance, excelBalance, newBalance, openingBalanceDate, HESABATI_OPENING_SOURCE, existing.id]
        );
        await assignEntityCodeIfMissing(db, "supplier", existing.id);
        await upsertSupplierOpeningEntry(db, existing.id, systemBalance, openingBalanceDate, sourceId);
        updated++;
      }
    }
    await db.run("COMMIT");
  } catch (e) {
    try {
      await db.run("ROLLBACK");
    } catch (_) {}
    throw e;
  }

  return {
    type: "hesabati_supplier_balances",
    created,
    updated,
    skipped,
    errors,
    stats: plan.stats,
    message: `تم استيراد أرصدة الموردين: ${created} جديد، ${updated} محدّث، ${skipped} تُرك`,
  };
}

/**
 * @param {object} db
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {{ importZeroBalances?: boolean, force?: boolean, overwriteExistingOpeningBalances?: boolean, openingBalanceDate?: string }} [options]
 */
export async function importSupplierBalancesFromBuffer(db, buffer, filename, options = {}) {
  const rows = parseSupplierBalanceFile(buffer, filename);
  if (!rows.length) {
    throw new Error("لا توجد صفوف بيانات");
  }
  return applySupplierBalanceImport(db, rows, {
    ...options,
    sourceId: filename || null,
  });
}

/**
 * @param {object} db
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {{ importZeroBalances?: boolean, overwriteExistingOpeningBalances?: boolean, force?: boolean }} [options]
 */
export async function previewSupplierBalancesFromBuffer(db, buffer, filename, options = {}) {
  const rows = parseSupplierBalanceFile(buffer, filename);
  if (!rows.length) {
    throw new Error("لا توجد صفوف بيانات");
  }
  return buildSupplierBalanceImportPlan(db, rows, options);
}
