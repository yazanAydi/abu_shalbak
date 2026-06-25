import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function resolveProfileFile() {
  if (process.env.ABO_ENV === "store") return ".env.store";
  if (process.env.ABO_ENV === "development") return ".env.development";
  if (process.env.NODE_ENV === "production") return ".env.store";
  return ".env.development";
}

const profilePath = path.join(root, resolveProfileFile());
if (fs.existsSync(profilePath)) {
  dotenv.config({ path: profilePath });
} else {
  const legacy = path.join(root, ".env");
  if (fs.existsSync(legacy)) dotenv.config({ path: legacy });
}

dotenv.config({ path: path.join(__dirname, ".env") });
