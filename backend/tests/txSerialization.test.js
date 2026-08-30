import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..");

function walkJs(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === "data" || name === "backups") continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkJs(p, acc);
    else if (name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

test("shared connection serializes BEGIN on wrapDb", () => {
  const src = fs.readFileSync(path.join(backendRoot, "database", "init.js"), "utf8");
  expect(src).toContain("function acquireBegin");
  expect(src).toContain("txKeyword");
});

test("withTransaction remains the write-queue helper", () => {
  const src = fs.readFileSync(path.join(backendRoot, "utils", "dbTx.js"), "utf8");
  expect(src).toContain("BEGIN IMMEDIATE");
  expect(src).toContain("export function withTransaction");
});

test("raw BEGIN IMMEDIATE is only allowed in dbTx.js", () => {
  const offenders = [];
  for (const file of walkJs(backendRoot)) {
    const rel = path.relative(backendRoot, file).replaceAll("\\", "/");
    if (rel === "utils/dbTx.js") continue;
    if (rel.startsWith("tests/") || rel.startsWith("scripts/")) continue;
    const src = fs.readFileSync(file, "utf8");
    if (/BEGIN\s+IMMEDIATE/i.test(src)) offenders.push(rel);
  }
  expect(offenders).toEqual([]);
});
