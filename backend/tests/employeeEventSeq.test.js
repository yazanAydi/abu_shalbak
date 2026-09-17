import { compareEmployeeEvents, sortEmployeeEvents, EVENT_KIND_RANK } from "../services/employeeEventSeq.js";

describe("employee event sequencing", () => {
  test("same-day allocate → reverse → reallocate follows event_seq, not kind_rank", () => {
    const allocate1 = {
      event_date: "2026-08-31",
      event_seq: 1,
      kind: "apply_salary",
      kind_rank: EVENT_KIND_RANK.apply_salary,
    };
    const reverse = {
      event_date: "2026-08-31",
      event_seq: 2,
      kind: "allocation_reversal",
      kind_rank: EVENT_KIND_RANK.allocation_reversal,
    };
    const allocate2 = {
      event_date: "2026-08-31",
      event_seq: 3,
      kind: "apply_salary",
      kind_rank: EVENT_KIND_RANK.apply_salary,
    };
    const byRank = [allocate1, reverse, allocate2].sort((a, b) => a.kind_rank - b.kind_rank || a.event_seq - b.event_seq);
    expect(byRank.map((e) => e.event_seq)).toEqual([1, 3, 2]);

    expect(sortEmployeeEvents([allocate2, reverse, allocate1]).map((e) => e.event_seq)).toEqual([1, 2, 3]);
    expect(compareEmployeeEvents(allocate1, reverse)).toBeLessThan(0);
    expect(compareEmployeeEvents(reverse, allocate2)).toBeLessThan(0);
  });

  test("earlier calendar date sorts before a later date even with a higher seq", () => {
    const later = { event_date: "2026-09-01", event_seq: 1 };
    const earlier = { event_date: "2026-08-15", event_seq: 2 };
    expect(compareEmployeeEvents(earlier, later)).toBeLessThan(0);
  });
});
