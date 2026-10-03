import { createRequire } from "module";
import { shopLocalToUtcMs } from "../../utils/shopTime.js";

/**
 * Commands this process is allowed to send. Connect, auth, version, and clock
 * read only. Write, enroll, and clear commands are rejected before send.
 */
export const READ_ONLY_COMMANDS = Object.freeze({
  GET_VERSION: 1100,
  GET_TIME: 201,
  AUTH: 1102,
});

const ALLOWED = new Set(Object.values(READ_ONLY_COMMANDS));

export function assertReadOnlyCommand(command) {
  const code = Number(command);
  if (!ALLOWED.has(code)) {
    throw new Error("رفض أمر كتابة على جهاز البصمة");
  }
  return code;
}

/**
 * ZK packs a wall-clock into a Date using the host's local calendar fields.
 * Those fields are the terminal's wall time, which we then place in Asia/Hebron.
 * @param {Date|string|number} value
 * @returns {string|null} YYYY-MM-DD HH:MM:SS
 */
export function wallClockFromZkValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    const hh = String(value.getHours()).padStart(2, "0");
    const mm = String(value.getMinutes()).padStart(2, "0");
    const ss = String(value.getSeconds()).padStart(2, "0");
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
  }
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  return `${match[1]} ${match[2]}:${match[3]}:${match[4] || "00"}`;
}

export function normalizeWallClock(value) {
  return wallClockFromZkValue(value);
}

/** @param {string} wall */
export function hebronWallToUtcMs(wall) {
  const normalized = normalizeWallClock(wall);
  if (!normalized) return NaN;
  const [date, time] = normalized.split(" ");
  const [hour, minute, second] = time.split(":").map(Number);
  return shopLocalToUtcMs(date, hour, minute, second);
}

function textFromReply(reply) {
  if (!reply) return null;
  const buf = Buffer.isBuffer(reply) ? reply : Buffer.from(String(reply));
  const printable = buf.length > 0 && buf[0] >= 32 && buf[0] < 127;
  const slice = !printable && buf.length > 8 ? buf.subarray(8) : buf;
  const text = slice.toString("utf8").replace(/\0/g, "").trim();
  return text || null;
}

/**
 * ZK comm-key handshake (connect/auth only).
 * @param {number} key
 * @param {number} sessionId
 * @param {number} [ticks]
 */
export function makeCommKey(key, sessionId, ticks = 50) {
  let k = 0n;
  const numeric = BigInt(Number(key) >>> 0);
  for (let i = 0n; i < 32n; i += 1n) {
    if (numeric & (1n << i)) k = (k << 1n) | 1n;
    else k <<= 1n;
  }
  k = (k + BigInt(Number(sessionId) >>> 0)) & 0xffffffffn;
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(Number(k));
  buf[0] ^= 90;
  buf[1] ^= 75;
  buf[2] ^= 83;
  buf[3] ^= 79;
  return (buf.readUInt32LE(0) ^ (Number(ticks) >>> 0)) >>> 0;
}

function userIdOf(row) {
  const raw = row?.deviceUserId ?? row?.userId ?? row?.uid ?? "";
  const text = String(raw).trim();
  return text || null;
}

function userNameOf(row) {
  const name = row?.name ?? row?.displayName ?? "";
  return String(name).replace(/\0/g, "").trim();
}

/**
 * @param {object} zk node-zklib instance or a test double with the same read methods
 * @param {{ commKey?: number, includeDirectory?: boolean }} [options]
 * includeDirectory downloads the user list and attendance log. Device info reads
 * skip that download.
 */
export async function readSnapshotFromDevice(zk, options = {}) {
  await zk.createSocket();
  const commKey = Number(options.commKey) || 0;
  const includeDirectory = options.includeDirectory !== false;
  if (commKey > 0 && zk.zklibTcp?.executeCmd) {
    const sessionId = Number(zk.zklibTcp.sessionId) || 0;
    const token = makeCommKey(commKey, sessionId, 50);
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(token);
    assertReadOnlyCommand(READ_ONLY_COMMANDS.AUTH);
    await zk.zklibTcp.executeCmd(READ_ONLY_COMMANDS.AUTH, payload);
  }

  let firmware = null;
  let deviceTime = null;
  if (zk.zklibTcp?.executeCmd) {
    try {
      assertReadOnlyCommand(READ_ONLY_COMMANDS.GET_VERSION);
      firmware = textFromReply(await zk.zklibTcp.executeCmd(READ_ONLY_COMMANDS.GET_VERSION, ""));
    } catch {
      firmware = null;
    }
    try {
      assertReadOnlyCommand(READ_ONLY_COMMANDS.GET_TIME);
      deviceTime = textFromReply(await zk.zklibTcp.executeCmd(READ_ONLY_COMMANDS.GET_TIME, ""));
    } catch {
      deviceTime = null;
    }
  }

  const info = (await zk.getInfo()) || {};
  const usersReply = includeDirectory ? await zk.getUsers() : { data: [] };
  const logsReply = includeDirectory ? await zk.getAttendances() : { data: [] };
  const users = (usersReply?.data || [])
    .map((row) => ({
      deviceUserId: userIdOf(row),
      name: userNameOf(row),
    }))
    .filter((row) => row.deviceUserId);
  const records = [];
  for (const row of logsReply?.data || []) {
    const deviceUserId = userIdOf(row);
    const wallClock = wallClockFromZkValue(row.recordTime ?? row.timestamp ?? row.wallClock);
    if (!deviceUserId || !wallClock) continue;
    records.push({
      deviceUserId,
      wallClock,
      rawStatus: row.state ?? row.status ?? null,
      rawPunch: row.punch ?? row.verify ?? null,
      rawRecordId: row.userSn != null ? String(row.userSn) : row.recordId != null ? String(row.recordId) : null,
    });
  }
  return {
    firmware,
    deviceTime,
    info: {
      userCounts: info.userCounts ?? null,
      logCounts: info.logCounts ?? null,
    },
    users,
    records,
  };
}

async function defaultZkFactory(config) {
  const require = createRequire(import.meta.url);
  const ZKLib = require("node-zklib");
  return new ZKLib(config.host, config.port, config.timeoutMs, 4000);
}

/**
 * Open a short read session. The returned object exposes no write methods.
 * @param {ReturnType<import("./config.js").zktecoConfig>} config
 * @param {(config: object) => Promise<object>} [factory]
 */
export async function readDeviceSnapshot(config, factory = defaultZkFactory) {
  if (!config?.host) throw new Error("عنوان جهاز البصمة غير مضبوط");
  const zk = await factory(config);
  try {
    return await readSnapshotFromDevice(zk, {
      commKey: config.commKey,
      includeDirectory: config.includeDirectory !== false,
    });
  } finally {
    try {
      await zk.disconnect();
    } catch {
      /* protocol cleanup */
    }
  }
}
