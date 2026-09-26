import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const posDist = path.resolve(root, "frontend-pos", "build");
const adminDist = path.resolve(root, "frontend", "build");

const LIVE_DBS = [
  "data/supermarket.db",
  "data/supermarket.db-wal",
  "data/supermarket.db-shm",
  "backend/data/supermarket.db",
  "backend/data/supermarket.db-wal",
  "backend/data/supermarket.db-shm",
  "backend/data/supermarket-demo.db",
  "backend/data/supermarket-demo.db-wal",
  "backend/data/supermarket-demo.db-shm",
];

function stampLiveDbs() {
  const stamp = {};
  for (const rel of LIVE_DBS) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      stamp[rel] = null;
      continue;
    }
    const stat = fs.statSync(abs);
    stamp[rel] = { size: stat.size, mtimeMs: stat.mtimeMs };
  }
  return stamp;
}

function assertLiveDbsUntouched(before) {
  const after = stampLiveDbs();
  const changed = [];
  for (const rel of LIVE_DBS) {
    const a = before[rel];
    const b = after[rel];
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(rel);
  }
  if (changed.length) {
    throw new Error(`shop database files changed during the smoke test: ${changed.join(", ")}`);
  }
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: "inherit",
      shell: true,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

function mtime(file) {
  return fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
}

function needsBuild(indexFile, sources) {
  if (!fs.existsSync(indexFile)) return true;
  const built = mtime(indexFile);
  return sources.some((file) => mtime(path.join(root, file)) > built);
}

async function ensureBuilds() {
  const buildEnv = {
    ...process.env,
    CI: "false",
    GENERATE_SOURCEMAP: "false",
    DISABLE_ESLINT_PLUGIN: "true",
    NODE_ENV: "production",
  };
  delete buildEnv.ABO_ENV;
  delete buildEnv.DATABASE_PATH;
  delete buildEnv.DB_PATH;

  const posSources = [
    "frontend-pos/src/components/RefundPanel.jsx",
    "frontend-pos/src/pages/Checkout.jsx",
    "frontend-pos/src/components/pos/PosPaymentModal.jsx",
    "frontend-pos/src/components/pos/PosRefundModal.jsx",
    "frontend-pos/src/utils/completeSaleSubmit.js",
  ];
  const adminSources = [
    "frontend/src/pages/RefundApprovals.jsx",
    "frontend/src/pages/ShiftAudit.jsx",
    "frontend/src/components/CashCountFields.jsx",
    "frontend/src/components/Login.jsx",
  ];

  if (process.env.E2E_SKIP_BUILD === "1") {
    console.log("E2E_SKIP_BUILD=1, using existing frontend builds");
  } else {
    if (needsBuild(path.join(posDist, "index.html"), posSources)) {
      console.log("Building POS…");
      await run("npm", ["run", "build", "--prefix", "frontend-pos"], buildEnv);
    } else {
      console.log("POS build is current");
    }
    if (needsBuild(path.join(adminDist, "index.html"), adminSources)) {
      console.log("Building office…");
      await run("npm", ["run", "build", "--prefix", "frontend"], buildEnv);
    } else {
      console.log("Office build is current");
    }
  }

  if (!fs.existsSync(path.join(posDist, "index.html")) || !fs.existsSync(path.join(adminDist, "index.html"))) {
    throw new Error("POS and office production builds are required. Run npm run build from the repo root.");
  }
}

function startServer() {
  const env = {
    ...process.env,
    NODE_ENV: "test",
    JWT_SECRET: "e2e-return-smoke-jwt-not-for-production-use",
    HOST: "127.0.0.1",
    DISABLE_AUTO_BACKUP: "1",
    POS_DIST: posDist,
    ADMIN_DIST: adminDist,
  };
  delete env.DATABASE_PATH;
  delete env.DB_PATH;
  delete env.ABO_ENV;
  for (const key of Object.keys(env)) {
    if (key.startsWith("TELEGRAM_")) env[key] = "";
  }

  const child = spawn(process.execPath, [path.join(root, "e2e", "return-server.mjs")], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const ready = new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("return server did not become ready within 90s"));
    }, 90_000);

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      buffer += text;
      const match = buffer.match(/E2E_READY (\{.*\})\r?\n/);
      if (!match) return;
      try {
        finish(() => resolve(JSON.parse(match[1])));
      } catch (err) {
        finish(() => reject(err));
      }
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("exit", (code) => {
      finish(() => reject(new Error(`return server exited ${code} before it was ready`)));
    });
  });

  return { child, ready };
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5000),
  ]);
  if (child.exitCode == null) child.kill("SIGKILL");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3000),
  ]);
}

async function removeDir(dir) {
  if (!dir) return;
  const resolved = path.resolve(dir);
  const tmp = path.resolve(os.tmpdir());
  if (!resolved.toLowerCase().startsWith(tmp.toLowerCase())) {
    throw new Error(`refusing to delete a path outside the temp directory: ${resolved}`);
  }
  if (resolved.toLowerCase().includes("supermarket.db")) {
    throw new Error(`refusing to delete a shop database path: ${resolved}`);
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(resolved, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 9) throw err;
      await delay(200);
    }
  }
}

async function main() {
  const before = stampLiveDbs();
  let child = null;
  let tmpDir = null;
  let testCode = 1;
  try {
    if (!fs.existsSync(path.join(root, "node_modules", "@playwright", "test"))) {
      throw new Error("Install Playwright first: npm install");
    }
    console.log("Installing Playwright Chromium if needed…");
    await run("npx", ["playwright", "install", "chromium"], process.env);
    await ensureBuilds();

    const started = startServer();
    child = started.child;
    const ready = await started.ready;
    tmpDir = ready.tmpDir;
    if (/supermarket\.db/i.test(String(ready.dbPath || ""))) {
      throw new Error(`server reported a shop database: ${ready.dbPath}`);
    }
    console.log(`Disposable database: ${ready.dbPath}`);

    const playwrightEnv = {
      ...process.env,
      E2E_BASE_URL: ready.url,
      E2E_DB_PATH: ready.dbPath,
    };
    delete playwrightEnv.DATABASE_PATH;
    delete playwrightEnv.DB_PATH;
    delete playwrightEnv.ABO_ENV;
    testCode = await new Promise((resolve) => {
      const playwright = spawn(
        "npx",
        ["playwright", "test", "--config", "e2e/playwright.config.mjs"],
        {
          cwd: root,
          env: playwrightEnv,
          stdio: "inherit",
          shell: true,
        }
      );
      playwright.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await stopServer(child);
    await removeDir(tmpDir);
    assertLiveDbsUntouched(before);
  }
  process.exit(testCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
