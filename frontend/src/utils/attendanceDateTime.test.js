import { attendanceDurationHours, attendanceInstantFromFields, fieldsFromStoredInstant, normalizeDateText, normalizeTimeText, resolveHebronWall } from "./attendanceDateTime";

describe("attendance date and time entry", () => {
  test("normalizes 0830 and 1630 and reports 8 hours", () => {
    expect(normalizeTimeText("0830")).toMatchObject({ value: "08:30" });
    expect(normalizeTimeText("1630")).toMatchObject({ value: "16:30" });
    const start = attendanceInstantFromFields({ ymd: "2026-09-24", time: "0830" });
    const end = attendanceInstantFromFields({ ymd: "2026-09-24", time: "1630" });
    expect(attendanceDurationHours(start.ms, end.ms)).toBe(8);
    expect(start.sql).toBe("2026-09-24 08:30:00");
  });

  test("normalizes Arabic digits without shifting a valid time", () => {
    expect(normalizeTimeText("٠٨٣٠")).toMatchObject({ value: "08:30" });
    expect(normalizeDateText("٢٤/٠٩/٢٠٢٦")).toMatchObject({ iso: "2026-09-24", value: "24/09/2026" });
  });

  test("rejects impossible times instead of rolling them over", () => {
    expect(normalizeTimeText("25:00").error).toMatch(/غير صالح/);
    expect(normalizeTimeText("08:60").error).toMatch(/غير صالح/);
    expect(normalizeTimeText("0860").error).toMatch(/غير صالح/);
    expect(normalizeDateText("31/02/2026").error).toMatch(/غير صالح/);
  });

  test("overnight attendance uses the entered departure date", () => {
    const start = attendanceInstantFromFields({ ymd: "2026-09-24", time: "22:00" });
    const end = attendanceInstantFromFields({ ymd: "2026-09-25", time: "06:00" });
    expect(attendanceDurationHours(start.ms, end.ms)).toBe(8);
    const sameDay = attendanceInstantFromFields({ ymd: "2026-09-24", time: "06:00" });
    expect(sameDay.ms).toBeLessThan(start.ms);
  });

  test("a missing daylight-saving hour is rejected", () => {
    expect(resolveHebronWall("2026-03-28", 2, 30).status).toBe("missing");
    const instant = attendanceInstantFromFields({ ymd: "2026-03-28", time: "02:30" });
    expect(instant.error).toMatch(/التوقيت الصيفي/);
    expect(instant.sql).toBeUndefined();
  });

  test("an ambiguous daylight-saving hour requires an explicit choice", () => {
    const resolved = resolveHebronWall("2026-10-24", 1, 30);
    expect(resolved.status).toBe("ambiguous");
    expect(resolved.options).toHaveLength(2);
    const pending = attendanceInstantFromFields({ ymd: "2026-10-24", time: "01:30" });
    expect(pending.ambiguous).toHaveLength(2);
    const chosen = attendanceInstantFromFields({
      ymd: "2026-10-24",
      time: "01:30",
      pinMs: resolved.options[1].ms,
    });
    expect(chosen.ms).toBe(resolved.options[1].ms);
    expect(chosen.sql.endsWith("Z")).toBe(true);
  });

  test("editing a stored instant keeps the same Hebron timestamp", () => {
    const original = attendanceInstantFromFields({ ymd: "2026-09-24", time: "08:30" });
    const storedUtc = new Date(original.ms).toISOString().replace("T", " ").slice(0, 19);
    const loaded = fieldsFromStoredInstant(storedUtc);
    expect(loaded).toMatchObject({ ymd: "2026-09-24", time: "08:30" });
    const again = attendanceInstantFromFields({ ymd: loaded.ymd, time: loaded.time, pinMs: loaded.pinMs });
    expect(again.ms).toBe(original.ms);

    const ambiguous = resolveHebronWall("2026-10-24", 1, 30);
    const later = ambiguous.options[1].ms;
    const stored = new Date(later).toISOString().replace("T", " ").replace(".000Z", "");
    const loadedLater = fieldsFromStoredInstant(stored);
    expect(loadedLater.time).toBe("01:30");
    expect(loadedLater.pinMs).toBe(later);
    const roundTrip = attendanceInstantFromFields({
      ymd: loadedLater.ymd,
      time: loadedLater.time,
      pinMs: loadedLater.pinMs,
    });
    expect(roundTrip.ms).toBe(later);
  });

  test("Hebron wall time does not follow the machine timezone", () => {
    const instant = attendanceInstantFromFields({ ymd: "2026-09-24", time: "08:30" });
    expect(new Date(instant.ms).toISOString()).toBe("2026-09-24T05:30:00.000Z");
  });
});
