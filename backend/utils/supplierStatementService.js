import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  ensureSupplierStatementsDir,
  resolveSupplierStatementPdfPath,
  supplierStatementPdfExists,
} from "./statementPaths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

/** Sample Hesabati statement shipped for demo / ابناء الشني seeding. */
export const SAMPLE_SUPPLIER_STATEMENT_PDF = path.join(
  repoRoot,
  "data",
  "imports",
  "حساباتي _ كشف حساب عميل.pdf"
);

const SHINI_NAME_PATTERN = "%ابناء الشني%";

/**
 * Copy sample PDF to a supplier if missing. Idempotent.
 * @param {object} db
 * @param {string} dbPath
 * @param {number} supplierId
 * @param {string} [sourcePath]
 */
export async function attachSupplierStatementPdf(db, dbPath, supplierId, sourcePath = SAMPLE_SUPPLIER_STATEMENT_PDF) {
  if (!Number.isFinite(Number(supplierId))) return false;
  ensureSupplierStatementsDir(dbPath);
  const dest = resolveSupplierStatementPdfPath(dbPath, supplierId);
  if (supplierStatementPdfExists(dest)) return false;
  if (!fs.existsSync(sourcePath)) return false;

  await fs.promises.copyFile(sourcePath, dest);
  await db.run(
    `UPDATE suppliers SET statement_pdf_updated_at = datetime('now') WHERE id = ?`,
    [supplierId]
  );
  return true;
}

/**
 * Seed sample statement for شركة ابناء الشني when present in DB.
 * @param {object} db
 * @param {string} dbPath
 */
export async function seedShiniSupplierStatementPdf(db, dbPath) {
  if (!fs.existsSync(SAMPLE_SUPPLIER_STATEMENT_PDF)) {
    return { seeded: false, reason: "sample_missing" };
  }

  const supplier = await db.get(
    `SELECT id, name FROM suppliers WHERE name LIKE ? ORDER BY id LIMIT 1`,
    [SHINI_NAME_PATTERN]
  );
  if (!supplier) {
    return { seeded: false, reason: "supplier_not_found" };
  }

  const attached = await attachSupplierStatementPdf(db, dbPath, supplier.id);
  return {
    seeded: attached,
    reason: attached ? "ok" : "already_exists",
    supplier_id: supplier.id,
    supplier_name: supplier.name,
  };
}

/**
 * @param {object} db
 * @param {string} dbPath
 * @param {number} supplierId
 */
export async function removeSupplierStatementPdf(db, dbPath, supplierId) {
  const pdfPath = resolveSupplierStatementPdfPath(dbPath, supplierId);
  if (supplierStatementPdfExists(pdfPath)) {
    await fs.promises.unlink(pdfPath);
  }
  await db.run(
    `UPDATE suppliers SET statement_pdf_updated_at = NULL WHERE id = ?`,
    [supplierId]
  );
}

/**
 * @param {object} db
 * @param {string} dbPath
 * @param {number} supplierId
 * @param {Buffer} buffer
 */
export async function writeSupplierStatementPdf(db, dbPath, supplierId, buffer) {
  ensureSupplierStatementsDir(dbPath);
  const pdfPath = resolveSupplierStatementPdfPath(dbPath, supplierId);
  await fs.promises.writeFile(pdfPath, buffer);
  await db.run(
    `UPDATE suppliers SET statement_pdf_updated_at = datetime('now') WHERE id = ?`,
    [supplierId]
  );
  return pdfPath;
}

/**
 * @param {string} dbPath
 * @param {number} supplierId
 * @param {object} [supplierRow]
 */
export function getSupplierStatementMeta(dbPath, supplierId, supplierRow) {
  const pdfPath = resolveSupplierStatementPdfPath(dbPath, supplierId);
  const hasPdf = supplierStatementPdfExists(pdfPath);
  return {
    has_pdf: hasPdf,
    updated_at: supplierRow?.statement_pdf_updated_at ?? null,
    filename: hasPdf ? `${supplierId}.pdf` : null,
  };
}
