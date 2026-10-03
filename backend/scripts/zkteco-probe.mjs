/**
 * Read-only ZKTeco probe. Talks to the terminal through the production reader
 * and exits. It does not open a database and does not send write commands.
 *
 *   node scripts/zkteco-probe.mjs --host 100.100.100.201 --port 4370
 *   node scripts/zkteco-probe.mjs --host 100.100.100.201 --port 4370 --info
 */
import { pathToFileURL } from "node:url";
import { readDeviceSnapshot } from "../services/zkteco/readOnlyAdapter.js";

export function parseProbeArgs(argv) {
  const args = { host: "", port: 4370, commKey: 0, info: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--info") args.info = true;
    else if (token === "--host") args.host = String(argv[++i] ?? "").trim();
    else if (token === "--port") args.port = Number(argv[++i]);
    else if (token === "--comm-key") args.commKey = Number(argv[++i] ?? 0);
    else throw new Error(`unknown argument: ${token}`);
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error("port must be an integer from 1 to 65535");
  }
  if (!Number.isInteger(args.commKey) || args.commKey < 0) {
    throw new Error("comm key must be a non-negative integer");
  }
  return args;
}

export function formatProbeReport(snapshot, { info }) {
  const lines = [
    "OK",
    `firmware: ${snapshot?.firmware || "(unavailable)"}`,
    `userCounts: ${snapshot?.info?.userCounts ?? "(unavailable)"}`,
    `logCounts: ${snapshot?.info?.logCounts ?? "(unavailable)"}`,
    `logCapacity: ${snapshot?.info?.logCapacity ?? "(unavailable)"}`,
  ];
  if (info) {
    lines.push("users:");
    for (const user of snapshot?.users || []) {
      lines.push(`${user.deviceUserId}\t${user.name || ""}`);
    }
    lines.push(`attendance records: ${(snapshot?.records || []).length}`);
  }
  return lines.join("\n");
}

/**
 * @param {string[]} argv
 * @param {{ readSnapshot?: typeof readDeviceSnapshot, stdout?: Function, stderr?: Function }} [io]
 * @returns {Promise<number>} process exit code
 */
export async function runZktecoProbe(argv, io = {}) {
  const stdout = io.stdout || console.log;
  const stderr = io.stderr || console.error;
  const readSnapshot = io.readSnapshot || readDeviceSnapshot;
  let args;
  try {
    args = parseProbeArgs(argv);
  } catch (error) {
    stderr(`FAILED\n${error.message}`);
    return 1;
  }
  if (args.help || !args.host) {
    stderr(
      "usage: node scripts/zkteco-probe.mjs --host <ip> --port <port> [--comm-key <n>] [--info]"
    );
    return args.help ? 0 : 1;
  }
  try {
    const snapshot = await readSnapshot({
      host: args.host,
      port: args.port,
      commKey: args.commKey,
      timeoutMs: 20000,
      includeDirectory: args.info,
    });
    stdout(formatProbeReport(snapshot, { info: args.info }));
    return 0;
  } catch (error) {
    stderr(`FAILED\n${error?.message || error}`);
    return 1;
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (invokedDirectly()) {
  runZktecoProbe(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
