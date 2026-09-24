/**
 * Development-store simulation.
 *
 *   npm run demo:store -- --reset     rebuild supermarket-demo.db and verify
 *   npm run demo:verify                compare the existing demo database; does not write sales
 *   npm run demo:store -- --switch     point .env.development at the demo file after a backup
 *   npm run demo:restore               point .env.development back at supermarket-dev.db
 *
 * Writes only backend/data/supermarket-demo.db and supermarket-demo-fault.db.
 * Never deletes supermarket-dev.db or ./data/supermarket.db.
 */
import fs from "fs";
import path from "path";

process.env.NODE_ENV = "development";
process.env.ABO_ENV = "development";
process.env.TZ = "Asia/Hebron";
process.env.JWT_SECRET = process.env.JWT_SECRET || "demo-store-jwt-not-for-production";
process.env.RECEIPT_PRINT_TEST_MODE = "save";
process.env.RECEIPT_WIDTH_MM = process.env.RECEIPT_WIDTH_MM || "80";
process.env.DISABLE_AUTO_BACKUP = "1";
process.env.DISABLE_EXPIRY_TELEGRAM_ALERT = "1";
process.env.TELEGRAM_USE_POLLING = "0";
for (const key of [
  "TELEGRAM_REFUND_BOT_TOKEN",
  "TELEGRAM_EXPIRY_BOT_TOKEN",
  "TELEGRAM_ZIMMA_BOT_TOKEN",
  "TELEGRAM_SULAF_BOT_TOKEN",
  "TELEGRAM_APPROVALS_BOT_TOKEN",
]) {
  process.env[key] = "";
}

const { closeSqliteConnection, openSqliteConnection } = await import("../../database/sqliteDriver.js");
const { createApp } = await import("../../app.js");
const { backupDevDatabase, describeDevDatabase } = await import("./backup.mjs");
const { closeDemo, createEmptyDemoDatabase } = await import("./database.mjs");
const {
  assertDevBackupSource,
  demoDbPath,
  devDbPath,
  envDevelopmentFile,
  faultDbPath,
  reportDir,
  switchFile,
} = await import("./guards.mjs");
const { checkBooks, loadExpected, pushResult, unwrap } = await import("./lib.mjs");
const { writeReport } = await import("./report.mjs");
const { assertPersisted, runSimulation } = await import("./simulate.mjs");

const expectedPath = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "expected.json");
const flags = new Set(process.argv.slice(2));
const doReset = flags.has("--reset");
const doVerify = flags.has("--verify") || !doReset;
const doFault = flags.has("--fault") || doReset;
const doSwitch = flags.has("--switch");
const skipDevBackup = flags.has("--skip-dev-backup");
const doRestore = flags.has("--restore");

