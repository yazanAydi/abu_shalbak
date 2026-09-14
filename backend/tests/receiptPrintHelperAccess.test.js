import { CASHIER_PRINT_HELPER_VERSION } from "../utils/cashierPrintHelperVersion.js";
import {
  decideReceiptPrintAccess,
  isReceiptPrintOriginAllowed,
  originFromPosUrl,
  parseReceiptPrintAllowedOrigins,
  receiptPrintCorsHeaders,
} from "../utils/receiptPrintHelperAccess.js";

const POS = "http://192.168.1.10:3000";
const allowed = [POS];

describe("receiptPrintHelperAccess", () => {
  test("helper version is a non-empty stamp", () => {
    expect(CASHIER_PRINT_HELPER_VERSION).toMatch(/^\d{8}-/);
  });

  test("derives allowed origin from a POS URL", () => {
    expect(originFromPosUrl("http://192.168.1.10:3000/pos")).toBe("http://192.168.1.10:3000");
    expect(originFromPosUrl("http://192.168.1.10:3000")).toBe("http://192.168.1.10:3000");
    expect(originFromPosUrl("not-a-url")).toBe("");
  });

  test("parses exact origins and ignores path", () => {
    expect(
      parseReceiptPrintAllowedOrigins({
        RECEIPT_PRINT_ALLOWED_ORIGINS: "http://192.168.1.10:3000/pos, https://shop.example",
      })
    ).toEqual(["http://192.168.1.10:3000", "https://shop.example"]);
  });

  test("rejects missing or unknown Origin for print", () => {
    expect(isReceiptPrintOriginAllowed("", allowed)).toBe(false);
    expect(isReceiptPrintOriginAllowed("http://evil.example", allowed)).toBe(false);
    expect(isReceiptPrintOriginAllowed(POS, allowed)).toBe(true);
    expect(receiptPrintCorsHeaders("http://evil.example", allowed)).toEqual({});
    expect(receiptPrintCorsHeaders(POS, allowed)["Access-Control-Allow-Origin"]).toBe(POS);
  });

  test("health without Origin is allowed on loopback", () => {
    expect(
      decideReceiptPrintAccess({ method: "GET", path: "/health", origin: "", loopback: true }, allowed)
    ).toMatchObject({ ok: true, status: 200, cors: false });
  });

  test("health with unknown Origin is denied", () => {
    expect(
      decideReceiptPrintAccess(
        { method: "GET", path: "/health", origin: "http://evil.example", loopback: true },
        allowed
      )
    ).toMatchObject({ ok: false, status: 403, code: "ORIGIN_DENIED" });
  });

  test("print requires an allowed Origin", () => {
    expect(
      decideReceiptPrintAccess({ method: "POST", path: "/print", origin: "", loopback: true }, allowed)
    ).toMatchObject({ ok: false, status: 403, code: "ORIGIN_DENIED" });
    expect(
      decideReceiptPrintAccess({ method: "POST", path: "/print", origin: POS, loopback: true }, allowed)
    ).toMatchObject({ ok: true, cors: true });
  });

  test("non-loopback is forbidden", () => {
    expect(
      decideReceiptPrintAccess({ method: "POST", path: "/print", origin: POS, loopback: false }, allowed)
    ).toMatchObject({ ok: false, status: 403, code: "FORBIDDEN" });
  });

  test("preflight echoes only an allowed Origin", () => {
    expect(
      decideReceiptPrintAccess({ method: "OPTIONS", path: "/print", origin: POS, loopback: true }, allowed)
    ).toMatchObject({ ok: true, status: 204, cors: true });
    expect(
      decideReceiptPrintAccess(
        { method: "OPTIONS", path: "/print", origin: "http://evil.example", loopback: true },
        allowed
      )
    ).toMatchObject({ ok: false, status: 403, code: "ORIGIN_DENIED" });
  });

  test("arm and disarm are gone", () => {
    expect(
      decideReceiptPrintAccess({ method: "POST", path: "/arm", origin: POS, loopback: true }, allowed)
    ).toMatchObject({ ok: false, status: 410, code: "GONE" });
  });
});
