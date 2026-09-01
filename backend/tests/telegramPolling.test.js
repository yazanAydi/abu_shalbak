import { jest } from "@jest/globals";
import { startTelegramBotPollLoops } from "../services/telegramPolling.js";

describe("Telegram poll loops", () => {
  test("bots receive overlapping getUpdates calls", async () => {
    let resolveA;
    let resolveB;
    const started = [];
    const get = (method, _query, token) => {
      if (method !== "getUpdates") {
        return Promise.resolve([]);
      }
      started.push({ token, at: Date.now() });
      if (token === "token-a") {
        return new Promise((resolve) => {
          resolveA = () => resolve([]);
        });
      }
      if (token === "token-b") {
        return new Promise((resolve) => {
          resolveB = () => resolve([]);
        });
      }
      return Promise.resolve([]);
    };

    const stop = startTelegramBotPollLoops(
      {},
      [
        { kind: "refund", token: "token-a" },
        { kind: "zimma", token: "token-b" },
      ],
      { get, pollTimeoutSec: 1, errorRetryMs: 10 }
    );

    await new Promise((r) => setTimeout(r, 30));

    expect(started.map((s) => s.token).sort()).toEqual(["token-a", "token-b"]);
    expect(Math.abs(started[0].at - started[1].at)).toBeLessThan(30);
    expect(typeof resolveA).toBe("function");
    expect(typeof resolveB).toBe("function");

    stop();
    resolveA();
    resolveB();
  });

  test("error in one bot does not prevent the other from polling", async () => {
    let aCalls = 0;
    let bCalls = 0;
    let resolveB;
    const get = (method, _query, token) => {
      if (method !== "getUpdates") return Promise.resolve([]);
      if (token === "token-a") {
        aCalls += 1;
        return Promise.reject(new Error("refund down"));
      }
      bCalls += 1;
      return new Promise((resolve) => {
        resolveB = () => resolve([]);
      });
    };

    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const stop = startTelegramBotPollLoops(
      {},
      [
        { kind: "refund", token: "token-a" },
        { kind: "sulaf", token: "token-b" },
      ],
      { get, pollTimeoutSec: 1, errorRetryMs: 50 }
    );

    await new Promise((r) => setTimeout(r, 30));

    expect(bCalls).toBeGreaterThanOrEqual(1);
    expect(typeof resolveB).toBe("function");

    stop();
    resolveB?.();
    errSpy.mockRestore();
    expect(aCalls).toBeGreaterThanOrEqual(1);
  });
});
