/**
 * Copies dev env example files when targets are missing.
 * Safe to run repeatedly — never overwrites existing files.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const copies = [
  { from: ".env.development.example", to: ".env.development" },
  { from: "frontend/.env.example", to: "frontend/.env" },
  { from: "frontend/.env.development.example", to: "frontend/.env.development" },
  { from: "frontend-pos/.env.example", to: "frontend-pos/.env" },
];

let created = 0;

for (const { from, to } of copies) {
  const src = path.join(root, from);
  const dest = path.join(root, to);

  if (fs.existsSync(dest)) {
    console.log(`skip ${to} (already exists)`);
    continue;
  }

  if (!fs.existsSync(src)) {
    console.warn(`warn ${from} not found — cannot create ${to}`);
    continue;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`created ${to} from ${from}`);
  created++;
}

const frontendDevEnv = path.join(root, "frontend/.env.development");
if (fs.existsSync(frontendDevEnv)) {
  const text = fs.readFileSync(frontendDevEnv, "utf8");
  if (/REACT_APP_API_BASE\s*=\s*http:\/\/127\.0\.0\.1:5000/.test(text)) {
    const fixed = text.replace(/^REACT_APP_API_BASE\s*=.*$/m, "").trimEnd() + "\n";
    fs.writeFileSync(frontendDevEnv, fixed);
    console.warn(
      "fixed frontend/.env.development — removed REACT_APP_API_BASE=:5000 (use dev proxy on :3001 → :5001)"
    );
  }
}

if (created > 0) {
  console.log(`\nDev env ready (${created} file(s) created). Run npm start from repo root.`);
} else {
  console.log("\nDev env files already present.");
}
