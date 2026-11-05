import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = "backend/scripts/receipt-print-dialog-helper.mjs";
const listed = new Set([
  "backend/scripts/receipt-print-dialog-helper.mjs",
  "backend/scripts/write-cashier-print-env.mjs",
  "backend/scripts/confirm-receipt-print-dialog.ps1",
  "backend/services/windowsSilentPrint.js",
  "backend/services/chromeCdp.js",
  "backend/services/receiptPrintDialogHelper.js",
  "backend/utils/receiptPrintHelperAccess.js",
  "backend/utils/cashierPrintHelperVersion.js",
  "backend/utils/receiptPdfPage.js",
  "backend/utils/receipt.js",
  "backend/utils/storeBranding.js",
  "backend/utils/entityCodes.js",
  "backend/utils/money.js",
  "backend/utils/dbTx.js",
  "backend/utils/receiptPrintTiming.js",
  "backend/utils/receiptPrintDialogMatch.js",
  "backend/utils/shopTime.js",
  "backend/utils/httpError.js",
  "backend/utils/roles.js",
  "backend/services/cashierPayrollService.js",
]);

const seen = new Set();
const missing = [];

function walk(rel) {
  const norm = rel.replaceAll("\\", "/");
  if (seen.has(norm)) return;
  seen.add(norm);
  if (!listed.has(norm)) missing.push(norm);
  const abs = path.join(root, norm);
  if (!fs.existsSync(abs)) {
    console.error(`ABSENT ${norm}`);
    return;
  }
  const text = fs.readFileSync(abs, "utf8");
  const re = /from\s+['"](\.\.?\/[^'"]+)['"]/g;
  let match;
  while ((match = re.exec(text))) {
    let next = path.posix.normalize(path.posix.join(path.posix.dirname(norm), match[1]));
    if (!next.endsWith(".js") && !next.endsWith(".mjs")) next += ".js";
    walk(next);
  }
}

walk(entry);
if (missing.length) {
  console.error(missing.join("\n"));
  process.exit(1);
}
console.log("helper package import closure is complete");
