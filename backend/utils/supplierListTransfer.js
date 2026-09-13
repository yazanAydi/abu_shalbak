import {
  findHeaderRowIndex,
  mapColumns,
  matrixToFieldRecords,
  normalizeHeaderCell,
} from "./xlsxHelpers.js";
import {
  UNSIGNED_ABU_SHALBAK_SUPPLIER_EXPORT_ERROR,
} from "./importDetect.js";
import { round2 } from "./tax.js";
import {
  normalizeArabicNameForMatch,
  parseBalanceAmountStrict,
  isBalanceSummaryRow,
  openingBalanceToDebitCredit,
} from "./balanceSheetImport.js";
import { ensureEntityCode } from "./entityCodes.js";
import { shopTodayYmd } from "./shopTime.js";
import { withTransaction } from "./dbTx.js";

const TRANSFER_DESTINATION = "supplier";
const TRANSFER_DESTINATION_LABEL = "إدارة الموردين — بطاقة مورد (ليس زبوناً)";

export const ABU_SHALBAK_SUPPLIER_LIST_TYPE = "abu_shalbak_supplier_list";
export const SUPPLIER_CSV_TRANSFER_SOURCE = "supplier_csv_transfer";
export const TRANSFER_OPENING_ENTRY_SOURCE_TYPE = "supplier_csv_transfer";
export const TRANSFER_OPENING_DESCRIPTION = "رصيد افتتاحي من نقل قائمة الموردين";
export const TRANSFER_OPENING_NOTES = "Imported from Abu Shalbak supplier list CSV transfer";

const LIST_FIELD_PATTERNS = {
  code: [/^الرقم$|^رقم$|^supplier_code$/i],
  name: [/^الاسم$|^name$/i],
  phone: [/^الهاتف$|^هاتف$|^phone$/i],
  paymentTerms: [/^شروط\s*الدفع$/],
  balance: [/^الرصيد\s*\(\s*مستحق\s*\)$/, /^الرصيد$/, /^balance$/i],
};

/**
 * Mirror of frontend reportExport formula-injection quoting.
 * @param {unknown} value
 */
