import { readXlsxMatrix, findHeaderRowIndex } from "./xlsxHelpers.js";
import {
  detectImportType,
  filenameSuggestsCustomerBalances,
  isAbuShalbakSupplierListExport,
} from "./importDetect.js";
import {
  ABU_SHALBAK_SUPPLIER_LIST_TYPE,
  parseAbuShalbakSupplierListMatrix,
  buildSupplierListTransferPlan,
  applySupplierListTransfer,
} from "./supplierListTransfer.js";
import { round2 } from "./tax.js";
import { hesabatiBalanceDisplay } from "./hesabatiStatementFormat.js";
import {
  normalizeArabicNameForMatch,
  parseBalanceSheetMatrix,
  parseBalanceAmountStrict,
  isBalanceSummaryRow,
  supplierHasLedgerActivity,
  hesabatiToSystemSupplierBalance,
  openingBalanceToDebitCredit,
} from "./balanceSheetImport.js";
import { assignEntityCodeIfMissing, ensureEntityCode } from "./entityCodes.js";
import { shopTodayYmd } from "./shopTime.js";
import { withTransaction } from "./dbTx.js";

export const HESABATI_OPENING_SOURCE = "hesabati_import";
export const OPENING_ENTRY_SOURCE_TYPE = "opening_balance_import";
export const OPENING_ENTRY_DESCRIPTION = "رصيد افتتاحي من نظام حساباتي";
export const OPENING_ENTRY_NOTES = "Imported from Hesabati supplier balances file";
export const SUPPLIER_IMPORT_DESTINATION = "supplier";
export const SUPPLIER_IMPORT_DESTINATION_LABEL = "إدارة الموردين — بطاقة مورد (ليس زبوناً)";

/**
 * @param {Buffer} buffer
 * @param {string} filename
 */
