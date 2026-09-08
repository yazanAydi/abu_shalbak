import { readWaitingRequestId, writeWaitingRequestId } from "./posWaitingRequests";

describe("posWaitingRequests", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  test("round-trips a waiting id and clears it", () => {
    expect(readWaitingRequestId("onAccount")).toBeNull();
    writeWaitingRequestId("onAccount", 42);
    expect(readWaitingRequestId("onAccount")).toBe(42);
    writeWaitingRequestId("onAccount", null);
    expect(readWaitingRequestId("onAccount")).toBeNull();
  });

  test("ignores invalid stored values", () => {
    sessionStorage.setItem("pos.waiting.advanceId", "nope");
    expect(readWaitingRequestId("advance")).toBeNull();
  });
});