function windowsPath(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  if (process.platform === "win32" && decoded.startsWith("/")) {
    return decoded.slice(1).replace(/\//g, "\\");
  }
  return decoded;
}

const fixtureFile = path.join(path.dirname(windowsPath(new URL(import.meta.url).pathname)), "fixtures", "expected.json");

function classifyDev(info) {
  const storeName = info.settings.find((row) => row.key === "store_name_ar")?.value || "";
  const license = info.settings.find((row) => row.key === "store_license")?.value || "";
  const sampleProducts = info.names.sample;
  const reasons = [];
  reasons.push(`path is the development file configured by .env.development: ${info.path}`);
  reasons.push(`users=${info.counts.users} products=${info.counts.products} suppliers=${info.counts.suppliers} transactions=${info.counts.transactions}`);
  reasons.push(`seed sample products still present: ${sampleProducts}`);
  reasons.push(`store_name_ar=${storeName || "(empty)"}`);
  reasons.push(`store_license=${license || "(empty)"}`);
  const looksImported =
    info.counts.suppliers > 20 ||
    /أبو شلبك|ابو شلبك/.test(storeName) ||
    (license && !license.includes("محاكاة"));
  const looksFakeProducts = sampleProducts === info.names.n || info.counts.products <= 3;
  if (looksImported && !looksFakeProducts) {
    return {
      ambiguous: true,
      text:
        "AMBIGUOUS. The file is the development path, but it holds a store legal name, a license number, and a large supplier list that look imported. It will not be deleted or overwritten.",
    };
  }
  return { ambiguous: false, text: "FAKE development database. Seed-sized catalog and no imported store identity." };
}

async function identify() {
  const source = assertDevBackupSource(devDbPath);
  const db = await openSqliteConnection(source, { readonly: true, isolated: true });
  try {
    const info = await describeDevDatabase(source);
    const settings = await db.all(
      "SELECT key, value FROM app_settings WHERE key IN ('store_name_ar','store_license','store_phone')"
    );
    const names = await db.get(
      `SELECT SUM(CASE WHEN name IN ('Coca Cola 500ml','Water 1L','Bread White') THEN 1 ELSE 0 END) AS sample,
              COUNT(*) AS n FROM products`
    );
    const full = { ...info, settings, names };
    const classification = classifyDev(full);
    return { ...full, classification };
  } finally {
    await closeSqliteConnection(db);
  }
}

function rewriteDatabasePath(nextRelative) {
  const text = fs.readFileSync(envDevelopmentFile, "utf8");
  if (!/^DATABASE_PATH=.*$/m.test(text)) {
    throw new Error(`${envDevelopmentFile} has no DATABASE_PATH`);
  }
  const current = text.match(/^DATABASE_PATH=(.*)$/m)[1].trim();
  const resolvedCurrent = path.resolve(path.dirname(envDevelopmentFile), "backend", current);
  const devResolved = path.resolve(devDbPath);
  const demoResolved = path.resolve(demoDbPath);
  const allowed = new Set([devResolved, demoResolved]);
  if (!allowed.has(path.resolve(resolvedCurrent))) {
    throw new Error(`Refusing to retarget DATABASE_PATH=${current} (${resolvedCurrent})`);
  }
  const updated = text.replace(/^DATABASE_PATH=.*$/m, `DATABASE_PATH=${nextRelative}`);
  fs.writeFileSync(envDevelopmentFile, updated);
  return current;
}

function switchToDemo(backup) {
  const previous = rewriteDatabasePath("./data/supermarket-demo.db");
  fs.mkdirSync(reportDir, { recursive: true });
  let kept = previous;
  if (fs.existsSync(switchFile)) {
    const existing = JSON.parse(fs.readFileSync(switchFile, "utf8"));
    if (existing.previous === "./data/supermarket-dev.db") kept = existing.previous;
  }
  const record = {
    previous: kept,
    demo: "./data/supermarket-demo.db",
    backup: backup?.path || null,
    switchedAt: new Date().toISOString(),
  };
  fs.writeFileSync(switchFile, JSON.stringify(record, null, 2));
  return record;
}

function restoreEnv() {
  if (!fs.existsSync(switchFile)) {
    throw new Error(`No switch record at ${switchFile}`);
  }
  const record = JSON.parse(fs.readFileSync(switchFile, "utf8"));
  if (record.previous !== "./data/supermarket-dev.db") {
    throw new Error(`Refusing to restore unexpected path ${record.previous}`);
  }
  rewriteDatabasePath(record.previous);
  return record;
}

async function verifyOnly(results) {
  if (!fs.existsSync(demoDbPath)) {
    throw new Error(`Demo database is missing: ${demoDbPath}. Rebuild with npm run demo:store -- --reset`);
  }
  const db = await openSqliteConnection(demoDbPath);
  try {
    const flag = await db.get("SELECT value FROM app_settings WHERE key = 'demo_store_simulated'");
    if (!flag) {
      throw new Error("Demo database has no completed simulation. Verification will not create one.");
    }
    const before = await db.get("SELECT COUNT(*) AS n FROM transactions");
    const expected = loadExpected(fixtureFile);
    const app = createApp(db, demoDbPath);
    const login = await (await import("./lib.mjs")).call(app, {
      method: "post",
      path: "/api/v1/auth/login",
      body: {
        username: expected.accounts.admin.username,
        password: expected.accounts.admin.password,
        app: "office",
      },
    });
    const token = unwrap(login.body)?.token;
    if (!token) throw new Error(`Verify login failed: ${login.status}`);
    await assertPersisted({ app, db, admin: token, expected, results, ids: {} });
    const after = await db.get("SELECT COUNT(*) AS n FROM transactions");
    if (Number(after.n) !== Number(before.n)) {
      throw new Error(`Verification changed transaction count ${before.n} → ${after.n}`);
    }
    pushResult(results, {
      scenario: "Verification does not add transactions",
      feature: "runner",
      status: "PASS",
      expected: String(before.n),
      actual: String(after.n),
      screen: "",
    });
  } finally {
    await closeSqliteConnection(db);
  }
}

async function resetAndSimulate(results) {
  const expected = loadExpected(fixtureFile);
  checkBooks(expected);
  const db = await createEmptyDemoDatabase(demoDbPath, expected);
  try {
    await runSimulation({ db, dbPath: demoDbPath, expected, results });
  } finally {
    await closeDemo(db);
  }
  return expected;
}

const results = [];
let backup = null;
let identity = null;
let expected = null;

try {
  if (doRestore && !doReset) {
    const record = restoreEnv();
    console.log(`Restored DATABASE_PATH=${record.previous}`);
    console.log(`Demo database left in place: ${demoDbPath}`);
    console.log(`Backup, if recorded: ${record.backup || "(none)"}`);
    process.exit(0);
  }

  if (doReset && !skipDevBackup) {
    identity = await identify();
    console.log(`[db] development file: ${identity.path}`);
    console.log(`[db] integrity: ${identity.integrity}`);
    console.log(`[db] ${identity.classification.text}`);
    backup = await backupDevDatabase(devDbPath);
    console.log(`[backup] ${backup.path} integrity=${backup.integrity} users=${backup.users} products=${backup.products}`);
  } else {
    console.log("[db] development file was not opened");
  }
  console.log(`[db] demo target: ${demoDbPath}`);
  console.log(`[db] fault target: ${faultDbPath}`);

  if (doReset) {
    expected = await resetAndSimulate(results);
    if (doFault) {
      const { spawn } = await import("child_process");
      const faultScript = path.join(path.dirname(fixtureFile), "..", "fault.mjs");
      const code = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [faultScript], {
          cwd: path.join(path.dirname(fixtureFile), "..", "..", ".."),
          env: process.env,
          stdio: "inherit",
        });
        child.on("error", reject);
        child.on("exit", resolve);
      });
      const faultFile = path.join(reportDir, "fault-results.json");
      if (fs.existsSync(faultFile)) {
        const faultRows = JSON.parse(fs.readFileSync(faultFile, "utf8"));
        results.push(...faultRows);
      } else if (code) {
        pushResult(results, {
          scenario: "Fault process",
          feature: "fault",
          status: "FAIL",
          expected: "fault results file",
          actual: `exit ${code}`,
          classification: "test_infrastructure",
        });
      }
    }
    if (doSwitch) {
      const record = switchToDemo(backup);
      console.log(`[switch] .env.development DATABASE_PATH=${record.demo}`);
      console.log(`[switch] previous ${record.previous} was not deleted`);
    }
  } else if (doVerify) {
    expected = loadExpected(fixtureFile);
    checkBooks(expected);
    await verifyOnly(results);
  }
} catch (error) {
  pushResult(results, {
    scenario: "Runner",
    feature: "runner",
    status: "FAIL",
    expected: "command completes",
    actual: error.stack || error.message,
    classification: "test_infrastructure",
  });
}

const walkthrough = expected?.walkthrough || loadExpected(fixtureFile).walkthrough;
const accounts = expected?.accounts || loadExpected(fixtureFile).accounts;
const reportName = doReset ? "report" : "verify-report";
const report = writeReport({
  reportDir,
  reportName,
  results,
  meta: {
    devDatabase: devDbPath,
    devClassification: identity?.classification?.text || "not identified",
    backupPath: backup?.path || null,
    demoDatabase: demoDbPath,
    faultDatabase: faultDbPath,
    uiRange: (expected || loadExpected(fixtureFile)).anchor.uiRange,
    accounts: Object.values(accounts),
    walkthrough,
    restoreCommand: `npm run demo:restore\n# or copy the backup over only if you intend to replace the development file:\n# Copy-Item '${backup?.path || "<backup>"}' '${devDbPath}'`,
  },
});

const failed = report.counts.FAIL;
console.log(`\n${failed ? "FAIL" : "PASS"}  ${report.counts.PASS} passed, ${report.counts.FAIL} failed, ${report.counts.BLOCKED} blocked`);
console.log(report.mdPath);
process.exit(failed ? 1 : 0);
