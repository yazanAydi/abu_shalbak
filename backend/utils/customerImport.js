import { round2 } from "./tax.js";
import { readXlsxMatrix, findHeaderRowIndex } from "./xlsxHelpers.js";
import { detectImportType } from "./importDetect.js";
import {
  customerHasLedgerActivity,
  normalizeAccountName,
  parseBalanceSheetMatrix,
} from "./balanceSheetImport.js";
import {
  getBalanceGroupIdForImportType,
  getDefaultBalanceGroupId,
  getBalanceGroupById,
} from "./balanceGroups.js";
import { assignEntityCodeIfMissing, ensureEntityCode } from "./entityCodes.js";

const CUSTOMER_CATEGORIES = ["retail", "wholesale", "vip", "credit", "corporate"];

/**
 * @typedef {'hesabati_customer_balances' | 'hesabati_operator_balances' | 'hesabati_building_balances'} CustomerImportKind
 */

/**
 * @param {CustomerImportKind} importType
 */
function defaultsForImportType(importType) {
  switch (importType) {
    case "hesabati_building_balances":
      return { price_category: "corporate", notesTag: "عمارة" };
    case "hesabati_operator_balances":
      return { price_category: "retail", notesTag: "مشغل" };
    default:
      return { price_category: "credit", notesTag: null };
  }
}

/**
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {CustomerImportKind} [forcedType]
 */
export function parseCustomerBalanceFile(buffer, filename, forcedType) {
  const { matrix } = readXlsxMatrix(buffer);
  if (!matrix.length) return [];

  const detected = detectImportType(matrix, filename);
  let importType = forcedType || detected.type;
  if (
    importType !== "hesabati_customer_balances" &&
    importType !== "hesabati_operator_balances" &&
    importType !== "hesabati_building_balances"
  ) {
    importType = "hesabati_customer_balances";
  }

  const headerIdx =
    detected.headerRowIndex >= 0
      ? detected.headerRowIndex
      : findHeaderRowIndex(matrix, (headers) => {
          const hasBalance = headers.some((h) => /^الرصيد$|^رصيد|^balance$/i.test(h));
          const hasName = headers.some((h) => /^الاسم$|^اسم|^name$/i.test(h));
          return hasBalance && hasName;
        });

  if (headerIdx < 0) {
    throw new Error("الملف لا يطابق تنسيق أرصدة الزبائن من حساباتي.");
  }

  const rows = parseBalanceSheetMatrix(matrix, headerIdx);
  const meta = defaultsForImportType(importType);
  return rows.map((r) => ({ ...r, ...meta, importType }));
}

/**
 * @param {object} db
 * @param {ReturnType<parseCustomerBalanceFile>[number][]} rows
 * @param {{ importZeroBalances?: boolean, force?: boolean, balanceGroupId?: number | null }} [options]
 */
export async function applyCustomerBalanceImport(db, rows, options = {}) {
  const importZeroBalances = Boolean(options.importZeroBalances);
  const force = Boolean(options.force);

  let balanceGroupId = options.balanceGroupId ?? null;
  if (balanceGroupId != null) {
    const g = await getBalanceGroupById(db, balanceGroupId);
    if (!g) balanceGroupId = null;
  }
  if (!balanceGroupId && rows[0]?.importType) {
    balanceGroupId = await getBalanceGroupIdForImportType(db, rows[0].importType);
  }
  if (!balanceGroupId) {
    balanceGroupId = await getDefaultBalanceGroupId(db);
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  /** @type {{ row: number, reason: string, name?: string }[]} */
  const errors = [];

  await db.run("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      if (!row.name) {
        errors.push({ row: row.rowNum, reason: "الاسم مفقود" });
        skipped++;
        continue;
      }
      if (!importZeroBalances && Math.abs(row.balance) < 0.009) {
        skipped++;
        continue;
      }

      let existing = null;
      if (row.code) {
        existing = await db.get(`SELECT * FROM customers WHERE customer_code = ?`, [row.code]);
      }
      if (!existing) {
        existing = await db.get(`SELECT * FROM customers WHERE LOWER(TRIM(name)) = ?`, [
          normalizeAccountName(row.name),
        ]);
      }

      const notes =
        row.notesTag && !existing?.notes?.includes(row.notesTag)
          ? [existing?.notes, row.notesTag].filter(Boolean).join(" — ")
          : existing?.notes || (row.notesTag ? row.notesTag : null);

      const priceCategory =
        row.balance !== 0 && row.price_category === "credit"
          ? "credit"
          : row.price_category;

      if (!existing) {
        const customerCode = await ensureEntityCode(db, "customer", null);
        await db.run(
          `INSERT INTO customers
            (name, phone, price_category, notes, customer_code, opening_balance, balance, balance_group_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.name,
            row.phone || null,
            CUSTOMER_CATEGORIES.includes(priceCategory) ? priceCategory : "retail",
            notes,
            customerCode,
            row.balance,
            row.balance,
            balanceGroupId,
          ]
        );
        created++;
        continue;
      }

      const hasActivity = await customerHasLedgerActivity(db, existing.id);
      if (hasActivity && !force) {
        errors.push({
          row: row.rowNum,
          name: row.name,
          reason: "العميل له حركات محاسبية — استخدم force=1 للتجاوز",
        });
        skipped++;
        continue;
      }

      await db.run(
        `UPDATE customers SET name = ?, phone = COALESCE(?, phone), price_category = ?,
            notes = ?, opening_balance = ?, balance = ?, balance_group_id = ?
         WHERE id = ?`,
        [
          row.name,
          row.phone,
          CUSTOMER_CATEGORIES.includes(priceCategory) ? priceCategory : existing.price_category,
          notes,
          row.balance,
          row.balance,
          balanceGroupId,
          existing.id,
        ]
      );
      await assignEntityCodeIfMissing(db, "customer", existing.id);
      updated++;
    }
    await db.run("COMMIT");
  } catch (e) {
    try {
      await db.run("ROLLBACK");
    } catch (_) {}
    throw e;
  }

  return {
    type: rows[0]?.importType || "hesabati_customer_balances",
    created,
    updated,
    skipped,
    errors,
    message: `تم استيراد أرصدة الزبائن: ${created} جديد، ${updated} محدّث، ${skipped} تُرك`,
  };
}

/**
 * @param {object} db
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {{ importZeroBalances?: boolean, force?: boolean, importType?: CustomerImportKind, balanceGroupId?: number | null }} [options]
 */
export async function importCustomerBalancesFromBuffer(db, buffer, filename, options = {}) {
  const rows = parseCustomerBalanceFile(buffer, filename, options.importType);
  if (!rows.length) {
    throw new Error("لا توجد صفوف بيانات");
  }
  return applyCustomerBalanceImport(db, rows, options);
}
