import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { missingHelperImports } from "./check-package-files.mjs";

function write(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

test("fails when the package directory omits an imported module", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "abo-pkg-missing-"));
  try {
    write(
      root,
      "backend/scripts/receipt-print-dialog-helper.mjs",
      'import { formatShopWall } from "../utils/shopTime.js";\n'
    );
    const missing = missingHelperImports(root);
    assert.ok(missing.includes("backend/utils/shopTime.js"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fails when a nested import is absent even if the first import exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "abo-pkg-nested-"));
  try {
    write(
      root,
      "backend/scripts/receipt-print-dialog-helper.mjs",
      'import { formatShopWall } from "../utils/shopTime.js";\n'
    );
    write(
      root,
      "backend/utils/shopTime.js",
      'import { parseTimestampMs } from "../services/cashierPayrollService.js";\n'
    );
    const missing = missingHelperImports(root);
    assert.deepEqual(missing, ["backend/services/cashierPayrollService.js"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("passes when every statically imported module is in the package directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "abo-pkg-complete-"));
  try {
    write(
      root,
      "backend/scripts/receipt-print-dialog-helper.mjs",
      'import { formatShopWall } from "../utils/shopTime.js";\n'
    );
    write(root, "backend/utils/shopTime.js", "export function formatShopWall() { return \"\"; }\n");
    assert.deepEqual(missingHelperImports(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
