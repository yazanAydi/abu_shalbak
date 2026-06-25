import fs from "fs";
import path from "path";

/**
 * @param {string} dbPath Absolute path to supermarket.db
 */
export function resolveSupplierStatementsDir(dbPath) {
  const dataDir = path.dirname(path.resolve(dbPath));
  return path.join(dataDir, "statements", "suppliers");
}

/**
 * @param {string} dbPath
 * @param {number} supplierId
 */
export function resolveSupplierStatementPdfPath(dbPath, supplierId) {
  return path.join(resolveSupplierStatementsDir(dbPath), `${supplierId}.pdf`);
}

/**
 * @param {string} dbPath
 */
export function ensureSupplierStatementsDir(dbPath) {
  const dir = resolveSupplierStatementsDir(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * @param {string} pdfPath
 */
export function supplierStatementPdfExists(pdfPath) {
  try {
    return fs.existsSync(pdfPath) && fs.statSync(pdfPath).isFile();
  } catch {
    return false;
  }
}
