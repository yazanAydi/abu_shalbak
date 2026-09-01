import {
  ROW_SAVE,
  applySuccessfulPatch,
  errorLabel,
  revertRow,
  rowSaveMessage,
  savedLabel,
  savingLabel,
} from "./rowSaveState";

describe("rowSaveState", () => {
  const rows = [
    { id: 1, name: "مرتديلا", unit: "كغم", category: "ألبان" },
    { id: 2, name: "جبنة", unit: "حبة", category: "ألبان" },
  ];

  test("applySuccessfulPatch updates only the affected row", () => {
    const next = applySuccessfulPatch(rows, 1, { category: "لحوم", unit: "كغم" });
    expect(next[0]).toEqual({ id: 1, name: "مرتديلا", unit: "كغم", category: "لحوم" });
    expect(next[1]).toEqual(rows[1]);
    expect(rows[0].category).toBe("ألبان");
  });

  test("revertRow restores the previous field value", () => {
    const optimistic = applySuccessfulPatch(rows, 2, { unit: "كغم" });
    expect(optimistic[1].unit).toBe("كغم");
    const reverted = revertRow(optimistic, 2, { unit: "حبة" });
    expect(reverted[1].unit).toBe("حبة");
    expect(reverted[1].category).toBe("ألبان");
  });

  test("Arabic save-state labels", () => {
    expect(savingLabel()).toBe("جاري الحفظ...");
    expect(savedLabel()).toBe("تم الحفظ");
    expect(errorLabel()).toBe("تعذر حفظ التغيير");
    expect(rowSaveMessage({ status: ROW_SAVE.SAVING })).toBe("جاري الحفظ...");
    expect(rowSaveMessage({ status: ROW_SAVE.SAVED })).toBe("تم الحفظ");
    expect(rowSaveMessage({ status: ROW_SAVE.ERROR })).toBe("تعذر حفظ التغيير");
    expect(rowSaveMessage({ status: ROW_SAVE.ERROR, message: "تعذر الحفظ" })).toBe("تعذر الحفظ");
  });
});