export function formatSupplierListCsvCell(value) {
  if (value == null) return '""';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  text = text.replace(/"/g, '""');
  return `"${text}"`;
}

/**
 * Signed system CSV in the same shape as إدارة الموردين → تصدير CSV.
 * @param {Array<{ supplier_code?: unknown, name?: unknown, contact_phone?: unknown, payment_terms?: unknown, balance?: unknown }>} suppliers
 */
export function buildAbuShalbakSupplierListCsv(suppliers) {
  const headers = ["الرقم", "الاسم", "الهاتف", "شروط الدفع", "الرصيد (مستحق)"];
  const lines = [headers.map(formatSupplierListCsvCell).join(",")];
  for (const s of suppliers || []) {
    const n = Number(s.balance);
    const signed = Number.isFinite(n) ? n.toFixed(2) : "0.00";
    lines.push(
      [
        formatSupplierListCsvCell(s.supplier_code != null ? String(s.supplier_code).trim() : ""),
        formatSupplierListCsvCell(s.name ?? ""),
        formatSupplierListCsvCell(s.contact_phone ?? ""),
        formatSupplierListCsvCell(s.payment_terms ?? ""),
        formatSupplierListCsvCell(signed),
      ].join(",")
    );
  }
  return `\uFEFF${lines.join("\n")}`;
}

/**
 * Old list export used ils(|balance|) so every cell contains ₪ and no credit sign.
 * @param {unknown} raw
 */
export function looksLikeUnsignedSupplierListBalance(raw) {
  if (raw == null) return false;
  return String(raw).includes("₪");
}

/**
 * @param {unknown} val
 * @returns {string | null}
 */
function emptyIfPlaceholder(val) {
  if (val == null) return null;
  const s = String(val).trim();
  if (!s || s === "—" || s === "–" || s === "-") return null;
  return s;
}

function isNonzeroOpening(systemBalance) {
  return Math.abs(Number(systemBalance) || 0) >= 0.009;
}

/**
 * Name "oo" or code "test" — likely a leftover card, excluded unless opted in.
 * @param {{ name?: unknown, code?: unknown }} row
 */
export function isSupplierTransferTestRow(row) {
  const name = normalizeArabicNameForMatch(row?.name);
  const code = String(row?.code ?? "").trim().toLowerCase();
  return name === "oo" || code === "test";
}

/**
 * Parse a system supplier-list CSV/xlsx. Does not apply the Hesabati sign flip.
 * @param {unknown[][]} matrix
 * @param {string} [filename]
 */
export function parseAbuShalbakSupplierListMatrix(matrix, filename = "") {
  if (!Array.isArray(matrix) || !matrix.length) return [];

  const headerIdx = findHeaderRowIndex(matrix, (headers) => {
    const hasName = headers.some((h) => LIST_FIELD_PATTERNS.name.some((re) => re.test(h)));
    const hasBalance = headers.some((h) => LIST_FIELD_PATTERNS.balance.some((re) => re.test(h)));
    return hasName && hasBalance;
  });

  if (headerIdx < 0) {
    throw new Error(
      "الملف لا يطابق تصدير قائمة الموردين. المتوقع: الرقم، الاسم، الهاتف، شروط الدفع، الرصيد (مستحق)."
    );
  }

  const headers = (matrix[headerIdx] || []).map(normalizeHeaderCell);
  const colMap = mapColumns(headers, LIST_FIELD_PATTERNS);
  if (colMap.name === undefined || colMap.balance === undefined) {
    throw new Error(
      "الملف لا يطابق تصدير قائمة الموردين. المتوقع: الرقم، الاسم، الهاتف، شروط الدفع، الرصيد (مستحق)."
    );
  }

  const raw = matrixToFieldRecords(matrix, headerIdx, colMap);
  if (raw.some((row) => looksLikeUnsignedSupplierListBalance(row.balance))) {
    throw new Error(UNSIGNED_ABU_SHALBAK_SUPPLIER_EXPORT_ERROR);
  }

  return raw.map((row) => {
    const parsed = parseBalanceAmountStrict(row.balance);
    const systemBalance = parsed.ok ? parsed.value : null;
    return {
      rowNum: Number(row._rowNum) || 0,
      code: emptyIfPlaceholder(row.code),
      name: String(row.name ?? "").trim(),
      phone: emptyIfPlaceholder(row.phone),
      paymentTerms: emptyIfPlaceholder(row.paymentTerms),
      rawBalance: row.balance,
      excelBalance: systemBalance,
      balance: systemBalance,
      systemBalance,
      balanceStatus: parsed.ok ? "ok" : parsed.reason,
      importType: ABU_SHALBAK_SUPPLIER_LIST_TYPE,
      filename,
    };
  });
}

/**
 * @param {object} db
 * @param {string} name
 */
async function findSupplierByNormalizedName(db, name) {
  const normalized = normalizeArabicNameForMatch(name);
  if (!normalized) return null;
  const candidates = await db.all(`SELECT * FROM suppliers`);
  return candidates.find((s) => normalizeArabicNameForMatch(s.name) === normalized) || null;
}

/**
 * @param {object} db
 * @param {string | null} code
 */
async function findSupplierByCode(db, code) {
  if (!code) return null;
  return db.get(`SELECT * FROM suppliers WHERE supplier_code = ?`, [code]);
}

/**
 * @param {ReturnType<parseAbuShalbakSupplierListMatrix>[number][]} rows
 */
function dedupeTransferRowsByName(rows) {
  /** @type {Map<string, ReturnType<parseAbuShalbakSupplierListMatrix>[number]>} */
  const byName = new Map();
  /** @type {{ row: number, reason: string, name?: string, code?: string }[]} */
  const dropped = [];
  /** @type {ReturnType<parseAbuShalbakSupplierListMatrix>[number][]} */
  const unique = [];

  for (const row of rows) {
    const name = String(row.name ?? "").trim();
    const norm = normalizeArabicNameForMatch(name);
    if (norm && byName.has(norm)) {
      dropped.push({
        row: row.rowNum,
        reason: "اسم مكرر في الملف",
        name,
        code: row.code || undefined,
      });
      continue;
    }
    if (norm) byName.set(norm, row);
    unique.push(row);
  }

  return { rows: unique, dropped };
}

/**
 * @param {object} db
 * @param {ReturnType<parseAbuShalbakSupplierListMatrix>[number]} row
 * @param {string} name
 * @param {{ includeTestRows?: boolean, claimedCodes?: Set<string> }} options
 */
async function classifyTransferRow(db, row, name, options = {}) {
  const includeTestRows = Boolean(options.includeTestRows);
  const claimedCodes = options.claimedCodes || new Set();

  if (isBalanceSummaryRow(name)) {
    return {
      action: "invalid",
      reason: "صف إجمالي — ليس مورداً",
      systemBalance: row.systemBalance,
      supplierId: null,
      codeReassigned: false,
      sourceCode: row.code,
      assignedCode: row.code,
    };
  }

  if (row.balanceStatus !== "ok") {
    return {
      action: "invalid",
      reason: row.balanceStatus === "invalid" ? "الرصيد غير صالح" : "الرصيد مفقود",
      systemBalance: null,
      supplierId: null,
      codeReassigned: false,
      sourceCode: row.code,
      assignedCode: row.code,
    };
  }

  if (!includeTestRows && isSupplierTransferTestRow({ name, code: row.code })) {
    return {
      action: "exclude",
      reason: "صف تجريبي (الاسم oo أو الرقم test) — فعّل «تضمين صفوف تجريبية» لإدراجه",
      systemBalance: row.systemBalance,
      supplierId: null,
      codeReassigned: false,
      sourceCode: row.code,
      assignedCode: row.code,
    };
  }

  const existing = await findSupplierByNormalizedName(db, name);
  if (existing) {
    return {
      action: "existing",
      reason: "موجود بالاسم — لن يُغيَّر الرصيد أو التاريخ",
      systemBalance: row.systemBalance,
      supplierId: existing.id,
      codeReassigned: false,
      sourceCode: row.code,
      assignedCode: existing.supplier_code || row.code,
    };
  }

  const sourceCode = row.code;
  const byCode = sourceCode ? await findSupplierByCode(db, sourceCode) : null;
  const codeClaimedInFile = Boolean(sourceCode && claimedCodes.has(sourceCode));
  const codeTakenByOther =
    Boolean(byCode) && normalizeArabicNameForMatch(byCode.name) !== normalizeArabicNameForMatch(name);

  if (sourceCode && (codeTakenByOther || codeClaimedInFile)) {
    return {
      action: "create",
      reason: "الرقم مستخدم لمورد آخر — سيُنشأ برقم جديد",
      systemBalance: row.systemBalance,
      supplierId: null,
      codeReassigned: true,
      sourceCode,
      assignedCode: null,
    };
  }

  return {
    action: "create",
    reason: "مورد جديد",
    systemBalance: row.systemBalance,
    supplierId: null,
    codeReassigned: false,
    sourceCode,
    assignedCode: sourceCode,
  };
}

/**
 * @param {object} db
 * @param {ReturnType<parseAbuShalbakSupplierListMatrix>[number][]} rows
 * @param {{ includeTestRows?: boolean, filename?: string, sampleLimit?: number }} [options]
 */
export async function buildSupplierListTransferPlan(db, rows, options = {}) {
  const { rows: uniqueRows, dropped } = dedupeTransferRowsByName(rows);
  const sampleLimit = options.sampleLimit ?? 20;
  const includeTestRows = Boolean(options.includeTestRows);
  const claimedCodes = new Set();

  /** @type {object[]} */
  const planRows = [];
  /** @type {{ row: number, reason: string, name?: string, code?: string }[]} */
  const errors = [...dropped];

  let toCreate = 0;
  let existing = 0;
  let invalid = dropped.length;
  let excluded = 0;
  let conflicts = 0;
  let totalPositiveSystem = 0;
  let totalNegativeSystem = 0;

  for (const row of uniqueRows) {
    const name = String(row.name ?? "").trim();
    if (!name) {
      invalid++;
      errors.push({ row: row.rowNum, reason: "الاسم مفقود", name: "", code: row.code || undefined });
      planRows.push({
        rowNum: row.rowNum,
        code: row.code,
        name: "",
        excelBalance: row.systemBalance,
        systemBalance: row.systemBalance,
        statementBalance: row.systemBalance,
        action: "invalid",
        reason: "الاسم مفقود",
        supplierId: null,
        codeReassigned: false,
        sourceCode: row.code,
        assignedCode: row.code,
      });
      continue;
    }

    const classified = await classifyTransferRow(db, row, name, { includeTestRows, claimedCodes });
    const systemBalance = classified.systemBalance;
    if (typeof systemBalance === "number") {
      if (systemBalance > 0) totalPositiveSystem = round2(totalPositiveSystem + systemBalance);
      if (systemBalance < 0) totalNegativeSystem = round2(totalNegativeSystem + systemBalance);
    }

    if (classified.action === "create") {
      toCreate++;
      if (classified.codeReassigned) conflicts++;
      else if (row.code) claimedCodes.add(row.code);
    }
    if (classified.action === "existing") existing++;
    if (classified.action === "exclude") excluded++;
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
      phone: row.phone,
      paymentTerms: row.paymentTerms,
      excelBalance: classified.systemBalance,
      systemBalance: classified.systemBalance,
      statementBalance: classified.systemBalance,
      action: classified.action,
      reason: classified.reason,
      supplierId: classified.supplierId,
      codeReassigned: classified.codeReassigned,
      sourceCode: classified.sourceCode,
      assignedCode: classified.assignedCode,
    });
  }

  return {
    type: ABU_SHALBAK_SUPPLIER_LIST_TYPE,
    destination: TRANSFER_DESTINATION,
    destinationLabel: TRANSFER_DESTINATION_LABEL,
    destinationWarning: null,
    overwriteIgnored: true,
    includeTestRows,
    stats: {
      totalRows: uniqueRows.length,
      matched: 0,
      toCreate,
      invalid,
      rejected: invalid,
      existing,
      duplicateNames: 0,
      alreadyImported: existing,
      skipped: 0,
      excluded,
      conflicts,
      codeReassigned: conflicts,
      totalPositiveExcel: totalPositiveSystem,
      totalNegativeExcel: totalNegativeSystem,
      netTotalExcel: round2(totalPositiveSystem + totalNegativeSystem),
      totalPositiveSystem,
      totalNegativeSystem,
      netTotalSystem: round2(totalPositiveSystem + totalNegativeSystem),
    },
    rows: planRows.slice(0, sampleLimit),
    allRows: planRows,
    duplicateNames: [],
    errors,
  };
}

