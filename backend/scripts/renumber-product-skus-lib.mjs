/**
 * Shared one-time product SKU renumber: backup, collision-safe 1..N, verify.
 * Callers must enforce which database file is allowed.
 */
import fs from "fs";
import path from "path";
import { getBackupDir } from "../utils/backup.js";
import { closeSqliteConnection, openSqliteConnection } from "../database/sqliteDriver.js";
import { getNextProductNumber } from "../utils/suggestedBarcode.js";
import { renumberAllEntityCodes } from "../utils/entityCodes.js";

export function timestampName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function tablesWithProductId(db) {
  const tables = await db.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  );
  const names = [];
  for (const { name } of tables) {
    const cols = await db.all(`PRAGMA table_info(${JSON.stringify(name)})`);
    if (cols.some((col) => col.name === "product_id")) names.push(name);
  }
  return names.sort();
}

async function fingerprintProductIds(db, tables) {
  /** @type {Record<string, { count: number, sig: string }>} */
  const out = {};
  for (const name of tables) {
    const rows = await db.all(`SELECT rowid AS rid, product_id FROM "${name}" ORDER BY rowid`);
    out[name] = {
      count: rows.length,
      sig: rows.map((r) => `${r.rid}:${r.product_id}`).join("|"),
    };
  }
  return out;
}

async function productSnapshot(db) {
  const cols = await db.all("PRAGMA table_info(products)");
  const names = cols.map((c) => c.name);
  const rows = await db.all(`SELECT ${names.join(", ")} FROM products ORDER BY id`);
  return { columnNames: names, rows };
}

function otherFieldChanges(beforeRows, afterRows, columnNames) {
  const skip = new Set(["sku"]);
  const compareCols = columnNames.filter((c) => !skip.has(c));
  let changed = 0;
  const details = [];
  const beforeById = new Map(beforeRows.map((r) => [r.id, r]));
  const afterById = new Map(afterRows.map((r) => [r.id, r]));
  for (const id of beforeById.keys()) {
    const a = beforeById.get(id);
    const b = afterById.get(id);
    if (!b) {
      changed += 1;
      details.push({ id, reason: "missing after" });
      continue;
    }
    for (const col of compareCols) {
      if (String(a[col] ?? "") !== String(b[col] ?? "")) {
        changed += 1;
        details.push({ id, col, before: a[col], after: b[col] });
      }
    }
  }
  return { changed, details };
}

function fkSig(rows) {
  return JSON.stringify(
    [...rows].map((r) => `${r.table}:${r.rowid}:${r.parent}:${r.fkid}`).sort()
  );
}

/** Flush WAL into the main file, then copy it. Avoids VACUUM INTO on a live API DB. */
export async function backupDatabaseFile(dbPath, destPrefix) {
  const dest = path.join(getBackupDir(), `${destPrefix}_${timestampName()}.db`);
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  const source = await openSqliteConnection(dbPath, { isolated: true });
  try {
    await source.exec("PRAGMA wal_checkpoint(FULL)");
  } finally {
    await closeSqliteConnection(source);
  }
  await fs.promises.copyFile(dbPath, dest);
  const verify = await openSqliteConnection(dest, { readonly: true, isolated: true });
  try {
    const row = await verify.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'");
    if (!row || Number(row.n) < 1) throw new Error("Backup verification failed: no tables");
  } finally {
    await closeSqliteConnection(verify);
  }
  const stat = await fs.promises.stat(dest);
  return { path: dest, size: stat.size };
}

/**
 * Renumber products.sku only: 1..N by id ASC, collision-safe temp step, verify.
 * @param {string} dbPath
 * @param {{ label?: string, backupPrefix?: string, reportLimit?: number }} [opts]
 */
