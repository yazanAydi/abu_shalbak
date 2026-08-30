import fs from "fs";
import path from "path";
import zlib from "zlib";

export const THRESHOLDS = {
  posReadP95: 250,
  posReadP99: 500,
  checkoutP95: 800,
  checkoutP99: 1500,
  officeP95: 1500,
  reportP95: 3000,
  checkoutDuringImportP99: 2000,
  eventLoopP99: 200,
};

const POS_READS = new Set(["pos_search", "pos_barcode"]);
const CHECKOUTS = new Set(["checkout_cash", "checkout_split", "checkout_credit"]);
const OFFICE = new Set([
  "product_search",
  "product_list",
  "product_put",
  "change_price",
  "inventory_adjust",
  "customer_op",
  "supplier_op",
  "report_daily",
  "report_stock",
]);
const REPORTS = new Set(["report_range", "account_statement"]);
const ALLOWED_4XX = new Set([
  "PRICE_MISMATCH",
  "PROMO_LIMIT",
  "CREDIT_LIMIT_EXCEEDED",
  "NO_OPEN_SHIFT",
  "RATE_LIMIT",
  "NOT_PENDING",
  "NO_CHANGE",
  "CUSTOMER_REQUIRED",
  "VALIDATION_ERROR",
  "PAYMENT_ERROR",
]);

const AUTH_FAIL_CODES = new Set([
  "INVALID_TOKEN",
  "TOKEN_EXPIRED",
  "NO_TOKEN",
  "UNAUTHORIZED",
  "AUTH_REQUIRED",
  "401",
]);

export function unexpected4xx(agg, { rateLimitOn = false } = {}) {
  return Object.entries(agg.byCode || {}).filter(([code, n]) => {
    if (n <= 0) return false;
    if (/^\d+$/.test(code) && Number(code) < 400) return false;
    if (AUTH_FAIL_CODES.has(code)) return true;
    if (ALLOWED_4XX.has(code)) return rateLimitOn ? false : code !== "RATE_LIMIT" ? false : true;
    if (code === "429" || code === "RATE_LIMIT") return !rateLimitOn;
    if (["200", "201", "202", "0"].includes(code)) return false;
    if (["TIMEOUT"].includes(code)) return true;
    if (/^\d+$/.test(code) && Number(code) >= 400 && Number(code) < 500) {
      return !["409", "400", "429"].includes(code);
    }
    return false;
  });
}

function checkoutWork(agg) {
  let n = 0;
  let success = 0;
  let qWeighted = 0;
  for (const op of CHECKOUTS) {
    const s = agg.ops?.[op];
    if (!s) continue;
    const count = Number(s.n) || 0;
    n += count;
    success += Number(s.success) || 0;
    qWeighted += (Number(s.queries_avg) || 0) * count;
  }
  return { n, success, q: n ? qWeighted / n : 0 };
}

function authFailureCount(agg) {
  let n = 0;
  for (const [code, count] of Object.entries(agg.byCode || {})) {
    if (AUTH_FAIL_CODES.has(code)) n += Number(count) || 0;
  }
  return n;
}

/**
 * Fail-closed gates. `expectCheckouts` / `expectReceipts` come from the
 * actual profile (see profileExpectations) — office/admin workloads skip them.
 */
