/**
 * System-wide concurrency / load runner.
 *
 *   node scripts/loadtest/runner.mjs --vus 5 --duration 20 --profile mixed
 *   node scripts/loadtest/runner.mjs --sweep 5,10 --duration 15
 *   node scripts/loadtest/runner.mjs --break-auth --vus 2 --duration 4 --profile pos
 *
 * apply-env-first MUST be the first import. auth.js freezes JWT_SECRET at
 * load time; issueToken() signs with process.env.JWT_SECRET at call time.
 */
import "./apply-env-first.mjs";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { initDatabase } from "../../database/init.js";
import { closeSqliteConnection, useBetterSqlite } from "../../database/sqliteDriver.js";
import { captureBaseline } from "../../tests/load/snapshot.js";
import {
  checkInvariants,
  unexpectedInvariantFailures,
  knownInvariantFailures,
  formatInvariantReport,
} from "../../tests/load/invariants.js";
import { LOAD_ADMIN, mulberry32 } from "../../tests/load/factories.js";
import {
  assertSafeLoadtestDbPath,
  applyLoadtestEnv,
  LOADTEST_DATA_DIR,
  LOADTEST_REPORT_DIR,
  ensureDir,
  newRunId,
} from "./guards.mjs";
import { seedLoadtestDb } from "./seed-loadtest-db.mjs";
import { startLoadtestServer } from "./server.mjs";
import { allocateRoles, profileExpectations } from "./profiles.mjs";
import { issueToken, runVu, holdSse, runBackgroundJobs, startShift } from "./vu.mjs";
import { aggregateSamples } from "./metrics.mjs";
import {
  evaluateThresholds,
  writeRunArtifacts,
  renderReport,
  renderSweep,
  printConsoleTable,
} from "./report.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function workloadGates(opts, agg, receiptTotal, extra = {}) {
  const expect = profileExpectations(opts.profile);
  return {
    rateLimitOn: opts.rateLimitOn,
    expectCheckouts: expect.expectCheckouts,
    expectReceipts: expect.expectReceipts,
    receiptTotal,
    ...extra,
  };
}

async function countReceipts(db) {
  const row = await db.get(
    "SELECT COUNT(*) AS total FROM transactions WHERE receipt_number IS NOT NULL"
  );
  return Number(row?.total) || 0;
}

function invariantExtras(opts) {
  return { expectSales: profileExpectations(opts.profile).expectReceipts };
}

function envBlock(driver) {
  return {
    node: process.version,
    driver,
    os: `${os.platform()} ${os.release()}`,
    cpu: os.cpus()[0]?.model || "unknown",
    cores: os.cpus().length,
    ramGb: Number((os.totalmem() / 1e9).toFixed(1)),
    git: gitHead(),
  };
}

function gitHead() {
  try {
    return fs.readFileSync(path.resolve(__dirname, "../../../.git/HEAD"), "utf8").trim();
  } catch {
    return "";
  }
}

async function loadCatalog(db) {
  const products = await db.all(
    `SELECT id, barcode, name, price, cost, stock, category FROM products
     WHERE COALESCE(is_active,1)=1 ORDER BY id LIMIT 200`
  );
  const customers = await db.all("SELECT id, name, credit_limit, balance FROM customers LIMIT 50");
  const cashiers = await db.all(
    "SELECT id, username, role FROM users WHERE role = 'cashier' AND username LIKE 'loadcashier%'"
  );
  const admin = await db.get("SELECT id, username, role FROM users WHERE username = ?", [LOAD_ADMIN.username]);
  return { products, customers, cashiers, admin };
}

async function loginFleet(baseUrl, catalog) {
  if (!catalog.admin) throw new Error("loadadmin user missing from loadtest DB");
  const adminToken = issueToken(catalog.admin);
  const cashierTokens = [];
  for (const c of catalog.cashiers) {
    const token = issueToken(c);
    const shift = await startShift(baseUrl, token);
    if (shift.status >= 500) {
      throw new Error(`shift start failed for ${c.username}: ${shift.status} ${JSON.stringify(shift.json)}`);
    }
    cashierTokens.push({ ...c, token });
  }
  if (!cashierTokens.length) throw new Error("no loadcashier* users in loadtest DB");
  return { adminToken, cashierTokens };
}

