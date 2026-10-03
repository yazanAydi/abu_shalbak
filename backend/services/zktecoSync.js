import { zktecoConfig } from "./zkteco/config.js";
import { readDeviceSnapshot } from "./zkteco/readOnlyAdapter.js";
import { importAttendanceSnapshot } from "./attendanceDeviceImport.js";
import { utcMsToSql } from "../utils/shopTime.js";

let syncing = false;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("انتهت مهلة الاتصال بجهاز البصمة")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function saveSyncState(db, deviceKey, patch) {
  const current = await db.get("SELECT * FROM attendance_device_sync WHERE device_key = ?", [deviceKey]);
  const next = {
    last_success_at: current?.last_success_at || null,
    last_error: current?.last_error || null,
    last_error_at: current?.last_error_at || null,
    last_attempt_at: current?.last_attempt_at || null,
    last_firmware: current?.last_firmware || null,
    ...patch,
  };
  await db.run(
    `INSERT INTO attendance_device_sync
       (device_key, last_success_at, last_error, last_error_at, last_attempt_at, last_firmware)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_key) DO UPDATE SET
       last_success_at = excluded.last_success_at,
       last_error = excluded.last_error,
       last_error_at = excluded.last_error_at,
       last_attempt_at = excluded.last_attempt_at,
       last_firmware = excluded.last_firmware`,
    [
      deviceKey,
      next.last_success_at,
      next.last_error,
      next.last_error_at,
      next.last_attempt_at,
      next.last_firmware,
    ]
  );
}

/**
 * Read the terminal and import into the local database.
 * Payroll callers must not use this. A failing device returns ok:false.
 */
export async function syncZkteco(db, options = {}) {
  const cfg = options.config || zktecoConfig(options.env);
  if (!options.readSnapshot && !cfg.enabled) {
    return { ok: false, skipped: true, reason: "disabled" };
  }
  if (!options.readSnapshot && !cfg.host) {
    return { ok: false, skipped: true, reason: "no_host" };
  }
  if (syncing && !options.force) {
    return { ok: false, skipped: true, reason: "busy" };
  }
  syncing = true;
  const deviceKey = options.deviceKey || cfg.deviceKey;
  const attempts = options.attempts || cfg.attempts || 3;
  const timeoutMs = options.timeoutMs || cfg.timeoutMs;
  let lastError = null;
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const read = options.readSnapshot
          ? options.readSnapshot()
          : readDeviceSnapshot(cfg, options.factory);
        const snapshot = await withTimeout(Promise.resolve(read), timeoutMs);
        const imported = await importAttendanceSnapshot(db, snapshot, { deviceKey });
        const now = utcMsToSql(Date.now());
        await saveSyncState(db, deviceKey, {
          last_success_at: now,
          last_error: null,
          last_error_at: null,
          last_attempt_at: now,
          last_firmware: snapshot?.firmware || null,
        });
        return { ok: true, attempts: attempt, ...imported, firmware: snapshot?.firmware || null };
      } catch (error) {
        lastError = error;
      }
    }
    const now = utcMsToSql(Date.now());
    const message = lastError?.message || "تعذر قراءة جهاز البصمة";
    await saveSyncState(db, deviceKey, {
      last_error: message,
      last_error_at: now,
      last_attempt_at: now,
    });
    return { ok: false, attempts, error: message };
  } finally {
    syncing = false;
  }
}

export function startZktecoSync(db, env = process.env) {
  const cfg = zktecoConfig(env);
  if (!cfg.enabled) {
    console.log("[zkteco] sync disabled");
    return { stop() {} };
  }
  if (!cfg.host) {
    console.error("[zkteco] ZKTECO_ENABLED is set but ZKTECO_HOST is empty");
    return { stop() {} };
  }
  const run = () => {
    syncZkteco(db, { config: cfg }).then(
      (result) => {
        if (result.ok) console.log(`[zkteco] imported ${result.inserted_events} new event(s)`);
        else if (!result.skipped) console.error(`[zkteco] sync failed: ${result.error}`);
      },
      (error) => console.error("[zkteco] sync failed:", error?.message || error)
    );
  };
  const startup = setTimeout(run, cfg.startupDelayMs);
  const timer = setInterval(run, cfg.intervalMs);
  return {
    stop() {
      clearTimeout(startup);
      clearInterval(timer);
    },
  };
}

export async function getDeviceAttendanceStatus(db, deviceKey) {
  const sync = await db.get("SELECT * FROM attendance_device_sync WHERE device_key = ?", [deviceKey]);
  const lastPunch = await db.get(
    "SELECT MAX(punched_at) AS punched_at FROM attendance_device_events WHERE device_key = ?",
    [deviceKey]
  );
  const { getPayrollAttendanceCutover } = await import("./payrollCutover.js");
  return {
    device_key: deviceKey,
    last_success_at: sync?.last_success_at || null,
    last_error: sync?.last_error || null,
    last_error_at: sync?.last_error_at || null,
    last_attempt_at: sync?.last_attempt_at || null,
    last_firmware: sync?.last_firmware || null,
    last_punch_at: lastPunch?.punched_at || null,
    cutover: await getPayrollAttendanceCutover(db),
  };
}