export async function runProductSkuRenumber(dbPath, opts = {}) {
  const label = opts.label || "renumber";
  const reportLimit = opts.reportLimit ?? 40;
  const backup = await backupDatabaseFile(dbPath, opts.backupPrefix || "products-sku");
  console.log(`[${label}] backup: ${backup.path} (${backup.size} bytes)`);

  const db = await openSqliteConnection(dbPath, { isolated: true });
  try {
    await db.exec("PRAGMA foreign_keys = ON");

    const beforeCount = Number((await db.get("SELECT COUNT(*) AS n FROM products")).n);
    const beforeIds = (await db.all("SELECT id FROM products ORDER BY id")).map((r) => r.id);
    const beforeSnap = await productSnapshot(db);
    const relationTables = await tablesWithProductId(db);
    const beforeRelations = await fingerprintProductIds(db, relationTables);
    const beforeSeq = await db.get(
      "SELECT last_seq FROM entity_code_sequences WHERE entity_type = 'product'"
    );
    const beforeSkus = beforeSnap.rows.map((r) => ({
      id: r.id,
      sku: r.sku,
      barcode: r.barcode,
      name: r.name,
    }));
    const fkBefore = await db.all("PRAGMA foreign_key_check");

    console.log(`[${label}] products before: ${beforeCount}`);
    console.log(`[${label}] last_seq before: ${beforeSeq?.last_seq ?? "(none)"}`);

    const n = await renumberAllEntityCodes(db, "product");

    const afterCount = Number((await db.get("SELECT COUNT(*) AS n FROM products")).n);
    const afterIds = (await db.all("SELECT id FROM products ORDER BY id")).map((r) => r.id);
    const afterSnap = await productSnapshot(db);
    const afterRelations = await fingerprintProductIds(db, relationTables);
    const afterSeq = await db.get(
      "SELECT last_seq FROM entity_code_sequences WHERE entity_type = 'product'"
    );
    const afterSkus = afterSnap.rows.map((r) => ({
      id: r.id,
      sku: r.sku,
      barcode: r.barcode,
      name: r.name,
    }));
    const nextSku = await getNextProductNumber(db);

    const deleted = beforeIds.filter((id) => !afterIds.includes(id));
    const created = afterIds.filter((id) => !beforeIds.includes(id));
    const idChanges = beforeIds.filter((id, i) => afterIds[i] !== id);
    const barcodeChanges = beforeSnap.rows.filter(
      (row, i) => afterSnap.rows[i]?.barcode !== row.barcode
    );
    const fieldDiff = otherFieldChanges(beforeSnap.rows, afterSnap.rows, beforeSnap.columnNames);
    const uniqueSkus = new Set(afterSkus.map((r) => r.sku));
    const expectedSkus = afterIds.map((_, i) => String(i + 1));
    const actualSkus = afterSkus.map((r) => r.sku);
    const leadingZeros = afterSkus.filter((r) => /^0/.test(String(r.sku)));
    const relationChanges = relationTables.filter(
      (name) =>
        beforeRelations[name].count !== afterRelations[name].count ||
        beforeRelations[name].sig !== afterRelations[name].sig
    );

    const integrity = await db.get("PRAGMA integrity_check");
    const fkAfter = await db.all("PRAGMA foreign_key_check");

    const checks = {
      product_count_unchanged: afterCount === beforeCount && afterCount === n,
      deleted_products: deleted.length,
      recreated_products: created.length,
      changed_product_ids: idChanges.length,
      changed_barcodes: barcodeChanges.length,
      changed_fields_other_than_sku: fieldDiff.changed,
      every_sku_unique: uniqueSkus.size === afterCount,
      sequential_1_through_n: JSON.stringify(actualSkus) === JSON.stringify(expectedSkus),
      no_leading_zeros: leadingZeros.length === 0,
      product_id_relationships_unchanged: relationChanges.length === 0,
      integrity_ok: String(integrity?.integrity_check || integrity) === "ok",
      foreign_key_violations_unchanged: fkSig(fkBefore) === fkSig(fkAfter),
      preexisting_fk_orphans: fkBefore.length,
      last_seq_equals_n: Number(afterSeq?.last_seq) === n,
      next_sku_is_n_plus_1: nextSku === String(n + 1),
    };

    assert(checks.product_count_unchanged, `count mismatch before=${beforeCount} after=${afterCount} n=${n}`);
    assert(checks.deleted_products === 0, `deleted ids: ${deleted}`);
    assert(checks.recreated_products === 0, `created ids: ${created}`);
    assert(checks.changed_product_ids === 0, "product ids changed");
    assert(checks.changed_barcodes === 0, "barcodes changed");
    assert(checks.changed_fields_other_than_sku === 0, JSON.stringify(fieldDiff.details.slice(0, 10)));
    assert(checks.every_sku_unique, "duplicate SKUs");
    assert(checks.sequential_1_through_n, `SKUs sample=${JSON.stringify(actualSkus.slice(0, 20))}`);
    assert(checks.no_leading_zeros, `leading zeros: ${JSON.stringify(leadingZeros.slice(0, 10))}`);
    assert(checks.product_id_relationships_unchanged, `relation tables changed: ${relationChanges}`);
    assert(checks.integrity_ok, `integrity_check=${JSON.stringify(integrity)}`);
    assert(checks.foreign_key_violations_unchanged, JSON.stringify({ before: fkBefore, after: fkAfter }));
    assert(checks.last_seq_equals_n, `last_seq=${afterSeq?.last_seq} n=${n}`);
    assert(checks.next_sku_is_n_plus_1, `next=${nextSku} expected=${n + 1}`);

    const products = beforeSkus.map((row, i) => ({
      id: row.id,
      name: row.name,
      barcode: row.barcode,
      sku_before: row.sku,
      sku_after: afterSkus[i].sku,
    }));

    const report = {
      database: dbPath,
      backup: backup.path,
      n,
      checks,
      last_seq: { before: beforeSeq?.last_seq ?? null, after: afterSeq?.last_seq ?? null },
      next_sku: nextSku,
      products: products.length <= reportLimit ? products : products.slice(0, reportLimit),
      products_omitted: Math.max(0, products.length - reportLimit),
    };

    console.log(`[${label}] BEFORE / AFTER (first ${Math.min(products.length, reportLimit)})`);
    for (const row of report.products) {
      console.log(
        `  id=${row.id}  ${row.sku_before} -> ${row.sku_after}  barcode=${row.barcode}  ${row.name}`
      );
    }
    if (report.products_omitted) {
      console.log(`[${label}] … ${report.products_omitted} more products omitted from console`);
    }
    console.log(`[${label}] last_seq ${report.last_seq.before} -> ${report.last_seq.after}`);
    console.log(`[${label}] next generated SKU: ${nextSku}`);
    console.log(`[${label}] verification:`);
    for (const [key, value] of Object.entries(checks)) {
      console.log(`  ${key}: ${value}`);
    }
    console.log(`[${label}] OK`);
    return report;
  } finally {
    await closeSqliteConnection(db);
  }
}
