/**
 * ZKTeco connection settings come only from the environment.
 * Host, port, and comm key are never hardcoded.
 */

const ENABLED = new Set(["1", "true", "yes", "on"]);

function intOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function zktecoConfig(env = process.env) {
  const enabled = ENABLED.has(String(env.ZKTECO_ENABLED || "").trim().toLowerCase());
  const host = String(env.ZKTECO_HOST || "").trim();
  const port = intOr(env.ZKTECO_PORT, 4370);
  const commRaw = String(env.ZKTECO_COMM_KEY ?? "").trim();
  const commKey = commRaw === "" ? 0 : intOr(commRaw, 0);
  const deviceKey = String(env.ZKTECO_DEVICE_KEY || "mb160").trim() || "mb160";
  return {
    enabled,
    host,
    port: port > 0 && port < 65536 ? port : 4370,
    commKey: commKey >= 0 ? commKey : 0,
    deviceKey,
    timeoutMs: Math.min(120000, Math.max(1000, intOr(env.ZKTECO_TIMEOUT_MS, 20000))),
    attempts: Math.min(5, Math.max(1, intOr(env.ZKTECO_ATTEMPTS, 3))),
    intervalMs: 120000,
    startupDelayMs: Math.max(0, intOr(env.ZKTECO_STARTUP_DELAY_MS, 20000)),
  };
}