/**
 * @param {object} db
 * @param {number} supplierId
 * @param {number} systemBalance
 * @param {string} entryDate
 * @param {string | null} sourceId
 */
async function insertTransferOpeningEntry(db, supplierId, systemBalance, entryDate, sourceId = null) {
  const { debit, credit } = openingBalanceToDebitCredit(systemBalance);
  const ins = await db.run(
    `INSERT INTO party_opening_entries
      (party_type, party_id, entry_date, description, debit, credit, source_type, source_id, notes)
     VALUES ('supplier', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      supplierId,
      entryDate,
      TRANSFER_OPENING_DESCRIPTION,
      debit,
      credit,
      TRANSFER_OPENING_ENTRY_SOURCE_TYPE,
      sourceId,
      TRANSFER_OPENING_NOTES,
    ]
  );
  return ins.lastID;
}

/**
 * Create missing suppliers from a system CSV. Never overwrites store balances or history.
 * @param {object} db
 * @param {ReturnType<parseAbuShalbakSupplierListMatrix>[number][]} rows
 * @param {{ includeTestRows?: boolean, openingBalanceDate?: string, sourceId?: string }} [options]
 */
export async function applySupplierListTransfer(db, rows, options = {}) {
  const openingBalanceDate = options.openingBalanceDate || shopTodayYmd();
  const sourceId = options.sourceId || null;

  const plan = await buildSupplierListTransferPlan(db, rows, {
    includeTestRows: options.includeTestRows,
    sampleLimit: Number.MAX_SAFE_INTEGER,
  });

  let created = 0;
  let existing = 0;
  let rejected = plan.stats.rejected;
  let excluded = 0;
  let conflicts = 0;
  const errors = [...plan.errors];

  await withTransaction(db, async () => {
    for (const planRow of plan.allRows) {
      if (planRow.action === "invalid") continue;
      if (planRow.action === "existing") {
        existing++;
        continue;
      }
      if (planRow.action === "exclude") {
        excluded++;
        continue;
      }
      if (planRow.action !== "create") continue;

      const row = rows.find((r) => r.rowNum === planRow.rowNum);
      if (!row || row.balanceStatus !== "ok") {
        rejected++;
        errors.push({
          row: planRow.rowNum,
          name: planRow.name,
          code: planRow.code || undefined,
          reason: "الرصيد غير صالح",
        });
        continue;
      }

      const systemBalance = round2(Number(row.systemBalance) || 0);
      const openingDate = isNonzeroOpening(systemBalance) ? openingBalanceDate : null;

      let supplierCode;
      if (planRow.codeReassigned || !row.code) {
        supplierCode = await ensureEntityCode(db, "supplier", null);
        if (planRow.codeReassigned) conflicts++;
      } else {
        const taken = await findSupplierByCode(db, row.code);
        if (taken) {
          supplierCode = await ensureEntityCode(db, "supplier", null);
          conflicts++;
        } else {
          supplierCode = await ensureEntityCode(db, "supplier", row.code);
        }
      }

      const ins = await db.run(
        `INSERT INTO suppliers
          (name, contact_phone, payment_terms, supplier_code, opening_balance, opening_balance_excel, balance,
           opening_balance_date, opening_balance_source)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        [
          planRow.name,
          row.phone || null,
          row.paymentTerms || null,
          supplierCode,
          systemBalance,
          systemBalance,
          openingDate,
          SUPPLIER_CSV_TRANSFER_SOURCE,
        ]
      );

      if (isNonzeroOpening(systemBalance)) {
        await insertTransferOpeningEntry(db, ins.lastID, systemBalance, openingBalanceDate, sourceId);
      }
      created++;
    }
  });

  return {
    type: ABU_SHALBAK_SUPPLIER_LIST_TYPE,
    destination: plan.destination,
    destinationLabel: plan.destinationLabel,
    destinationWarning: plan.destinationWarning,
    overwriteIgnored: true,
    created,
    updated: 0,
    existing,
    rejected,
    skipped: 0,
    excluded,
    conflicts,
    errors,
    stats: plan.stats,
    message: `تم نقل الموردين إلى إدارة الموردين: ${created} جديد، ${existing} موجود، ${conflicts} تعارض رقم، ${excluded} تجريبي مستبعد، ${rejected} مرفوض`,
  };
}
