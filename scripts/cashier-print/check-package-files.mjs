import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ENTRY = "backend/scripts/receipt-print-dialog-helper.mjs";

/**
 * Walk static relative imports under a package root.
 * A module is missing when the entry (or something it imports) is not on disk.
 * There is no separate allow-list: the files in this directory are the package.
 */
export function missingHelperImports(root, entry = ENTRY) {
  const missing = [];
  const seen = new Set();

  function walk(rel) {
    const norm = rel.replaceAll("\\", "/");
    if (seen.has(norm)) return;
    seen.add(norm);
    const abs = path.join(root, norm);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      missing.push(norm);
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
  return missing;
}

function isDirectRun() {
  const invoked = process.argv[1] || "";
  return invoked.replaceAll("\\", "/").endsWith("check-package-files.mjs");
}

if (isDirectRun()) {
  const root = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const missing = missingHelperImports(root);
  if (missing.length) {
    console.error(`Receipt helper package at ${root} is missing imported modules:`);
    console.error(missing.join("\n"));
    process.exit(1);
  }
  console.log(`helper package import closure is complete (${root})`);
}
