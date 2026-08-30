import { evaluateThresholds, unexpected4xx } from "../../scripts/loadtest/report.mjs";
import { profileExpectations } from "../../scripts/loadtest/profiles.mjs";

function agg(overrides = {}) {
  return {
    total: 10,
    successful: 10,
    failed: 0,
    http4xx: 0,
    http5xx: 0,
    timeouts: 0,
    byCode: { 200: 10 },
    latency: { p50: 10, p95: 12, p99: 15, max: 20 },
    ops: {
      checkout_cash: {
        n: 5,
        success: 5,
        failed: 0,
        p50: 20,
        p95: 30,
        p99: 40,
        max: 50,
        queries_avg: 22,
      },
    },
    ...overrides,
  };
}

describe("fail-closed load-test gates", () => {
  test("mixed/pos profiles expect checkouts and receipts; office/admin do not", () => {
    expect(profileExpectations("mixed")).toEqual({
      expectCheckouts: true,
      expectReceipts: true,
      hasPos: true,
    });
    expect(profileExpectations("pos").expectReceipts).toBe(true);
    expect(profileExpectations("office").expectCheckouts).toBe(false);
    expect(profileExpectations("office").expectReceipts).toBe(false);
    expect(profileExpectations("admin").expectReceipts).toBe(false);
  });

  test("100% INVALID_TOKEN is a failure even with 0 5xx", () => {
    const broken = agg({
      total: 180,
      successful: 0,
      failed: 180,
      http4xx: 180,
      byCode: { INVALID_TOKEN: 180 },
      ops: {
        checkout_cash: {
          n: 26,
          success: 0,
          failed: 26,
          p50: 17,
          p95: 18,
          p99: 19,
          max: 19,
          queries_avg: 0,
        },
      },
    });
    const unexpected = unexpected4xx(broken);
    expect(unexpected).toEqual([["INVALID_TOKEN", 180]]);
    const violations = evaluateThresholds(broken, null, {
      expectCheckouts: true,
      expectReceipts: true,
      receiptTotal: 0,
    });
    expect(violations.some((v) => v.includes("successful=0"))).toBe(true);
    expect(violations.some((v) => v.includes("INVALID_TOKEN"))).toBe(true);
    expect(violations.some((v) => v.includes("unexpected 4xx INVALID_TOKEN"))).toBe(true);
    expect(violations.some((v) => v.includes("receipts.total=0"))).toBe(true);
    expect(violations.some((v) => v.includes("checkout work is empty"))).toBe(true);
  });

  test("office profile does not require checkouts or receipts", () => {
    const office = agg({
      ops: {
        product_list: {
          n: 10,
          success: 10,
          failed: 0,
          p50: 10,
          p95: 12,
          p99: 14,
          max: 15,
          queries_avg: 2,
        },
      },
    });
    const violations = evaluateThresholds(office, null, {
      expectCheckouts: false,
      expectReceipts: false,
      receiptTotal: 0,
    });
    expect(violations).toEqual([]);
  });

  test("healthy mixed run with receipts and checkout q>0 passes gates", () => {
    const violations = evaluateThresholds(agg(), null, {
      expectCheckouts: true,
      expectReceipts: true,
      receiptTotal: 5,
    });
    expect(violations).toEqual([]);
  });
});
