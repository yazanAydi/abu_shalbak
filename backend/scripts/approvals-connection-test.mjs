/**
 * Send one connection-test message from @AbuShalbakApprovalsBot.
 * Reads the shop file only. Does not print the token.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(root, ".env.store") });

const { sendApprovalsConnectionTest } = await import("../utils/telegram.js");

try {
  const result = await sendApprovalsConnectionTest();
  console.log(
    `Approvals connection test sent to the configured group. message_id=${result?.message_id ?? "unknown"}`
  );
} catch (err) {
  if (err?.code === "APPROVALS_NOT_CONFIGURED") {
    console.error("Approvals connection test not sent: token or group chat id is empty in .env.store.");
    process.exit(2);
  }
  console.error(`Approvals connection test failed: ${err.message}`);
  process.exit(1);
}