async function runInproc(opts) {
  const seeded = opts.dbPath
    ? { dbPath: assertSafeLoadtestDbPath(opts.dbPath) }
    : await seedLoadtestDb({ size: opts.size, seed: opts.seed });
  const dbPath = seeded.dbPath;
  applyLoadtestEnv({
    dbPath,
    backupDir: path.join(path.dirname(dbPath), "backups"),
    rateLimitOn: opts.rateLimitOn,
  });

  const inspect = await initDatabase(dbPath);
  const catalog = await loadCatalog(inspect);
  const baseline = await captureBaseline(inspect);
  await closeSqliteConnection(inspect);

  const server = await startLoadtestServer({
    dbPath,
    rateLimitOn: opts.rateLimitOn,
    backupDir: path.join(path.dirname(dbPath), "backups"),
  });

  const fleet = await loginFleet(server.baseUrl, catalog);
  const roles = allocateRoles(opts.vus, opts.profile);
  const rng = mulberry32(opts.seed + opts.vus);
  const samples = [];
  const record = (s) => samples.push(s);
  let measuringOn = false;
  const measuring = () => measuringOn;

  const warmupUntil = Date.now() + opts.warmup * 1000;
  const stopAt = warmupUntil + opts.duration * 1000;
  const vuTasks = [];
  let vuId = 0;

  for (let i = 0; i < roles.pos; i += 1) {
    const cashier = fleet.cashierTokens[i % fleet.cashierTokens.length];
    if (!cashier) continue;
    vuId += 1;
    vuTasks.push(
      runVu({
        baseUrl: server.baseUrl,
        role: "pos",
        token: cashier.token,
        catalog,
        rng,
        stopAt,
        measuring,
        record,
        thinkMultiplier: opts.thinkTime,
        vuId,
      })
    );
    if (i === 0) {
      vuTasks.push(holdSse(server.baseUrl, cashier.token, stopAt));
    }
  }
  for (let i = 0; i < roles.office; i += 1) {
    vuId += 1;
    vuTasks.push(
      runVu({
        baseUrl: server.baseUrl,
        role: "office",
        token: fleet.adminToken,
        catalog,
        rng,
        stopAt,
        measuring,
        record,
        thinkMultiplier: opts.thinkTime,
        vuId,
      })
    );
  }
  for (let i = 0; i < roles.admin; i += 1) {
    vuId += 1;
    vuTasks.push(
      runVu({
        baseUrl: server.baseUrl,
        role: "admin",
        token: fleet.adminToken,
        catalog,
        rng,
        stopAt,
        measuring,
        record,
        thinkMultiplier: opts.thinkTime,
        vuId,
      })
    );
  }

  const bg = runBackgroundJobs({
    baseUrl: server.baseUrl,
    token: fleet.adminToken,
    catalog,
    schedule:
      opts.profile === "mixed"
        ? [
            { op: "import_csv", atMs: opts.warmup * 1000 + 3000, rows: 200, start: 940000, filename: "bg-200.csv" },
            { op: "import_csv", atMs: opts.warmup * 1000 + 8000, rows: 400, start: 950000, filename: "bg-400.csv" },
          ]
        : [],
    record,
    measuring,
  });

  await new Promise((r) => setTimeout(r, opts.warmup * 1000));
  measuringOn = true;
  const measuredStart = Date.now();
  await Promise.all([...vuTasks, bg]);
  const measuredMs = Date.now() - measuredStart;

  const closed = await server.close();
  const afterDb = await initDatabase(dbPath);
  const receiptTotal = await countReceipts(afterDb);
  const invariants = await checkInvariants(afterDb, baseline, invariantExtras(opts));
  await closeSqliteConnection(afterDb);

  const measured = samples.filter((s) => !s.longRunning);
  const agg = aggregateSamples(measured);
  const importSamples = samples.filter((s) => s.op === "import_csv");
  const checkoutSamples = measured.filter((s) => String(s.op).startsWith("checkout_"));
  const importNote = importSamples.length
    ? `imports=${importSamples.length} max_ms=${Math.max(...importSamples.map((s) => s.ms))} checkout_p99=${aggregateSamples(checkoutSamples).latency.p99}`
    : "";
  const violations = evaluateThresholds(
    agg,
    closed.resources,
    workloadGates(opts, agg, receiptTotal, {
      importWindow: importSamples.length
        ? { checkoutP99: aggregateSamples(checkoutSamples).latency.p99 }
        : null,
    })
  );
  const unexpected = unexpectedInvariantFailures(invariants);
  const known = knownInvariantFailures(invariants);

  return {
    dbPath,
    env: envBlock(server.driver),
    config: opts,
    agg,
    samples,
    invariants,
    resources: closed.resources,
    dbStats: closed.stats,
    violations: [...violations, ...unexpected.map((u) => `invariant ${u.name}: ${u.detail}`)],
    knownBugs: known,
    importNote,
    measuredMs,
    keep: opts.keep,
  };
}

