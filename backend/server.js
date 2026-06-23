import "./loadEnv.js";
import path from "path";
import cron from "node-cron";
import { fileURLToPath } from "url";
import { initDatabase } from "./database/init.js";
import { createApp } from "./app.js";
import { createBackup, pruneBackups } from "./utils/backup.js";
import { sendExpiryAlert } from "./services/expiryAlertService.js";
import { startTelegramPolling } from "./services/telegramPolling.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 5000;

/**
 * Resolve the ONE official database file. In production an explicit
 * DATABASE_PATH (or legacy DB_PATH) is required and the process fails fast if
 * it is missing, so the live data file can never be ambiguous. In development
 * we fall back to ../data/supermarket.db. The resolved ABSOLUTE path is always
 * logged so operators can confirm which file is in use.
 */
function resolveDbPath() {
  const explicit =
    (process.env.DATABASE_PATH && String(process.env.DATABASE_PATH).trim()) ||
    (process.env.DB_PATH && String(process.env.DB_PATH).trim());
  if (explicit) return path.resolve(explicit);

  if (process.env.NODE_ENV === "production") {
    console.error(
      "[fatal] DATABASE_PATH is required in production. Set it to the absolute path of the official database file, e.g. DATABASE_PATH=C:\\abo_shalbak\\data\\supermarket.db"
    );
    process.exit(1);
  }
  return path.resolve(__dirname, "..", "data", "supermarket.db");
}

const dbPath = resolveDbPath();
console.log(`[db] Using database file: ${dbPath}`);

let db;
try {
  db = await initDatabase(dbPath);
} catch (err) {
  console.error(`[fatal] Failed to open/initialize database at ${dbPath}: ${err.message}`);
  process.exit(1);
}

const app = createApp(db, dbPath, {
  enableStatic: process.env.NODE_ENV === "production",
});

const HOST = process.env.HOST || "127.0.0.1";

if (process.env.NODE_ENV !== "test") {
  const server = app.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
    console.log(`Database initialized at ${dbPath}`);
    console.log("Leave this window open — closing it stops the API.");
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${PORT} is already in use. Another server is running, or stop it: netstat -ano | findstr :${PORT}`
      );
    } else {
      console.error(err);
    }
    process.exit(1);
  });

  server.timeout = 600000;
  server.keepAliveTimeout = 65000;
  if ("requestTimeout" in server) {
    server.requestTimeout = 600000;
  }

  if (process.env.DISABLE_AUTO_BACKUP !== "1") {
    cron.schedule("0 2 * * *", async () => {
      try {
        const result = await createBackup(dbPath);
        await pruneBackups(30);
        console.log(`[backup] Created ${result.filename} (${result.size} bytes)`);
      } catch (e) {
        console.error("[backup] Automatic backup failed:", e.message);
      }
    });
  }

  if (process.env.DISABLE_EXPIRY_TELEGRAM_ALERT !== "1") {
    const alertHour = Math.min(
      23,
      Math.max(0, Math.floor(Number(process.env.TELEGRAM_EXPIRY_ALERT_HOUR ?? 8)))
    );
    cron.schedule(`0 ${alertHour} * * *`, async () => {
      try {
        const result = await sendExpiryAlert(db);
        if (result.sent) {
          console.log(
            `[expiry-alert] Sent Telegram alert: ${result.count} items (${result.products} products, ${result.batches} batches)`
          );
        }
      } catch (e) {
        console.error("[expiry-alert] Telegram alert failed:", e.message);
      }
    });
  }

  startTelegramPolling(db);
}

export { app, db, dbPath };
