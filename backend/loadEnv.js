import dotenv from "dotenv";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const telegramLocalMode = process.env.ABO_TELEGRAM_LOCAL === "1";

function resolveProfileFile() {
  if (process.env.ABO_ENV === "store") return ".env.store";
  if (process.env.ABO_ENV === "development") return ".env.development";
  if (process.env.NODE_ENV === "production") return ".env.store";
  return ".env.development";
}

if (telegramLocalMode) {
  const localPath = path.join(root, ".env.telegram-local");
  if (!fs.existsSync(localPath)) {
    console.error("[env] ABO_TELEGRAM_LOCAL=1 but .env.telegram-local is missing");
    process.exit(1);
  }
  dotenv.config({ path: localPath, override: true });
}

const profilePath = path.join(root, resolveProfileFile());
if (fs.existsSync(profilePath)) {
  dotenv.config({ path: profilePath });
} else {
  const legacy = path.join(root, ".env");
  if (fs.existsSync(legacy)) dotenv.config({ path: legacy });
}

dotenv.config({ path: path.join(__dirname, ".env") });

if (telegramLocalMode) {
  const disposableDb = path.join(os.tmpdir(), "abu-telegram-local", "approvals.db");
  if (!fs.existsSync(disposableDb)) {
    console.error(`[env] Disposable Telegram-test database is missing: ${disposableDb}`);
    process.exit(1);
  }
  process.env.DATABASE_PATH = disposableDb;
  process.env.TELEGRAM_USE_POLLING = "1";
  for (const name of [
    "TELEGRAM_REFUND_BOT_TOKEN",
    "TELEGRAM_SULAF_BOT_TOKEN",
    "TELEGRAM_EXPIRY_BOT_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_REFUND_WEBHOOK_SECRET",
    "TELEGRAM_SULAF_WEBHOOK_SECRET",
    "TELEGRAM_EXPIRY_WEBHOOK_SECRET",
  ]) {
    process.env[name] = "";
  }
  if (!String(process.env.TELEGRAM_APPROVALS_BOT_TOKEN || "").trim()) {
    console.error("[env] TELEGRAM_APPROVALS_BOT_TOKEN is empty in .env.telegram-local");
    process.exit(1);
  }
  if (!String(process.env.TELEGRAM_APPROVALS_CHAT_ID || "").trim()) {
    console.error("[env] TELEGRAM_APPROVALS_CHAT_ID is empty in .env.telegram-local");
    process.exit(1);
  }
}