async function runMultiproc(opts) {
  const seeded = opts.dbPath
    ? { dbPath: assertSafeLoadtestDbPath(opts.dbPath) }
    : await seedLoadtestDb({ size: opts.size, seed: opts.seed });
  applyLoadtestEnv({ dbPath: seeded.dbPath, rateLimitOn: opts.rateLimitOn });
  const inspect = await initDatabase(seeded.dbPath);
  const catalog = await loadCatalog(inspect);
  const baseline = await captureBaseline(inspect);
  await closeSqliteConnection(inspect);

  const processes = Math.max(2, Number(opts.processes) || 3);
  const children = [];
  const ports = [];
  for (let i = 0; i < processes; i += 1) {
    const child = spawn(process.execPath, [path.join(__dirname, "server.mjs"), "--db", seeded.dbPath], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, DATABASE_PATH: seeded.dbPath },
    });
    const port = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("child start timeout")), 20000);
      child.on("message", (msg) => {
        if (msg?.type === "ready") {
          clearTimeout(t);
          resolve(msg.port);
        }
      });
      child.on("error", reject);
    });
    ports.push(port);
    children.push(child);
  }

  const baseUrls = ports.map((p) => `http://127.0.0.1:${p}`);
  const fleet = await loginFleet(baseUrls[0], catalog);
  const roles = allocateRoles(opts.vus, opts.profile);
  const rng = mulberry32(opts.seed + 99);
  const samples = [];
  const record = (s) => samples.push(s);
  let measuringOn = false;
  const stopAt = Date.now() + (opts.warmup + opts.duration) * 1000;
  const tasks = [];
  let vuId = 0;
  const assignUrl = () => baseUrls[vuId % baseUrls.length];

  for (let i = 0; i < roles.pos; i += 1) {
    const cashier = fleet.cashierTokens[i % fleet.cashierTokens.length];
    vuId += 1;
    tasks.push(
      runVu({
        baseUrl: assignUrl(),
        role: "pos",
        token: cashier.token,
        catalog,
        rng,
        stopAt,
        measuring: () => measuringOn,
        record,
        thinkMultiplier: opts.thinkTime,
        vuId,
      })
    );
  }
  for (let i = 0; i < roles.office + roles.admin; i += 1) {
    vuId += 1;
    tasks.push(
      runVu({
        baseUrl: assignUrl(),
        role: i < roles.office ? "office" : "admin",
        token: fleet.adminToken,
        catalog,
        rng,
        stopAt,
        measuring: () => measuringOn,
        record,
        thinkMultiplier: opts.thinkTime,
        vuId,
      })
    );
  }

  await new Promise((r) => setTimeout(r, opts.warmup * 1000));
  measuringOn = true;
  if (opts.mode === "restart" && children[0]) {
    setTimeout(() => {
      try {
        children[0].kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, Math.min(opts.duration * 400, 8000));
  }
  await Promise.allSettled(tasks);
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }

  const afterDb = await initDatabase(seeded.dbPath);
  const receiptTotal = await countReceipts(afterDb);
  const invariants = await checkInvariants(afterDb, baseline, invariantExtras(opts));
  await closeSqliteConnection(afterDb);
  const agg = aggregateSamples(samples.filter((s) => !s.longRunning));
  const busy = samples.filter((s) => /BUSY|locked/i.test(String(s.code || ""))).length;
  const violations = [
    ...evaluateThresholds(agg, null, workloadGates(opts, agg, receiptTotal)),
    ...unexpectedInvariantFailures(invariants).map((u) => `invariant ${u.name}: ${u.detail}`),
  ];
  return {
    dbPath: seeded.dbPath,
    env: envBlock((await useBetterSqlite()) ? "better-sqlite3" : "sqlite3"),
    config: opts,
    agg,
    samples,
    invariants,
    resources: null,
    dbStats: { busy, retries: 0, statements: 0, begins: 0, rollbacks: 0, txHoldMs: {}, queueWaitMs: {} },
    violations,
    knownBugs: knownInvariantFailures(invariants),
    importNote: `multiproc processes=${processes} client_busy_codes=${busy}`,
    measuredMs: opts.duration * 1000,
    keep: opts.keep,
  };
}