export function parseSupplierBalanceFile(buffer, filename) {
  const { matrix } = readXlsxMatrix(buffer);
  if (isAbuShalbakSupplierListExport(matrix, filename)) {
    return parseAbuShalbakSupplierListMatrix(matrix, filename);
  }
  if (!matrix.length) return [];

  const detected = detectImportType(matrix, filename);
  const headerIdx =
    detected.headerRowIndex >= 0
      ? detected.headerRowIndex
      : findHeaderRowIndex(matrix, (headers) => {
          const hasBalance = headers.some((h) => /^الرصيد|^رصيد|^balance$/i.test(h));
          const hasName = headers.some((h) => /^الاسم$|^اسم|^name$/i.test(h));
          return hasBalance && hasName;
        });

  if (headerIdx < 0) {
    throw new Error(
      "الملف لا يطابق تنسيق أرصدة الموردين. المتوقع أعمدة حساباتي: الرقم، الاسم، الرصيد. لا تستخدم تصدير CSV من إدارة الموردين."
    );
  }

  return parseBalanceSheetMatrix(matrix, headerIdx).map((r) => {
    const parsed = parseBalanceAmountStrict(r.rawBalance);
    const excelBalance = parsed.ok ? parsed.value : null;
    const systemBalance = parsed.ok ? hesabatiToSystemSupplierBalance(excelBalance) : null;
    return {
      ...r,
      excelBalance,
      balance: systemBalance,
      systemBalance,
      balanceStatus: parsed.ok ? "ok" : parsed.reason,
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
    return byCode || null;
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
 * @param {ReturnType<parseSupplierBalanceFile>[number]} row
 */
function resolveSupplierRowBalances(row) {
  if (row.balanceStatus === "missing" || row.balanceStatus === "invalid") {
    return {
      status: row.balanceStatus,
      excelBalance: null,
      systemBalance: null,
      statementBalance: null,
    };
  }
  const hasExcel = row.excelBalance != null && row.excelBalance !== "";
  const hasSystem = row.systemBalance != null && row.systemBalance !== "";
  const hasBalance = row.balance != null && row.balance !== "";
  if (!hasExcel && !hasSystem && !hasBalance && row.balanceStatus !== "ok") {
    return {
      status: "missing",
      excelBalance: null,
      systemBalance: null,
      statementBalance: null,
    };
  }
  const systemBalance = round2(Number(hasSystem ? row.systemBalance : row.balance) || 0);
  const excelBalance = hasExcel
    ? round2(Number(row.excelBalance) || 0)
    : round2(-systemBalance);
  return {
    status: "ok",
    excelBalance,
    systemBalance,
    statementBalance: hesabatiBalanceDisplay("supplier", systemBalance).hesabatiBalance,
  };
}

function isNonzeroOpening(systemBalance) {
  return Math.abs(Number(systemBalance) || 0) >= 0.009;
}

/**
 * @param {object} db
 * @param {ReturnType<parseSupplierBalanceFile>[number]} row
 * @param {string} name
 * @param {{ overwriteExistingOpeningBalances?: boolean, force?: boolean }} options
 */
async function classifySupplierBalanceRow(db, row, name, options = {}) {
  const overwriteExistingOpeningBalances = Boolean(options.overwriteExistingOpeningBalances);
  const force = Boolean(options.force);

  if (isBalanceSummaryRow(name)) {
    const balances = resolveSupplierRowBalances(row);
    return {
      action: "invalid",
      reason: "صف إجمالي — ليس مورداً",
      excelBalance: balances.excelBalance,
      systemBalance: balances.systemBalance,
      statementBalance: balances.statementBalance,
      supplierId: null,
    };
  }

  const balances = resolveSupplierRowBalances(row);
  if (balances.status !== "ok") {
    return {
      action: "invalid",
      reason: balances.status === "invalid" ? "الرصيد غير صالح" : "الرصيد مفقود",
      excelBalance: null,
      systemBalance: null,
      statementBalance: null,
      supplierId: null,
    };
  }

  const { excelBalance, systemBalance, statementBalance } = balances;
  const existing = await findExistingSupplier(db, row, name);

  if (!existing) {
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
      action: "existing",
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
  const errors = [
    ...(options.droppedDuplicates || []),
    ...dropped.map((d) => ({ row: d.row, reason: d.reason, code: d.code })),
  ];

  let matched = 0;
  let toCreate = 0;
  let invalid = dropped.length + (options.droppedDuplicates || []).length;
  let existing = 0;
  let skipped = 0;
  let totalPositiveExcel = 0;
  let totalNegativeExcel = 0;

  for (const row of dedupedRows) {
    const name = String(row.name ?? "").trim();
    if (!name) {
      const err = { row: row.rowNum, reason: "الاسم مفقود", name: "", code: row.code || undefined };
      errors.push(err);
      invalid++;
      planRows.push({
        rowNum: row.rowNum,
        code: row.code,
        name: "",
        excelBalance: row.excelBalance ?? null,
        systemBalance: row.systemBalance ?? null,
        statementBalance: null,
        action: "invalid",
        reason: "الاسم مفقود",
        supplierId: null,
      });
      continue;
    }

    const classified = await classifySupplierBalanceRow(db, row, name, options);
    const excelBalance = classified.excelBalance;
    if (typeof excelBalance === "number") {
      if (excelBalance > 0) totalPositiveExcel = round2(totalPositiveExcel + excelBalance);
      if (excelBalance < 0) totalNegativeExcel = round2(totalNegativeExcel + excelBalance);
    }

    if (classified.action === "create") toCreate++;
    if (classified.action === "update") matched++;
    if (classified.action === "existing") existing++;
    if (classified.action === "skip") skipped++;
    if (classified.action === "invalid") {
      invalid++;
      errors.push({
        row: row.rowNum,
        reason: classified.reason,
        name,
        code: row.code || undefined,
      });
    }

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

  const netTotalExcel = round2(totalPositiveExcel + totalNegativeExcel);

  return {
    type: "hesabati_supplier_balances",
    destination: SUPPLIER_IMPORT_DESTINATION,
    destinationLabel: SUPPLIER_IMPORT_DESTINATION_LABEL,
    destinationWarning: filenameSuggestsCustomerBalances(options.filename || "")
      ? "اسم الملف يشير إلى أرصدة زبائن/عملاء. هذا المسار ينشئ بطاقات في إدارة الموردين فقط — لن يُنشئ زبائن."
      : null,
    stats: {
      totalRows: dedupedRows.length,
      matched,
      toCreate,
      invalid,
      rejected: invalid,
      existing,
      duplicateNames: duplicateNames.length,
      alreadyImported: existing,
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
 * @param {number} supplierId
 */
async function deleteSupplierOpeningEntry(db, supplierId) {
  await db.run(
    `DELETE FROM party_opening_entries
     WHERE party_type = 'supplier' AND party_id = ? AND source_type = ?`,
    [supplierId, OPENING_ENTRY_SOURCE_TYPE]
  );
}

/**
 * @param {object} db
 * @param {ReturnType<parseSupplierBalanceFile>[number][]} rows
 * @param {{ importZeroBalances?: boolean, force?: boolean, overwriteExistingOpeningBalances?: boolean, openingBalanceDate?: string, sourceId?: string, droppedDuplicates?: object[] }} [options]
 */
export async function applySupplierBalanceImport(db, rows, options = {}) {
  const force = Boolean(options.force);
  const overwriteExistingOpeningBalances = Boolean(options.overwriteExistingOpeningBalances);
  const openingBalanceDate = options.openingBalanceDate || shopTodayYmd();
  const sourceId = options.sourceId || null;

  const plan = await buildSupplierBalanceImportPlan(db, rows, {
    force,
    overwriteExistingOpeningBalances,
    droppedDuplicates: options.droppedDuplicates,
    sampleLimit: Number.MAX_SAFE_INTEGER,
  });

  let created = 0;
  let updated = 0;
  let existing = 0;
  let rejected = 0;
  let skipped = 0;
  const errors = [...plan.errors];

  await withTransaction(db, async () => {
    for (const planRow of plan.allRows) {
      if (planRow.action === "invalid") {
        rejected++;
        continue;
      }
      if (planRow.action === "existing") {
        existing++;
        continue;
      }
      if (planRow.action === "skip") {
        skipped++;
        continue;
      }

      const row = rows.find((r) => r.rowNum === planRow.rowNum);
      if (!row) {
        skipped++;
        continue;
      }

      const name = String(row.name ?? "").trim();
      const balances = resolveSupplierRowBalances(row);
      if (balances.status !== "ok") {
        errors.push({
          row: row.rowNum,
          name,
          code: row.code || undefined,
          reason: balances.status === "invalid" ? "الرصيد غير صالح" : "الرصيد مفقود",
        });
        rejected++;
        continue;
      }
      const systemBalance = balances.systemBalance;
      const excelBalance = balances.excelBalance;
      const openingDate = isNonzeroOpening(systemBalance) ? openingBalanceDate : null;

      if (planRow.action === "create") {
        const supplierCode = await ensureEntityCode(db, "supplier", row.code);
        const ins = await db.run(
          `INSERT INTO suppliers
            (name, contact_phone, supplier_code, opening_balance, opening_balance_excel, balance,
             opening_balance_date, opening_balance_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [name, row.phone || null, supplierCode, systemBalance, excelBalance, systemBalance, openingDate, HESABATI_OPENING_SOURCE]
        );
        if (isNonzeroOpening(systemBalance)) {
          await upsertSupplierOpeningEntry(db, ins.lastID, systemBalance, openingBalanceDate, sourceId);
        }
        created++;
        continue;
      }

      if (planRow.action === "update") {
        const current = await db.get(`SELECT * FROM suppliers WHERE id = ?`, [planRow.supplierId]);
        if (!current) {
          errors.push({ row: row.rowNum, name, code: row.code || undefined, reason: "المورد غير موجود" });
          rejected++;
          continue;
        }

        const oldOpening = round2(Number(current.opening_balance) || 0);
        const oldBalance = round2(Number(current.balance) || 0);
        const hasActivity = await supplierHasLedgerActivity(db, current.id);
        const newBalance = hasActivity
          ? round2(oldBalance - oldOpening + systemBalance)
          : systemBalance;

        await db.run(
          `UPDATE suppliers SET name = ?, contact_phone = COALESCE(?, contact_phone),
              opening_balance = ?, opening_balance_excel = ?, balance = ?,
              opening_balance_date = ?, opening_balance_source = ?
           WHERE id = ?`,
          [name, row.phone, systemBalance, excelBalance, newBalance, openingDate, HESABATI_OPENING_SOURCE, current.id]
        );
        await assignEntityCodeIfMissing(db, "supplier", current.id);
        if (isNonzeroOpening(systemBalance)) {
          await upsertSupplierOpeningEntry(db, current.id, systemBalance, openingBalanceDate, sourceId);
        } else {
          await deleteSupplierOpeningEntry(db, current.id);
        }
        updated++;
      }
    }
  });

  rejected += droppedDuplicateCount(plan.errors, plan.allRows);

  return {
    type: "hesabati_supplier_balances",
    destination: plan.destination,
    destinationLabel: plan.destinationLabel,
    destinationWarning: plan.destinationWarning,
    created,
    updated,
    existing,
    rejected,
    skipped,
    errors,
    stats: plan.stats,
    message: `تم استيراد أرصدة الموردين إلى إدارة الموردين: ${created} جديد، ${existing} موجود، ${updated} محدّث، ${rejected} مرفوض، ${skipped} تُرك`,
  };
}

/**
 * Dedupe drops are in plan.errors but not in allRows — count them as rejected.
 * @param {object[]} errors
 * @param {object[]} allRows
 */
function droppedDuplicateCount(errors, allRows) {
  const planRowNums = new Set(allRows.map((r) => r.rowNum));
  return errors.filter((e) => e.row != null && !planRowNums.has(e.row)).length;
}

function isTransferImportRows(rows) {
  return rows.some((r) => r.importType === ABU_SHALBAK_SUPPLIER_LIST_TYPE);
}

/**
 * @param {object} db
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {{ importZeroBalances?: boolean, force?: boolean, overwriteExistingOpeningBalances?: boolean, openingBalanceDate?: string, includeTestRows?: boolean }} [options]
 */
export async function importSupplierBalancesFromBuffer(db, buffer, filename, options = {}) {
  const rows = parseSupplierBalanceFile(buffer, filename);
  if (!rows.length) {
    throw new Error("لا توجد صفوف بيانات");
  }
  if (isTransferImportRows(rows)) {
    return applySupplierListTransfer(db, rows, {
      includeTestRows: options.includeTestRows,
      openingBalanceDate: options.openingBalanceDate,
      sourceId: filename || null,
    });
  }
  return applySupplierBalanceImport(db, rows, {
    ...options,
    filename,
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
  if (isTransferImportRows(rows)) {
    return buildSupplierListTransferPlan(db, rows, {
      includeTestRows: options.includeTestRows,
      filename,
    });
  }
  return buildSupplierBalanceImportPlan(db, rows, { ...options, filename });
}
