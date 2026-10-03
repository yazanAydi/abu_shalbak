import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runZktecoProbe, parseProbeArgs } from "../scripts/zkteco-probe.mjs";
import { readDeviceSnapshot } from "../services/zkteco/readOnlyAdapter.js";

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../scripts/zkteco-probe.mjs");

function fakeZk() {
  const calls = [];
  return {
    calls,
    zk: {
      async createSocket() {
        calls.push("createSocket");
      },
      async getInfo() {
        calls.push("getInfo");
        return { userCounts: 2, logCounts: 4, logCapacity: 1000 };
      },
      async getUsers() {
        calls.push("getUsers");
        return {
          data: [
            { userId: "1", name: "Obaid Abu Shalbak", password: "secret-template" },
            { userId: "2", name: "Mohammad Abu Shalbak" },
          ],
        };
      },
      async getAttendances() {
        calls.push("getAttendances");
        return {
          data: [
            { deviceUserId: "1", userSn: 1, recordTime: new Date(2026, 9, 3, 16, 31, 4) },
            { deviceUserId: "1", userSn: 2, recordTime: new Date(2026, 9, 3, 16, 31, 7) },
          ],
        };
      },
      async disconnect() {
        calls.push("disconnect");
      },
      async clearAttendanceLog() {
        calls.push("clearAttendanceLog");
      },
      async disableDevice() {
        calls.push("disableDevice");
      },
      async setUser() {
        calls.push("setUser");
      },
      zklibTcp: {
        sessionId: 1,
        async executeCmd(command) {
          calls.push(`cmd:${command}`);
          if (command !== 1100 && command !== 201 && command !== 1102) {
            throw new Error(`blocked command ${command}`);
          }
          return Buffer.from("Ver 6.60 Sep 19 2019");
        },
      },
    },
  };
}

describe("zkteco probe", () => {
  test("defaults the comm key to 0 and keeps the basic read off the user and attendance logs", async () => {
    expect(parseProbeArgs(["--host", "10.0.0.8", "--port", "4370"])).toMatchObject({
      host: "10.0.0.8",
      port: 4370,
      commKey: 0,
      info: false,
    });
    const { calls, zk } = fakeZk();
    const lines = [];
    const code = await runZktecoProbe(["--host", "10.0.0.8", "--port", "4370"], {
      readSnapshot: (config) => readDeviceSnapshot(config, async () => zk),
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(calls).toEqual(["createSocket", "cmd:1100", "cmd:201", "getInfo", "disconnect"]);
    expect(lines.join("\n")).toContain("OK");
    expect(lines.join("\n")).toContain("Ver 6.60 Sep 19 2019");
    expect(lines.join("\n")).not.toContain("secret-template");
    expect(lines.join("\n")).not.toContain("Obaid");
  });

  test("--info lists device users and the attendance count without templates", async () => {
    const { calls, zk } = fakeZk();
    const lines = [];
    const code = await runZktecoProbe(["--host", "10.0.0.8", "--port", "4370", "--comm-key", "0", "--info"], {
      readSnapshot: (config) => readDeviceSnapshot(config, async () => zk),
      stdout: (line) => lines.push(line),
    });
    const text = lines.join("\n");
    expect(code).toBe(0);
    expect(calls).toContain("getUsers");
    expect(calls).toContain("getAttendances");
    expect(calls).not.toContain("clearAttendanceLog");
    expect(calls).not.toContain("disableDevice");
    expect(calls).not.toContain("setUser");
    expect(text).toContain("1\tObaid Abu Shalbak");
    expect(text).toContain("2\tMohammad Abu Shalbak");
    expect(text).toContain("attendance records: 2");
    expect(text).not.toMatch(/template|password|secret/i);
  });

  test("the script source does not open a database or name a write operation", () => {
    const src = fs.readFileSync(scriptPath, "utf8");
    expect(src).not.toMatch(
      /clearAttendanceLog|disableDevice|enableDevice|setUser|deleteUser|initDatabase|sqlite|DATABASE_PATH|dotenv/
    );
    expect(src).toContain("readDeviceSnapshot");
  });
});