function writeAndPrint(result, sweepRows) {
  const runId = result.config.runId;
  const outDir = result.config.out || path.join(LOADTEST_REPORT_DIR, runId);
  ensureDir(outDir);
  const md = renderReport({
    env: result.env,
    config: result.config,
    agg: result.agg,
    invariants: result.invariants,
    resources: result.resources,
    dbStats: result.dbStats,
    violations: result.violations,
    knownBugs: result.knownBugs,
    importNote: result.importNote,
  });
  writeRunArtifacts({
    outDir,
    run: {
      env: result.env,
      config: result.config,
      metrics: result.agg,
      invariants: result.invariants,
      resources: result.resources,
      dbStats: result.dbStats,
      violations: result.violations,
    },
    samples: result.samples,
    markdown: md,
    sweepMarkdown: sweepRows ? renderSweep(sweepRows) : null,
  });
  printConsoleTable(result.agg);
  console.log(`[loadtest] report ${path.join(outDir, "REPORT.md")}`);
  if (result.violations?.length) {
    console.log("[loadtest] FAIL-CLOSED:");
    for (const v of result.violations) console.log(`  - ${v}`);
  }
  if (result.invariants) console.log(formatInvariantReport(result.invariants));
  if (!result.keep && result.dbPath && !result.violations.length) {
    try {
      fs.rmSync(path.dirname(result.dbPath), { recursive: true, force: true });
    } catch {
      /* keep on failure to unlink */
    }
  } else if (result.violations.length) {
    console.log(`[loadtest] retained DB for post-mortem: ${result.dbPath}`);
  }
  return outDir;
}

async function main() {
  const sweepArg = arg("sweep");
  const vusList = sweepArg
    ? String(sweepArg)
        .split(",")
        .map((n) => Number(n.trim()))
        .filter((n) => n > 0)
    : [Number(arg("vus", 5))];

  const base = {
    duration: Number(arg("duration", 20)),
    warmup: Number(arg("warmup", 5)),
    profile: arg("profile", "mixed"),
    mode: arg("mode", "inproc"),
    processes: Number(arg("processes", 3)),
    dbPath: arg("db"),
    out: arg("out"),
    keep: hasFlag("keep"),
    rateLimitOn: arg("rate-limit", "off") === "on",
    thinkTime: Number(arg("think-time", 1)),
    seed: Number(arg("seed", 20260830)),
    size: arg("size", vusList.some((v) => v >= 30) ? "medium" : "small"),
    runId: newRunId(),
  };

  if (base.dbPath) assertSafeLoadtestDbPath(base.dbPath);
  if (hasFlag("break-auth")) {
    process.env.LOADTEST_BREAK_AUTH = "1";
    console.log("[loadtest] LOADTEST_BREAK_AUTH=1 (tokens will not verify)");
  }

  const sweepRows = [];
  let failed = false;
  for (const vus of vusList) {
    const opts = { ...base, vus, runId: `${base.runId}-vus${vus}` };
    console.log(`[loadtest] starting vus=${vus} duration=${opts.duration}s mode=${opts.mode}`);
    const result =
      opts.mode === "inproc" ? await runInproc(opts) : await runMultiproc(opts);
    writeAndPrint(result, null);
    const checkout = result.agg.ops.checkout_cash || result.agg.ops.checkout_split || { p95: 0 };
    sweepRows.push({
      vus,
      total: result.agg.total,
      rps: Number((result.agg.total / (result.measuredMs / 1000 || 1)).toFixed(2)),
      checkoutP95: checkout.p95,
      http5xx: result.agg.http5xx,
      busy: result.dbStats?.busy || 0,
      retries: result.dbStats?.retries || 0,
      invariants: unexpectedInvariantFailures(result.invariants).length ? "FAIL" : "ok",
    });
    if (result.violations.length || result.agg.http5xx) failed = true;
  }
  if (vusList.length > 1) {
    const sweepDir = path.join(LOADTEST_REPORT_DIR, base.runId);
    ensureDir(sweepDir);
    fs.writeFileSync(path.join(sweepDir, "sweep.md"), renderSweep(sweepRows), "utf8");
    console.log(`[loadtest] sweep ${path.join(sweepDir, "sweep.md")}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("[loadtest] failed:", err);
  process.exit(1);
});
