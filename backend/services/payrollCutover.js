import { badRequest } from "../utils/httpError.js";

const KEY = "payroll_attendance_cutover_ymd";
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export async function getPayrollAttendanceCutover(db) {
  const row = await db.get("SELECT value FROM app_settings WHERE key = ?", [KEY]);
  const value = String(row?.value || "").trim();
  return YMD.test(value) ? value : null;
}

/**
 * @param {object} db
 * @param {string|null} ymd empty clears the cutover
 */
export async function setPayrollAttendanceCutover(db, ymd) {
  const value = ymd == null ? "" : String(ymd).trim();
  if (!value) {
    await db.run("DELETE FROM app_settings WHERE key = ?", [KEY]);
    return null;
  }
  if (!YMD.test(value)) {
    throw badRequest("تاريخ اعتماد الحضور يجب أن يكون بصيغة YYYY-MM-DD");
  }
  await db.run(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [KEY, value]
  );
  return value;
}
