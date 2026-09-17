import { estimatedCashierPay, estimatedShiftPay, payableHoursOf } from "./payrollHelpers";

const live = 20;

function shift(partial) {
  return {
    start_time: "2026-09-01T07:00:00.000Z",
    end_time: "2026-09-01T15:00:00.000Z",
    status: "closed",
    hours: 8,
    hourly_rate: 20,
    flags: [],
    ...partial,
  };
}

describe("estimatedCashierPay", () => {
  test("sums ended shifts with a snapshot even when the period is not final", () => {
    const hours = {
      posted_pay: 160,
      shifts: [
        shift({ hours: 8, hourly_rate: 20 }),
        shift({ status: "pending_count", hours: 8, hourly_rate: 20, flags: ["pending_count"] }),
        shift({ status: "open", end_time: null, hours: 0, hourly_rate: 20, flags: ["open"] }),
      ],
    };
    expect(estimatedCashierPay(hours)).toBe(320);
    expect(payableHoursOf(hours)).toBe(16);
  });

  test("uses live rate when a closed shift has no snapshot", () => {
    const hours = {
      posted_pay: 0,
      live_hourly_rate: live,
      shifts: [shift({ hourly_rate: null, flags: ["missing_snapshot"], hours: 8 })],
    };
    expect(estimatedCashierPay(hours)).toBe(160);
    expect(estimatedShiftPay(hours.shifts[0], live)).toBe(160);
  });

  test("returns null when nothing can be priced", () => {
    expect(
      estimatedCashierPay({
        posted_pay: 0,
        shifts: [shift({ status: "open", end_time: null, hours: 0, flags: ["open"] })],
      })
    ).toBeNull();
  });
});
