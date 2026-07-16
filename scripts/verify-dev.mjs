/**
 * Verifies dev stack: API on :5001 and admin proxy on :3001.
 * Run after `npm start` from repo root.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const checks = [
  { name: "API direct", url: "http://127.0.0.1:5001/api/v1/health" },
  { name: "Admin proxy", url: "http://127.0.0.1:3001/api/v1/health" },
];

let failed = 0;

for (const { name, url } of checks) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      console.log(`OK  ${name}: ${url}`);
    } else {
      console.error(`FAIL ${name}: ${url} → HTTP ${res.status}`);
      failed++;
    }
  } catch (err) {
    console.error(`FAIL ${name}: ${url} → ${err.message}`);
    failed++;
  }
}

if (failed > 0) {
  console.error("\nDev stack not ready. Ensure `npm start` runs from repo root and wait for [api] Server running.");

  const envFiles = [
    ".env.development",
    "frontend/.env",
    "frontend-pos/.env",
  ];
  const missing = envFiles.filter((f) => !fs.existsSync(path.join(root, f)));
  if (missing.length > 0) {
    console.error("\nMissing env files:");
    for (const f of missing) console.error(`  - ${f}`);
    console.error("\nRun: npm run setup:dev");
  }

  try {
    const res5000 = await fetch("http://127.0.0.1:5000/api/v1/health", {
      signal: AbortSignal.timeout(2000),
    });
    if (res5000.ok) {
      console.error(
        "\nAPI responded on port 5000 instead of 5001 — likely missing .env.development (PORT=5001)."
      );
      console.error("Run: npm run setup:dev   then restart npm start");
    }
  } catch {
    // port 5000 not listening — expected when API is down or on 5001
  }

  process.exit(1);
}

console.log("\nDev stack OK — admin login and kiosk should connect.");
