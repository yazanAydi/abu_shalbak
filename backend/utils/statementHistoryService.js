import { randomUUID } from "crypto";
import { round2 } from "./tax.js";
import { HESABATI_HISTORY_SOURCE, verifyStatementRunningBalances } from "./statementHistoryImport.js";

/**
 * @param {object} db
 * @param {"supplier"|"customer"} partyType
 * @param {number} partyId
 */
async function loadParty(db, partyType, partyId) {
  if (partyType === "supplier") {
    return db.get("SELECT id, supplier_code AS code, name FROM suppliers WHERE id = ?", [partyId]);
  }
  return db.get("SELECT id, customer_code AS code, name FROM customers WHERE id = ?", [partyId]);
}

/**
 * @param {object} db
 * @param {"supplier"|"customer"} partyType
 * @param {number} partyId
 */
export async function countExistingHistory(db, partyType, partyId) {
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM account_statement_entries
     WHERE party_type = ? AND party_id = ? AND source_type = ?`,
    [partyType, partyId, HESABATI_HISTORY_SOURCE]
  );
  return Number(row?.n) || 0;
}

/**
 * @param {object[]} rows
 */
function computeStats(rows) {
  const dates = rows.map((r) => r.entry_date).filter(Boolean).sort();
  const totalDebit = round2(rows.reduce((s, r) => s + (Number(r.debit) || 0), 0));
  const totalCredit = round2(rows.reduce((s, r) => s + (Number(r.credit) || 0), 0));
  const firstBalance = rows.length ? round2(rows[0].running_balance) : 0;
  const finalBalance = rows.length ? round2(rows[rows.length - 1].running_balance) : 0;
  return {
    totalRows: rows.length,
    firstDate: dates[0] || null,
    lastDate: dates[dates.length - 1] || null,
    totalDebit,
    totalCredit,
    firstBalance,
    finalBalance,
  };
}

/**
 * @param {object} db
 * @param {"supplier"|"customer"} partyType
 * @param {number} partyId
 * @param {object[]} rows
 * @param {{ overwriteExisting?: boolean, invalidRows?: number, duplicateRows?: number, sourceFileName?: string }} options
 */
export async function buildStatementHistoryImportPlan(db, partyType, partyId, rows, options = {}) {
  const party = await loadParty(db, partyType, partyId);
  if (!party) {
    const err = new Error(partyType === "supplier" ? "المورد غير موجود" : "العميل غير موجود");
    err.status = 404;
    throw err;
  }

  const existingHistoryCount = await countExistingHistory(db, partyType, partyId);
  const balanceWarnings = verifyStatementRunningBalances(rows);
  const stats = {
    ...computeStats(rows),
    invalidRows: Number(options.invalidRows) || 0,
    duplicateRows: Number(options.duplicateRows) || 0,
    existingHistoryCount,
  };

  const overwriteExisting = Boolean(options.overwriteExisting);
  let blocked = false;
  let blockReason = null;
  if (existingHistoryCount > 0 && !overwriteExisting) {
    blocked = true;
    blockReason = "يوجد سجل مستورد مسبقاً لهذا الطرف. فعّل «تجاوز السجل المستورد سابقاً» للاستبدال.";
  }
  if (!rows.length) {
    blocked = true;
    blockReason = blockReason || "لا توجد صفوف صالحة للاستيراد.";
  }

  return {
    party: { id: party.id, name: party.name, code: party.code },
    stats,
    balanceWarnings,
    rows: rows.slice(0, 20),
    blocked,
    blockReason,
    action: blocked ? "blocked" : existingHistoryCount > 0 && overwriteExisting ? "overwrite" : "insert",
  };
}

/**
 * @param {object} db
 * @param {"supplier"|"customer"} partyType
 * @param {number} partyId
 * @param {object[]} rows
 * @param {{ overwriteExisting?: boolean, sourceFileName?: string }} options
 */
export async function applyStatementHistoryImport(db, partyType, partyId, rows, options = {}) {
  const plan = await buildStatementHistoryImportPlan(db, partyType, partyId, rows, {
    ...options,
    invalidRows: 0,
    duplicateRows: 0,
  });
  if (plan.blocked) {
    const err = new Error(plan.blockReason || "الاستيراد محظور");
    err.status = 409;
    err.code = "IMPORT_BLOCKED";
    throw err;
  }

  const importBatchId = randomUUID();
  const sourceFileName = options.sourceFileName || null;
  const overwriteExisting = Boolean(options.overwriteExisting);

  await db.run("BEGIN IMMEDIATE");
  try {
    if (overwriteExisting) {
      await db.run(
        `DELETE FROM account_statement_entries
         WHERE party_type = ? AND party_id = ? AND source_type = ?`,
        [partyType, partyId, HESABATI_HISTORY_SOURCE]
      );
    }

    for (const row of rows) {
      await db.run(
        `INSERT INTO account_statement_entries (
          party_type, party_id, import_batch_id, legacy_reference_number,
          entry_date, description, debit, credit, running_balance, notes,
          source_type, source_file_name, row_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          partyType,
          partyId,
          importBatchId,
          row.legacy_reference_number,
          row.entry_date,
          row.description,
          row.debit,
          row.credit,
          row.running_balance,
          row.notes,
          HESABATI_HISTORY_SOURCE,
          sourceFileName,
          row.row_order,
        ]
      );
    }

    const finalBalance = rows.length ? round2(rows[rows.length - 1].running_balance) : 0;
    if (partyType === "supplier") {
      await db.run(
        `UPDATE suppliers SET balance = ?, opening_balance_excel = ? WHERE id = ?`,
        [-finalBalance, finalBalance, partyId]
      );
    } else {
      await db.run(`UPDATE customers SET balance = ? WHERE id = ?`, [finalBalance, partyId]);
    }

    await db.run("COMMIT");
  } catch (e) {
    await db.run("ROLLBACK");
    throw e;
  }

  return {
    importBatchId,
    importedRows: rows.length,
    party: plan.party,
    stats: plan.stats,
  };
}