export function evaluateThresholds(agg, resources, opts = {}) {
  const {
    rateLimitOn = false,
    importWindow = null,
    expectCheckouts = false,
    expectReceipts = false,
    receiptTotal = null,
  } = opts;
  const violations = [];

  for (const [op, stats] of Object.entries(agg.ops || {})) {
    if (POS_READS.has(op) && stats.p95 > THRESHOLDS.posReadP95) {
      violations.push(`${op} p95=${stats.p95} > ${THRESHOLDS.posReadP95}`);
    }
    if (POS_READS.has(op) && stats.p99 > THRESHOLDS.posReadP99) {
      violations.push(`${op} p99=${stats.p99} > ${THRESHOLDS.posReadP99}`);
    }
    if (CHECKOUTS.has(op) && stats.p95 > THRESHOLDS.checkoutP95) {
      violations.push(`${op} p95=${stats.p95} > ${THRESHOLDS.checkoutP95}`);
    }
    if (CHECKOUTS.has(op) && stats.p99 > THRESHOLDS.checkoutP99) {
      violations.push(`${op} p99=${stats.p99} > ${THRESHOLDS.checkoutP99}`);
    }
    if (OFFICE.has(op) && stats.p95 > THRESHOLDS.officeP95) {
      violations.push(`${op} p95=${stats.p95} > ${THRESHOLDS.officeP95}`);
    }
    if (REPORTS.has(op) && stats.p95 > THRESHOLDS.reportP95) {
      violations.push(`${op} p95=${stats.p95} > ${THRESHOLDS.reportP95}`);
    }
  }
  if (agg.http5xx > 0) violations.push(`http5xx=${agg.http5xx}`);

  const unexpected4 = unexpected4xx(agg, { rateLimitOn });
  for (const [code, n] of unexpected4) {
    violations.push(`unexpected 4xx ${code}=${n}`);
  }

  const total = Number(agg.total) || 0;
  const successful = Number(agg.successful) || 0;
  if (total > 0 && successful === 0) {
    violations.push("successful=0 (no authenticated 2xx requests)");
  }

  const authN = authFailureCount(agg);
  const invalidToken = Number(agg.byCode?.INVALID_TOKEN) || 0;
  if (total > 0 && authN / total >= 0.5) {
    violations.push(`authentication failures dominate: ${authN}/${total}`);
  }
  if (invalidToken > 0 && (successful === 0 || invalidToken / total >= 0.1 || authN / total >= 0.5)) {
    violations.push(`INVALID_TOKEN=${invalidToken} (runner cannot authenticate)`);
  }

  if (expectCheckouts) {
    const work = checkoutWork(agg);
    if (work.n === 0) {
      violations.push("profile expected checkouts but no checkout operations were recorded");
    } else if (work.success === 0 || work.q === 0) {
      violations.push(
        `profile expected checkouts but checkout work is empty (success=${work.success} q=${Number(work.q.toFixed(1))})`
      );
    }
  }

  if (expectReceipts && Number(receiptTotal) === 0) {
    violations.push("profile expected receipts but receipts.total=0");
  }

  if (resources?.eventLoopMs?.p99 > THRESHOLDS.eventLoopP99) {
    violations.push(`eventLoop p99=${resources.eventLoopMs.p99} > ${THRESHOLDS.eventLoopP99}`);
  }
  if (importWindow?.checkoutP99 > THRESHOLDS.checkoutDuringImportP99) {
    violations.push(
      `checkout p99 during import=${importWindow.checkoutP99} > ${THRESHOLDS.checkoutDuringImportP99}`
    );
  }
  return violations;
}

export function writeRunArtifacts({
  outDir,
  run,
  samples,
  markdown,
  sweepMarkdown,
}) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  const raw = samples.map((s) => JSON.stringify(s)).join("\n") + "\n";
  fs.writeFileSync(path.join(outDir, "samples.ndjson.gz"), zlib.gzipSync(raw));
  fs.writeFileSync(path.join(outDir, "REPORT.md"), markdown, "utf8");
  if (sweepMarkdown) fs.writeFileSync(path.join(outDir, "sweep.md"), sweepMarkdown, "utf8");
}

