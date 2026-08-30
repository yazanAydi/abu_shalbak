/**
 * Dump EXPLAIN QUERY PLAN for hot product / sales queries.
 *
 *   node scripts/explain-plans.mjs
 *   node scripts/explain-plans.mjs --out docs/perf/query-plans.md
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initDatabase } from "../database/init.js";
import { formatProductSku } from "../utils/entityCodes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const dbPath = path.resolve(arg("db", process.env.PERF_DB_PATH || path.join(__dirname, "..", "data", "perf.db")));
const outPath = path.resolve(arg("out", path.join(__dirname, "..", "..", "docs", "perf", "query-plans.md")));

const QUERIES = [
  {
    name: "product list page (CAST sku sort — legacy)",
    sql: `SELECT id, barcode, name, sku FROM products
          WHERE COALESCE(inventory_scope, 'retail') = 'retail'
          ORDER BY CAST(sku AS INTEGER) ASC, id ASC LIMIT 200 OFFSET 0`,
  },
  {
    name: "product list page (text sku sort — current)",
    sql: `SELECT id, barcode, name, sku FROM products
          WHERE COALESCE(inventory_scope, 'retail') = 'retail'
          ORDER BY sku ASC, id ASC LIMIT 200 OFFSET 0`,
  },
  {
    name: "product count",
    sql: `SELECT COUNT(*) AS total FROM products WHERE COALESCE(inventory_scope, 'retail') = 'retail'`,
  },
  {
    name: "sku CAST equality",
    sql: `SELECT id FROM products WHERE CAST(sku AS INTEGER) = 42`,
  },
  {
    name: "sku padded equality",
    sql: `SELECT id FROM products WHERE sku = '${formatProductSku(42)}'`,
  },
  {
    name: "name LIKE search",
    sql: `SELECT id FROM products WHERE name LIKE '%أداء%' LIMIT 50`,
  },
  {
    name: "barcode exact",
    sql: `SELECT id FROM products WHERE barcode = '2000000000001'`,
  },
  {
    name: "category filter",
    sql: `SELECT id FROM products WHERE category = 'تصنيف 001' LIMIT 50`,
  },
  {
    name: "POS active retail filter",
    sql: `SELECT id FROM products
          WHERE COALESCE(is_active, 1) = 1 AND COALESCE(inventory_scope, 'retail') = 'retail'
          LIMIT 20`,
  },
  {
    name: "needs_review filter",
    sql: `SELECT id FROM products WHERE needs_review = 1 LIMIT 50`,
  },
  {
    name: "transactions by created_at range",
    sql: `SELECT id, total FROM transactions WHERE created_at >= '2026-01-01' AND created_at < '2026-12-31'`,
  },
  {
    name: "transactions date() wrapper",
    sql: `SELECT COALESCE(SUM(total),0) t FROM transactions WHERE date(created_at) >= '2026-01-01' AND date(created_at) <= '2026-12-31'`,
  },
  {
    name: "inventory ledger by product+type",
    sql: `SELECT id FROM inventory_ledger WHERE product_id = 1 AND movement_type = 'sale'`,
  },
  {
    name: "purchase invoice items by product",
    sql: `SELECT id FROM purchase_invoice_items WHERE product_id = 1`,
  },
  {
    name: "transaction items by product+date",
    sql: `SELECT id FROM transaction_items WHERE product_id = 1 AND created_at >= '2026-01-01'`,
  },
  {
    name: "product_barcodes exact",
    sql: `SELECT product_id FROM product_barcodes WHERE barcode = '2000000000001'`,
  },
  {
    name: "product_units by product",
    sql: `SELECT id FROM product_units WHERE product_id = 1`,
  },
  {
    name: "MAX(sku)",
    sql: `SELECT MAX(sku) AS mx FROM products WHERE sku IS NOT NULL AND TRIM(sku) != ''`,
  },
  {
    name: "all sku scan (legacy next-sku)",
    sql: `SELECT sku FROM products WHERE sku IS NOT NULL AND TRIM(sku) != ''`,
  },
  {
    name: "settings full scan",
    sql: `SELECT key, value FROM app_settings`,
  },
];

async function main() {
  const db = fs.existsSync(dbPath) ? await initDatabase(dbPath) : await initDatabase(":memory:");
  const lines = [
    `# Query plans`,
    ``,
    `Generated ${new Date().toISOString()} against \`${path.basename(dbPath)}\`.`,
    ``,
  ];
  for (const q of QUERIES) {
    let rows = [];
    try {
      rows = await db.all(`EXPLAIN QUERY PLAN ${q.sql}`);
    } catch (err) {
      rows = [{ detail: `ERROR: ${err.message}` }];
    }
    lines.push(`## ${q.name}`, ``, "```sql", q.sql.replace(/\s+/g, " ").trim(), "```", ``);
    lines.push("| id | parent | notused | detail |", "| --- | --- | --- | --- |");
    for (const r of rows) {
      lines.push(`| ${r.id ?? ""} | ${r.parent ?? ""} | ${r.notused ?? ""} | ${String(r.detail || "").replace(/\|/g, "/")} |`);
    }
    lines.push("");
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`[explain] wrote ${outPath}`);
  await new Promise((resolve) => {
    try {
      db.raw.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

main().catch((err) => {
  console.error("[explain] failed:", err);
  process.exit(1);
});
