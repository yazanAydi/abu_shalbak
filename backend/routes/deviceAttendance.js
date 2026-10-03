import { requireAuth, requireReportsPermission } from "../middleware/auth.js";
import { createSafeRouter } from "../utils/asyncHandler.js";
import { badRequest } from "../utils/httpError.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { zktecoConfig } from "../services/zkteco/config.js";
import { getPayrollAttendanceCutover, setPayrollAttendanceCutover } from "../services/payrollCutover.js";
import {
  addManualPunch,
  clearDeviceMapping,
  listAttendanceTrackablePeople,
  saveDeviceMapping,
  voidInterpretedPunch,
} from "../services/attendanceDeviceImport.js";
import { buildPayableAttendance } from "../services/payableAttendance.js";
import { getDeviceAttendanceStatus, syncZkteco } from "../services/zktecoSync.js";

async function deviceDirectory(db, deviceKey) {
  const users = await db.all(
    `SELECT device_user_id, display_name, last_seen_at
     FROM attendance_device_users WHERE device_key = ?
     ORDER BY CAST(device_user_id AS INTEGER), device_user_id`,
    [deviceKey]
  );
  const mappings = await db.all(
    `SELECT m.device_user_id, m.employee_id, e.name AS employee_name
     FROM employee_device_mappings m
     JOIN employees e ON e.id = m.employee_id
     WHERE m.device_key = ? AND m.active = 1`,
    [deviceKey]
  );
  const byUser = new Map(mappings.map((row) => [row.device_user_id, row]));
  const lastPunches = await db.all(
    `SELECT device_user_id, MAX(punched_at) AS last_punch_at
     FROM attendance_device_events WHERE device_key = ?
     GROUP BY device_user_id`,
    [deviceKey]
  );
  const punchByUser = new Map(lastPunches.map((row) => [row.device_user_id, row.last_punch_at]));
  const known = new Set(users.map((row) => row.device_user_id));
  const rows = users.map((row) => {
    const link = byUser.get(row.device_user_id);
    return {
      device_user_id: row.device_user_id,
      display_name: row.display_name || "",
      employee_id: link?.employee_id ?? null,
      employee_name: link?.employee_name || null,
      mapped: Boolean(link),
      last_punch_at: punchByUser.get(row.device_user_id) || null,
    };
  });
  for (const link of mappings) {
    if (known.has(link.device_user_id)) continue;
    rows.push({
      device_user_id: link.device_user_id,
      display_name: "",
      employee_id: link.employee_id,
      employee_name: link.employee_name,
      mapped: true,
      last_punch_at: punchByUser.get(link.device_user_id) || null,
    });
  }
  return rows;
}

export function createDeviceAttendanceRouter(db) {
  const router = createSafeRouter();
  const requirePayroll = requireReportsPermission(db, "employee_payroll");

  router.get("/status", requireAuth, requirePayroll, async (_req, res) => {
    const cfg = zktecoConfig();
    const status = await getDeviceAttendanceStatus(db, cfg.deviceKey);
    res.json({
      ...status,
      enabled: cfg.enabled,
      host: cfg.host || null,
      port: cfg.port,
      users: await deviceDirectory(db, cfg.deviceKey),
      trackable_employees: await listAttendanceTrackablePeople(db),
    });
  });

  router.put("/cutover", requireAuth, requirePayroll, async (req, res) => {
    const before = await getPayrollAttendanceCutover(db);
    const cutover = await setPayrollAttendanceCutover(db, req.body?.cutover ?? req.body?.payroll_attendance_cutover_ymd);
    await logAudit(db, req, AUDIT_ACTIONS.ATTENDANCE_CUTOVER, "app_settings", null, { cutover: before }, { cutover });
    res.json({ cutover });
  });

  router.put("/mappings", requireAuth, requirePayroll, async (req, res) => {
    const cfg = zktecoConfig();
    const deviceKey = cfg.deviceKey;
    const linkingUser = req.body?.user_id != null && req.body.user_id !== "";
    const clearing =
      req.body?.active === false ||
      ((req.body?.employee_id == null || req.body?.employee_id === "") && !linkingUser);
    if (clearing) {
      const row = await clearDeviceMapping(
        db,
        { deviceKey, deviceUserId: req.body?.device_user_id },
        req
      );
      res.json(row);
      return;
    }
    const row = await saveDeviceMapping(
      db,
      {
        deviceKey,
        deviceUserId: req.body?.device_user_id,
        employeeId: req.body?.employee_id,
        linkUserId: req.body?.user_id,
        userId: req.user?.id,
      },
      req
    );
    res.status(201).json(row);
  });

  router.post("/sync", requireAuth, requirePayroll, async (_req, res) => {
    const result = await syncZkteco(db);
    res.json(result);
  });

  router.get("/employees/:id", requireAuth, requirePayroll, async (req, res) => {
    const from = String(req.query.from || req.query.period_from || "").trim();
    const to = String(req.query.to || req.query.period_to || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw badRequest("حدد بداية الفترة ونهايتها");
    }
    const attendance = await buildPayableAttendance(db, Number(req.params.id), { from, to });
    const punches = await db.all(
      `SELECT id, punched_at, punch_type, source, status, correction_note, void_reason, hourly_rate_snapshot
       FROM attendance_interpreted_punches
       WHERE employee_id = ?
       ORDER BY datetime(punched_at) ASC, id ASC`,
      [Number(req.params.id)]
    );
    res.json({ ...attendance, punches });
  });

  router.post("/punches", requireAuth, requirePayroll, async (req, res) => {
    const punch = await addManualPunch(
      db,
      {
        employeeId: req.body?.employee_id,
        punchType: req.body?.punch_type,
        punchedAt: req.body?.punched_at,
        note: req.body?.note,
        userId: req.user?.id,
      },
      req
    );
    res.status(201).json(punch);
  });

  router.post("/punches/:id/void", requireAuth, requirePayroll, async (req, res) => {
    const punch = await voidInterpretedPunch(db, req.params.id, { reason: req.body?.reason, userId: req.user?.id }, req);
    res.json(punch);
  });

  return router;
}