export function renderReport({ env, config, agg, invariants, resources, dbStats, violations, knownBugs, importNote }) {
  const lines = [];
  lines.push(`# Load test ${config.runId}`);
  lines.push("");
  lines.push(`**Verdict:** ${violations.length ? "THRESHOLDS BREACHED" : "within initial gates"}`);
  if (violations.length) {
    lines.push("");
    lines.push("Breaches:");
    for (const v of violations) lines.push(`- ${v}`);
  }
  lines.push("");
  lines.push("## Environment");
  lines.push("");
  lines.push(`- Node ${env.node} / ${env.driver} / ${env.os}`);
  lines.push(`- CPU ${env.cpu} (${env.cores} cores), RAM ${env.ramGb} GB`);
  lines.push(`- git ${env.git || "unknown"}`);
  lines.push("");
  lines.push("## Config");
  lines.push("");
  lines.push(`- VUs: ${config.vus}  duration: ${config.duration}s  warmup: ${config.warmup}s  mode: ${config.mode}`);
  lines.push(`- profile: ${config.profile}  think-time x${config.thinkTime}`);
  lines.push("");
  lines.push("## Totals");
  lines.push("");
  lines.push(
    `| requests | ok | failed | 4xx | 5xx | timeouts | p50 | p95 | p99 | max |`
  );
  lines.push(`|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  lines.push(
    `| ${agg.total} | ${agg.successful} | ${agg.failed} | ${agg.http4xx} | ${agg.http5xx} | ${agg.timeouts} | ${agg.latency.p50} | ${agg.latency.p95} | ${agg.latency.p99} | ${agg.latency.max} |`
  );
  lines.push("");
  lines.push("## Per operation");
  lines.push("");
  lines.push("| op | n | ok | fail | p50 | p95 | p99 | max | q/req |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const [op, s] of Object.entries(agg.ops)) {
    lines.push(
      `| ${op} | ${s.n} | ${s.success} | ${s.failed} | ${s.p50} | ${s.p95} | ${s.p99} | ${s.max} | ${s.queries_avg} |`
    );
  }
  lines.push("");
  lines.push("## SQLite instrumentation");
  lines.push("");
  if (dbStats) {
    lines.push(
      `- statements=${dbStats.statements} begins=${dbStats.begins} retries=${dbStats.retries} busy=${dbStats.busy} rollbacks=${dbStats.rollbacks}`
    );
    lines.push(
      `- tx hold p50/p95/max = ${dbStats.txHoldMs.p50}/${dbStats.txHoldMs.p95}/${dbStats.txHoldMs.max} ms`
    );
    lines.push(
      `- queue wait p50/p95/max = ${dbStats.queueWaitMs.p50}/${dbStats.queueWaitMs.p95}/${dbStats.queueWaitMs.max} ms`
    );
  }
  if (resources) {
    lines.push("");
    lines.push("## Resources");
    lines.push("");
    lines.push(
      `- event loop p50/p99/max = ${resources.eventLoopMs.p50}/${resources.eventLoopMs.p99}/${resources.eventLoopMs.max} ms`
    );
    lines.push(`- RSS=${resources.memory.rss} heap=${resources.memory.heapUsed} cpu%=${resources.cpu.pct.toFixed(1)}`);
    lines.push(`- db=${resources.dbBytes} wal=${resources.walBytes}`);
  }
  if (importNote) {
    lines.push("");
    lines.push("## Import stall");
    lines.push("");
    lines.push(importNote);
  }
  lines.push("");
  lines.push("## Invariants");
  lines.push("");
  lines.push("| name | result | detail |");
  lines.push("|---|---|---|");
  for (const r of invariants || []) {
    const tag =
      r.applicable === false || r.status === "na"
        ? "N/A"
        : r.ok
          ? "PASS"
          : r.expectedFail
            ? "KNOWN-BUG"
            : "FAIL";
    lines.push(`| ${r.name} | ${tag} | ${String(r.detail).replace(/\|/g, "/")} |`);
  }
  if (knownBugs?.length) {
    lines.push("");
    lines.push("Known production bugs surfaced: " + knownBugs.map((b) => b.name).join(", "));
  }
  lines.push("");
  return lines.join("\n");
}

export function renderSweep(rows) {
  const lines = [
    "# VU sweep",
    "",
    "| VUs | requests | rps | checkout p95 | 5xx | busy | retries | invariants |",
    "|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.vus} | ${r.total} | ${r.rps} | ${r.checkoutP95} | ${r.http5xx} | ${r.busy} | ${r.retries} | ${r.invariants} |`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function printConsoleTable(agg) {
  for (const [op, s] of Object.entries(agg.ops)) {
    console.log(
      `${op.padEnd(22)} p50=${String(s.p50).padStart(7)}  p95=${String(s.p95).padStart(7)}  p99=${String(s.p99).padStart(7)}  q=${s.queries_avg}`
    );
  }
}
