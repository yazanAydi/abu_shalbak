import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, "..", "node_modules", "@vladmandic", "human", "models");
const destDir = path.join(__dirname, "..", "public", "models");

const FACE_MODEL_FILES = [
  "models.json",
  "blazeface.bin",
  "blazeface.json",
  "faceres.bin",
  "faceres.json",
  "antispoof.bin",
  "antispoof.json",
  "liveness.bin",
  "liveness.json",
];

function copyFile(name) {
  const from = path.join(srcDir, name);
  const to = path.join(destDir, name);
  if (!fs.existsSync(from)) {
    console.warn(`[copy-human-models] missing: ${name}`);
    return;
  }
  fs.copyFileSync(from, to);
}

if (!fs.existsSync(srcDir)) {
  console.warn("[copy-human-models] @vladmandic/human models not installed — run npm install");
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });
for (const name of FACE_MODEL_FILES) {
  copyFile(name);
}
console.log(`[copy-human-models] copied ${FACE_MODEL_FILES.length} files to public/models`);
