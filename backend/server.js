import "./loadEnv.js";
import path from "path";
import cron from "node-cron";
import { fileURLToPath } from "url";
import { initDatabase } from "./database/init.js";
import { createApp } from "./app.js";
import { createBackup, pruneBackups } from "./utils/backup.js";
import { sendExpiryAlert } from "./services/expiryAlertService.js";
import { startTelegramPolling } from "./services/telegramPolling.js";
import { resolveDatabasePath } from "./utils/dbPath.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 5000;

let dbPath;
try {
  dbPath = resolveDatabasePath(__dirname);
} catch (err) {
  console.error(`[fatal] ${err.message}`);
  process.exit(1);
}
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
