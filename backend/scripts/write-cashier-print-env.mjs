/**
 * Write .env.cashier-print for store tills.
 * Test-save is written only when testSave is true. Otherwise it is stripped.
 *
 *   node backend/scripts/write-cashier-print-env.mjs --file PATH --printer NAME --pos-url URL [--test-save]
 */
import fs from "fs";
import { originFromPosUrl } from "../utils/receiptPrintHelperAccess.js";

export function parseEnvLines(text) {
  return String(text || "").split(/\r?\n/);
}

export function readEnvMap(text) {
  const map = {};
  for (const line of parseEnvLines(text)) {
    const trim = line.trim();
    if (!trim || trim.startsWith("#")) continue;
    const eq = trim.indexOf("=");
    if (eq <= 0) continue;
    map[trim.slice(0, eq).trim()] = trim.slice(eq + 1).trim();
  }
  return map;
}

export function buildCashierPrintEnv({ existingText = "", printer, posUrl, widthMm = "80", testSave = false }) {
  const origin = originFromPosUrl(posUrl);
  if (!origin) {
    throw Object.assign(new Error("عنوان نقطة البيع غير صالح"), { code: "BAD_POS_URL" });
  }
  const name = String(printer || "").trim();
  if (!testSave && !name) {
    throw Object.assign(new Error("اختر طابعة"), { code: "NO_PRINTER" });
  }
  const prev = readEnvMap(existingText);
  const next = { ...prev };
  delete next.RECEIPT_PRINT_TEST_MODE;
  if (name) next.RECEIPT_PRINTER = name;
  else delete next.RECEIPT_PRINTER;
  next.RECEIPT_PRINT_ALLOWED_ORIGINS = origin;
  next.RECEIPT_PRINT_POS_URL = String(posUrl || "").trim();
  next.RECEIPT_WIDTH_MM = String(widthMm || prev.RECEIPT_WIDTH_MM || "80").trim() || "80";
  if (testSave) next.RECEIPT_PRINT_TEST_MODE = "save";

  const managed = [
    "RECEIPT_PRINTER",
    "RECEIPT_PRINT_ALLOWED_ORIGINS",
    "RECEIPT_PRINT_POS_URL",
    "RECEIPT_WIDTH_MM",
    "RECEIPT_PRINT_TEST_MODE",
  ];
  const keys = [
    ...managed.filter((k) => Object.prototype.hasOwnProperty.call(next, k)),
    ...Object.keys(next).filter((k) => !managed.includes(k)),
  ];

  const lines = [
    "# Cashier-PC receipt helper. Written by Install. Do not add secrets.",
    testSave
      ? "# RECEIPT_PRINT_TEST_MODE=save — PDF only, no Windows print job."
      : "# RECEIPT_PRINT_TEST_MODE is unset (paper). Re-run Install unchecked to leave test mode.",
    ...keys.map((k) => `${k}=${next[k]}`),
    "",
  ];
  return { text: lines.join("\n"), origin, printer: name || null, testSave: Boolean(testSave) };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return "";
  return process.argv[i + 1];
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("write-cashier-print-env.mjs");
if (isMain && process.argv.includes("--file")) {
  const file = arg("--file");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const { text, origin, testSave } = buildCashierPrintEnv({
    existingText: existing,
    printer: arg("--printer"),
    posUrl: arg("--pos-url"),
    widthMm: arg("--width") || "80",
    testSave: process.argv.includes("--test-save"),
  });
  fs.writeFileSync(file, text, "utf8");
  process.stdout.write(JSON.stringify({ ok: true, file, origin, testSave }) + "\n");
}
