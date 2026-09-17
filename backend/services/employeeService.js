import { ATTENDANCE_ROLES } from "../utils/roles.js";
import { round2 } from "../utils/money.js";
import { withTransaction } from "../utils/dbTx.js";
import { badRequest, notFound, conflict } from "../utils/httpError.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { appendEmployeeEvent, nextEmployeeEventSeq } from "./employeeEventSeq.js";
import { ensureEntityCode } from "../utils/entityCodes.js";
import { getDefaultBalanceGroupId } from "../utils/balanceGroups.js";
import {
  customerHasFinancialHistory,
  employeeDebtAccountInUse,
} from "../utils/employeeCustomer.js";

const COMPENSATION_TYPES = new Set(["monthly", "daily", "hourly"]);
const OPENING_KINDS = new Set(["unpaid_salary", "prepaid_salary"]);

export function parseYmd(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function requireYmd(value, label) {
  const day = parseYmd(value);
  if (!day) throw badRequest(`${label} يجب أن يكون تاريخاً بصيغة YYYY-MM-DD`);
  return day;
}

function requireName(value) {
  const name = String(value || "").trim();
  if (!name) throw badRequest("اسم الموظف مطلوب");
  if (name.length > 120) throw badRequest("اسم الموظف طويل جداً");
  return name;
}

function optionalPhone(value) {
  if (value == null || value === "") return null;
  const phone = String(value).trim();
  return phone ? phone.slice(0, 40) : null;
}

function requirePositiveMoney(value, label = "المبلغ") {
  const amt = round2(Number(value));
  if (!Number.isFinite(amt) || amt <= 0) {
    throw badRequest(`${label} غير صالح`, "VALIDATION_ERROR");
  }
  return amt;
}

function optionalNonNeg(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw badRequest("القيمة يجب أن تكون صفراً أو أكثر");
  return round2(n);
}

function asActiveFlag(value, fallback = 1) {
  if (value === undefined) return fallback;
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;
  return fallback;
}

function assertDateRange(startOn, endOn) {
  if (startOn && endOn && endOn < startOn) {
    throw badRequest("تاريخ الانتهاء يجب أن يكون بعد تاريخ البداية أو مساوياً له");
  }
}

async function getEmployeeRow(db, id) {
  return db.get(
    `SELECT e.*, u.username AS user_username, u.role AS user_role,
            c.name AS customer_name, c.customer_code AS customer_code,
            c.balance AS customer_balance
     FROM employees e
     LEFT JOIN users u ON u.id = e.user_id
     LEFT JOIN customers c ON c.id = e.customer_id
     WHERE e.id = ?`,
    [id]
  );
}

export async function requireEmployee(db, id) {
  const emp = await getEmployeeRow(db, Number(id));
  if (!emp) throw notFound("الموظف غير موجود");
  return emp;
}

async function assertLinkableUser(db, userId, { exceptEmployeeId = null } = {}) {
  if (userId == null) return null;
  const id = Number(userId);
  if (!id) throw badRequest("حساب الربط غير صالح");
  const user = await db.get("SELECT id, username, role FROM users WHERE id = ?", [id]);
  if (!user) throw badRequest("حساب المستخدم غير موجود", "USER_NOT_FOUND");
  if (!ATTENDANCE_ROLES.includes(user.role)) {
    throw badRequest("يُربَط الموظف بحساب كاشير أو مخبز أو رفوف فقط", "USER_NOT_LINKABLE");
  }
  const taken = await db.get(
    "SELECT id FROM employees WHERE user_id = ? AND (? IS NULL OR id != ?)",
    [id, exceptEmployeeId, exceptEmployeeId]
  );
  if (taken) throw conflict("هذا الحساب مربوط بموظف آخر", "USER_ALREADY_LINKED");
  return user;
}

async function assertLinkableCustomer(db, customerId, { exceptEmployeeId = null } = {}) {
  if (customerId == null) return null;
  const id = Number(customerId);
  if (!id) throw badRequest("حساب الذمة غير صالح", "CUSTOMER_REQUIRED");
  const customer = await db.get(
    "SELECT id, name, customer_code, balance FROM customers WHERE id = ?",
    [id]
  );
  if (!customer) throw badRequest("حساب العميل غير موجود", "CUSTOMER_NOT_FOUND");
  const taken = await db.get(
    "SELECT id, name FROM employees WHERE customer_id = ? AND (? IS NULL OR id != ?)",
    [id, exceptEmployeeId, exceptEmployeeId]
  );
  if (taken) {
    throw conflict("حساب الذمة هذا مربوط بموظف آخر — لا يُنسخ الدين", "CUSTOMER_ALREADY_LINKED");
  }
  return customer;
}

async function assertCustomerHasNoFinancialHistory(db, customerId) {
  if (await customerHasFinancialHistory(db, customerId)) {
    throw conflict(
      "لا يمكن ربط حساب عميل له حركات مالية سابقة — أنشئ حساب ذمة جديداً لهذا الموظف",
      "CUSTOMER_HAS_HISTORY"
    );
  }
}

async function assertEmployeeCustomerLinkChange(db, emp, nextCustomerId) {
  const current = emp.customer_id ? Number(emp.customer_id) : null;
  const next = nextCustomerId == null || nextCustomerId === "" ? null : Number(nextCustomerId);
  if (current === next) return;

  if (current != null && current !== next) {
    if (await employeeDebtAccountInUse(db, emp.id, current)) {
      throw conflict(
        "لا يمكن إلغاء أو تغيير حساب ذمة استُخدم مالياً (فواتير، دفعات، مرتجعات، تسويات أو طلبات معلّقة)",
        "EMPLOYEE_DEBT_ACCOUNT_IN_USE"
      );
    }
  }

  if (next != null && next !== current) {
    await assertLinkableCustomer(db, next, { exceptEmployeeId: emp.id });
    await assertCustomerHasNoFinancialHistory(db, next);
  }
}

export function employeeKind(row) {
  return row?.user_id && row?.user_role === "cashier" ? "cashier" : "regular";
}

export function isStaffAttendanceRole(role) {
  return ATTENDANCE_ROLES.includes(String(role));
}

function parseOptionalPositiveId(value, label = "معرّف الموظف") {
  if (value == null || value === "") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest(`${label} غير صالح`, "VALIDATION_ERROR");
  }
  return id;
}

export function parseUserEmployeeLinkBody(body = {}) {
  return {
    employee_id: parseOptionalPositiveId(body.employee_id, "معرّف الموظف"),
    employee_name: body.employee_name != null ? body.employee_name : body.name,
    phone: body.phone,
    start_on: body.start_on,
    end_on: body.end_on,
  };
}

export function mapEmployeeIdentity(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    active: Number(row.active) === 1,
    user_id: row.user_id ?? null,
    user_username: row.user_username || null,
    user_role: row.user_role || null,
    kind: employeeKind(row),
  };
}

export function mapUserAccount(row) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    created_at: row.created_at,
    has_custom_permissions: !!row.has_custom_permissions,
    employee_id: row.employee_id ?? null,
    employee_name: row.employee_name || null,
    employee_active: row.employee_id == null ? null : Number(row.employee_active) === 1,
  };
}

const USER_ACCOUNT_SELECT = `
  SELECT u.id, u.username, u.role, u.created_at,
         CASE WHEN u.permissions_json IS NOT NULL AND TRIM(u.permissions_json) != '' THEN 1 ELSE 0 END
           AS has_custom_permissions,
         e.id AS employee_id, e.name AS employee_name, e.active AS employee_active
  FROM users u
  LEFT JOIN employees e ON e.user_id = u.id
`;

export async function listUserAccounts(db) {
  const rows = await db.all(`${USER_ACCOUNT_SELECT} ORDER BY u.username`);
  return rows.map(mapUserAccount);
}

export async function getUserAccount(db, id) {
  const row = await db.get(`${USER_ACCOUNT_SELECT} WHERE u.id = ?`, [id]);
  return row ? mapUserAccount(row) : null;
}

export async function listUnlinkedEmployeesForAccountLink(db) {
  const rows = await db.all(
    `SELECT id, name, active
     FROM employees
     WHERE user_id IS NULL
     ORDER BY name COLLATE NOCASE, id`
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    active: Number(row.active) === 1,
  }));
}

async function insertEmployeeIdentity(db, { name, phone, startOn, endOn, active, userId, createdBy }) {
  return db.run(
    `INSERT INTO employees (name, phone, start_on, end_on, active, user_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name, phone, startOn, endOn, active, userId, createdBy ?? null]
  );
}

/**
 * Create or link an employee identity for a staff user. No salary, openings,
 * expenses, or customer-debt rows. Caller must already be inside withTransaction
 * when this must commit/rollback with another write (e.g. user insert).
 */
export async function attachEmployeeIdentityToUserInTx(db, user, body = {}, { autoCreate = false } = {}) {
  if (!user?.id) throw badRequest("حساب المستخدم غير موجود", "USER_NOT_FOUND");

  const existing = await db.get(
    `SELECT e.*, u.username AS user_username, u.role AS user_role
     FROM employees e
     LEFT JOIN users u ON u.id = e.user_id
     WHERE e.user_id = ?`,
    [user.id]
  );
  if (existing) {
    return {
      employee: mapEmployeeIdentity({ ...existing, user_username: user.username, user_role: user.role }),
      created: false,
      linked: false,
    };
  }

  const employeeId = parseOptionalPositiveId(body.employee_id, "معرّف الموظف");
  if (employeeId) {
    if (!isStaffAttendanceRole(user.role)) {
      throw badRequest(
        "ربط سجل موظف متاح لحسابات الكاشير وموظف الرفوف وموظف المخبز فقط",
        "USER_NOT_STAFF"
      );
    }
    const emp = await requireEmployee(db, employeeId);
    if (emp.user_id) {
      throw conflict("سجل الموظف مربوط بحساب آخر", "EMPLOYEE_ALREADY_LINKED");
    }
    await db.run("UPDATE employees SET user_id = ?, updated_at = datetime('now') WHERE id = ?", [
      user.id,
      emp.id,
    ]);
    const updated = await getEmployeeRow(db, emp.id);
    return { employee: mapEmployeeIdentity(updated), created: false, linked: true };
  }

  if (!autoCreate || !isStaffAttendanceRole(user.role)) {
    return { employee: null, created: false, linked: false };
  }

  const name =
    body.employee_name != null && String(body.employee_name).trim()
      ? requireName(body.employee_name)
      : requireName(user.username);
  const phone = optionalPhone(body.phone);
  const startOn = body.start_on ? requireYmd(body.start_on, "تاريخ البداية") : null;
  const endOn = body.end_on ? requireYmd(body.end_on, "تاريخ الانتهاء") : null;
  assertDateRange(startOn, endOn);
  const ins = await insertEmployeeIdentity(db, {
    name,
    phone,
    startOn,
    endOn,
    active: 1,
    userId: user.id,
    createdBy: body.createdBy ?? null,
  });
  const created = await getEmployeeRow(db, ins.lastID);
  return { employee: mapEmployeeIdentity(created), created: true, linked: false };
}

export async function setupEmployeeForStaffUser(db, userId, body, req) {
  const id = Number(userId);
  if (!id) throw badRequest("حساب المستخدم غير صالح", "USER_REQUIRED");
  const user = await db.get("SELECT id, username, role FROM users WHERE id = ?", [id]);
  if (!user) throw notFound("المستخدم غير موجود");
  if (!isStaffAttendanceRole(user.role)) {
    throw badRequest(
      "إعداد سجل الموظف لحسابات الكاشير وموظف الرفوف وموظف المخبز فقط",
      "USER_NOT_STAFF"
    );
  }

  const result = await withTransaction(db, async () =>
    attachEmployeeIdentityToUserInTx(
      db,
      user,
      { ...parseUserEmployeeLinkBody(body), createdBy: req?.user?.id ?? null },
      { autoCreate: true }
    )
  );
  if (!result.employee) {
    throw badRequest("تعذّر إعداد سجل الموظف", "EMPLOYEE_REQUIRED");
  }

  if (req && result.created) {
    await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_CREATE, "employees", result.employee.id, null, {
      name: result.employee.name,
      user_id: user.id,
      source: "user_account_setup",
    });
  } else if (req && result.linked) {
    await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_CASHIER_LINK, "employees", result.employee.id, {
      user_id: null,
    }, {
      user_id: user.id,
      username: user.username,
      source: "user_account_setup",
    });
  }
  return result;
}

/**
 * Idempotent backfill for staff logins that have no employees.user_id.
 * Reuses existing links, never matches or merges by name, and posts no finance.
 */
export async function reconcileStaffEmployeeIdentities(db, req) {
  const placeholders = ATTENDANCE_ROLES.map(() => "?").join(", ");
  const result = await withTransaction(db, async () => {
    const staff = await db.all(
      `SELECT id, username, role FROM users WHERE role IN (${placeholders}) ORDER BY id`,
      ATTENDANCE_ROLES
    );
    const created = [];
    const reused = [];
    for (const user of staff) {
      const attach = await attachEmployeeIdentityToUserInTx(
        db,
        user,
        { createdBy: req?.user?.id ?? null },
        { autoCreate: true }
      );
      const row = {
        user_id: user.id,
        username: user.username,
        role: user.role,
        employee_id: attach.employee?.id ?? null,
        employee_name: attach.employee?.name ?? null,
      };
      if (attach.created) created.push(row);
      else reused.push(row);
    }

    const staffByName = new Map();
    for (const user of staff) {
      staffByName.set(String(user.username || "").trim().toLowerCase(), user);
    }
    const unlinked = await db.all(
      `SELECT id, name, active FROM employees WHERE user_id IS NULL ORDER BY id`
    );
    const ambiguous = [];
    for (const emp of unlinked) {
      const user = staffByName.get(String(emp.name || "").trim().toLowerCase());
      if (!user) continue;
      ambiguous.push({
        reason: "name_collision",
        employee_id: emp.id,
        employee_name: emp.name,
        employee_active: Number(emp.active) === 1,
        user_id: user.id,
        username: user.username,
        role: user.role,
      });
    }
    return { created, reused, ambiguous };
  });

  if (req) {
    for (const row of result.created) {
      await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_CREATE, "employees", row.employee_id, null, {
        name: row.employee_name,
        user_id: row.user_id,
        source: "staff_reconcile",
      });
    }
  }

  return {
    created: result.created,
    reused: result.reused,
    ambiguous: result.ambiguous,
    created_count: result.created.length,
    reused_count: result.reused.length,
    ambiguous_count: result.ambiguous.length,
  };
}

function mapEmployee(row, extras = {}) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    start_on: row.start_on,
    end_on: row.end_on,
    active: Number(row.active) === 1,
    user_id: row.user_id,
    user_username: row.user_username || null,
    user_role: row.user_role || null,
    customer_id: row.customer_id ?? null,
    customer_name: row.customer_name || null,
    customer_code: row.customer_code || null,
    customer_balance: row.customer_balance == null ? null : round2(Number(row.customer_balance)),
    kind: employeeKind(row),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...extras,
  };
}

function mapCompensation(row) {
  return {
    id: row.id,
    employee_id: row.employee_id,
    effective_from: row.effective_from,
    compensation_type: row.compensation_type,
    amount: round2(Number(row.amount)),
    expected_days: row.expected_days == null ? null : Number(row.expected_days),
    expected_hours: row.expected_hours == null ? null : Number(row.expected_hours),
    notes: row.notes,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

function mapOpening(row) {
  return {
    id: row.id,
    employee_id: row.employee_id,
    kind: row.kind,
    amount: round2(Number(row.amount)),
    as_of: row.as_of,
    reason: row.reason,
    operating_expense_id: row.operating_expense_id,
    event_seq: row.event_seq,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

export function listPosEmployeeDirectory(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = String(row.name || "").trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return rows.map((row) => {
    const name = String(row.name || "").trim();
    const duplicate = (counts.get(name) || 0) > 1;
    return {
      id: row.id,
      name,
      employee_no: row.id,
      display_name: duplicate ? `${name} · رقم ${row.id}` : name,
    };
  });
}

export async function listActiveEmployeesForPos(db) {
  const rows = await db.all(
    `SELECT id, name FROM employees WHERE active = 1 ORDER BY name COLLATE NOCASE, id`
  );
  return listPosEmployeeDirectory(rows);
}

export async function listLinkableUsers(db, { includeUserId = null } = {}) {
  const placeholders = ATTENDANCE_ROLES.map(() => "?").join(", ");
  const extra = includeUserId ? Number(includeUserId) : null;
  return db.all(
    `SELECT u.id, u.username, u.role
     FROM users u
     WHERE u.role IN (${placeholders})
       AND (
         u.id NOT IN (SELECT user_id FROM employees WHERE user_id IS NOT NULL)
         OR (? IS NOT NULL AND u.id = ?)
       )
     ORDER BY u.username COLLATE NOCASE`,
    [...ATTENDANCE_ROLES, extra, extra]
  );
}

export async function listEmployees(db, { active = "all" } = {}) {
  let sql = `
    SELECT e.*, u.username AS user_username, u.role AS user_role,
           c.name AS customer_name, c.customer_code AS customer_code,
           c.balance AS customer_balance
    FROM employees e
    LEFT JOIN users u ON u.id = e.user_id
    LEFT JOIN customers c ON c.id = e.customer_id
    WHERE 1=1`;
  const params = [];
  if (active === "1" || active === "true") {
    sql += " AND e.active = 1";
  } else if (active === "0" || active === "false") {
    sql += " AND e.active = 0";
  }
  sql += " ORDER BY e.active DESC, e.name COLLATE NOCASE";
  const rows = await db.all(sql, params);
  const out = [];
  for (const row of rows) {
    const current = await db.get(
      `SELECT * FROM employee_compensation
       WHERE employee_id = ?
       ORDER BY effective_from DESC, id DESC
       LIMIT 1`,
      [row.id]
    );
    out.push(
      mapEmployee(row, {
        current_compensation: current ? mapCompensation(current) : null,
      })
    );
  }
  return out;
}

export async function getEmployee(db, id) {
  const row = await requireEmployee(db, id);
  const [compensation, openings] = await Promise.all([
    db.all(
      `SELECT * FROM employee_compensation
       WHERE employee_id = ?
       ORDER BY effective_from DESC, id DESC`,
      [row.id]
    ),
    db.all(
      `SELECT * FROM employee_opening_balances
       WHERE employee_id = ?
       ORDER BY as_of ASC, event_seq ASC, id ASC`,
      [row.id]
    ),
  ]);
  return mapEmployee(row, {
    compensation: compensation.map(mapCompensation),
    opening_balances: openings.map(mapOpening),
    debt_account_locked: await employeeDebtAccountInUse(db, row.id, row.customer_id),
  });
}

export async function createEmployee(db, body, req) {
  const name = requireName(body?.name);
  const phone = optionalPhone(body?.phone);
  const startOn = body?.start_on ? requireYmd(body.start_on, "تاريخ البداية") : null;
  const endOn = body?.end_on ? requireYmd(body.end_on, "تاريخ الانتهاء") : null;
  assertDateRange(startOn, endOn);
  const active = asActiveFlag(body?.active, 1);
  const userId = body?.user_id != null && body.user_id !== "" ? Number(body.user_id) : null;

  const created = await withTransaction(db, async () => {
    if (userId != null) await assertLinkableUser(db, userId);
    const ins = await insertEmployeeIdentity(db, {
      name,
      phone,
      startOn,
      endOn,
      active,
      userId,
      createdBy: req?.user?.id ?? null,
    });
    return getEmployee(db, ins.lastID);
  });

  if (req) {
    await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_CREATE, "employees", created.id, null, {
      name: created.name,
      user_id: created.user_id,
      active: created.active,
    });
  }
  return created;
}

export async function updateEmployee(db, id, body, req) {
  const existing = await requireEmployee(db, id);
  const name = body?.name !== undefined ? requireName(body.name) : existing.name;
  const phone = body?.phone !== undefined ? optionalPhone(body.phone) : existing.phone;
  const startOn =
    body?.start_on !== undefined
      ? body.start_on
        ? requireYmd(body.start_on, "تاريخ البداية")
        : null
      : existing.start_on;
  const endOn =
    body?.end_on !== undefined
      ? body.end_on
        ? requireYmd(body.end_on, "تاريخ الانتهاء")
        : null
      : existing.end_on;
  assertDateRange(startOn, endOn);
  const active = body?.active !== undefined ? asActiveFlag(body.active, existing.active) : existing.active;
  let userId = existing.user_id;
  if (body?.user_id !== undefined) {
    userId = body.user_id == null || body.user_id === "" ? null : Number(body.user_id);
  }
  let customerId = existing.customer_id ?? null;
  if (body?.customer_id !== undefined) {
    customerId = body.customer_id == null || body.customer_id === "" ? null : Number(body.customer_id);
  }

  const updated = await withTransaction(db, async () => {
    if (userId != null) await assertLinkableUser(db, userId, { exceptEmployeeId: existing.id });
    if (customerId != null) await assertLinkableCustomer(db, customerId, { exceptEmployeeId: existing.id });
    await assertEmployeeCustomerLinkChange(db, existing, customerId);
    await db.run(
      `UPDATE employees
       SET name = ?, phone = ?, start_on = ?, end_on = ?, active = ?, user_id = ?, customer_id = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
      [name, phone, startOn, endOn, active, userId, customerId, existing.id]
    );
    return getEmployee(db, existing.id);
  });

  if (req) {
    await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_UPDATE, "employees", existing.id, {
      name: existing.name,
      phone: existing.phone,
      start_on: existing.start_on,
      end_on: existing.end_on,
      active: Number(existing.active) === 1,
      user_id: existing.user_id,
      customer_id: existing.customer_id ?? null,
    }, {
      name: updated.name,
      phone: updated.phone,
      start_on: updated.start_on,
      end_on: updated.end_on,
      active: updated.active,
      user_id: updated.user_id,
      customer_id: updated.customer_id ?? null,
    });
  }
  return updated;
}

export async function addCompensation(db, employeeId, body, req) {
  const emp = await requireEmployee(db, employeeId);
  const effectiveFrom = requireYmd(body?.effective_from, "تاريخ السريان");
  const type = String(body?.compensation_type || "").trim();
  if (!COMPENSATION_TYPES.has(type)) {
    throw badRequest("نوع التعويض يجب أن يكون شهرياً أو يومياً أو بالساعة");
  }
  const amount = requirePositiveMoney(body?.amount, "المبلغ");
  const expectedDays = optionalNonNeg(body?.expected_days);
  const expectedHours = optionalNonNeg(body?.expected_hours);
  const notes = body?.notes != null && String(body.notes).trim() ? String(body.notes).trim().slice(0, 500) : null;

  const row = await withTransaction(db, async () => {
    const dup = await db.get(
      "SELECT id FROM employee_compensation WHERE employee_id = ? AND effective_from = ?",
      [emp.id, effectiveFrom]
    );
    if (dup) {
      throw conflict("يوجد معدل بنفس تاريخ السريان — أضف صفاً بتاريخ لاحق للزيادة", "RATE_EFFECTIVE_FROM_EXISTS");
    }
    const ins = await db.run(
      `INSERT INTO employee_compensation
         (employee_id, effective_from, compensation_type, amount, expected_days, expected_hours, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [emp.id, effectiveFrom, type, amount, expectedDays, expectedHours, notes, req?.user?.id ?? null]
    );
    return db.get("SELECT * FROM employee_compensation WHERE id = ?", [ins.lastID]);
  });

  if (req) {
    await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_COMPENSATION_ADD, "employee_compensation", row.id, null, {
      employee_id: emp.id,
      effective_from: effectiveFrom,
      compensation_type: type,
      amount,
    });
  }
  return mapCompensation(row);
}

async function assertPrepaidCutover(db, employeeId, { amount, asOf, expenseId }) {
  if (expenseId != null) {
    const exp = await db.get("SELECT id, amount, paid_on FROM operating_expenses WHERE id = ?", [expenseId]);
    if (!exp) throw notFound("سند المصروف غير موجود");
    const expAmt = round2(Number(exp.amount));
    if (expAmt !== amount) {
      throw badRequest("مبلغ الرصيد الافتتاحي يجب أن يساوي مبلغ سند المصروف المربوط", "CUTOVER_AMOUNT_MISMATCH");
    }
    if (String(exp.paid_on) !== asOf) {
      throw badRequest("تاريخ الرصيد يجب أن يساوي تاريخ دفع سند المصروف المربوط", "CUTOVER_DATE_MISMATCH");
    }
    const used = await db.get(
      "SELECT id FROM employee_opening_balances WHERE operating_expense_id = ?",
      [expenseId]
    );
    if (used) {
      throw conflict("هذا المصروف مربوط برصيد افتتاحي مسبقاً", "CUTOVER_DUPLICATE");
    }
    const orphan = await db.get(
      `SELECT id FROM employee_opening_balances
       WHERE employee_id = ? AND kind = 'prepaid_salary'
         AND amount = ? AND as_of = ? AND operating_expense_id IS NULL`,
      [employeeId, amount, asOf]
    );
    if (orphan) {
      throw conflict(
        "يوجد رصيد مقدّم بنفس المبلغ والتاريخ دون سند — لا تُسجَّل نفس الدفعة مرتين",
        "CUTOVER_DUPLICATE"
      );
    }
    return;
  }

  const attached = await db.get(
    `SELECT b.id FROM employee_opening_balances b
     JOIN operating_expenses e ON e.id = b.operating_expense_id
     WHERE b.employee_id = ? AND b.kind = 'prepaid_salary'
       AND e.amount = ? AND e.paid_on = ?`,
    [employeeId, amount, asOf]
  );
  if (attached) {
    throw conflict(
      "دفعة تاريخية مربوطة بسند مصروف بنفس المبلغ والتاريخ — لا تُضاف كرصيد مقدّم منفصل",
      "CUTOVER_DUPLICATE"
    );
  }
}

export async function addOpeningBalance(db, employeeId, body, req) {
  const emp = await requireEmployee(db, employeeId);
  const kind = String(body?.kind || "").trim();
  if (!OPENING_KINDS.has(kind)) {
    throw badRequest("نوع الرصيد يجب أن يكون راتباً غير مدفوع أو مقدّم راتب");
  }
  const amount = requirePositiveMoney(body?.amount);
  const asOf = requireYmd(body?.as_of, "تاريخ الرصيد");
  const reason = String(body?.reason || "").trim();
  if (!reason) throw badRequest("سبب الرصيد الافتتاحي مطلوب");
  if (reason.length > 500) throw badRequest("السبب طويل جداً");

  let expenseId = null;
  if (body?.operating_expense_id != null && body.operating_expense_id !== "") {
    expenseId = Number(body.operating_expense_id);
    if (!expenseId) throw badRequest("معرّف سند المصروف غير صالح");
  }
  if (kind === "unpaid_salary" && expenseId != null) {
    throw badRequest("راتب غير مدفوع لا يُربَط بسند مصروف");
  }

  const mapped = await withTransaction(db, async () => {
    if (kind === "prepaid_salary") {
      await assertPrepaidCutover(db, emp.id, { amount, asOf, expenseId });
    }
    const eventKind = kind === "unpaid_salary" ? "opening_unpaid" : "opening_prepaid";
    const eventSeq = await nextEmployeeEventSeq(db, emp.id);
    const ins = await db.run(
      `INSERT INTO employee_opening_balances
         (employee_id, kind, amount, as_of, reason, operating_expense_id, event_seq, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [emp.id, kind, amount, asOf, reason, expenseId, eventSeq, req?.user?.id ?? null]
    );
    await appendEmployeeEvent(db, {
      employeeId: emp.id,
      eventDate: asOf,
      kind: eventKind,
      eventSeq,
      sourceTable: "employee_opening_balances",
      sourceId: ins.lastID,
    });
    return db.get("SELECT * FROM employee_opening_balances WHERE id = ?", [ins.lastID]);
  });

  if (req) {
    await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_OPENING_BALANCE_CREATE, "employee_opening_balances", mapped.id, null, {
      employee_id: emp.id,
      kind,
      amount,
      as_of: asOf,
      operating_expense_id: expenseId,
      event_seq: mapped.event_seq,
    });
  }
  return mapOpening(mapped);
}

function mapStaffAccountRow(row) {
  return {
    user_id: row.user_id,
    username: row.username,
    role: row.role,
    linked: row.linked_employee_id != null,
    linked_employee_id: row.linked_employee_id ?? null,
    linked_employee_name: row.linked_employee_name || null,
    linked_employee_active: row.linked_employee_id == null ? null : Number(row.linked_employee_active) === 1,
  };
}

export async function listStaffAccounts(db) {
  const placeholders = ATTENDANCE_ROLES.map(() => "?").join(", ");
  const rows = await db.all(
    `SELECT u.id AS user_id, u.username, u.role,
            e.id AS linked_employee_id, e.name AS linked_employee_name,
            e.active AS linked_employee_active
     FROM users u
     LEFT JOIN employees e ON e.user_id = u.id
     WHERE u.role IN (${placeholders})
     ORDER BY u.username COLLATE NOCASE`,
    ATTENDANCE_ROLES
  );
  return rows.map(mapStaffAccountRow);
}

export async function listCashierAccounts(db) {
  return (await listStaffAccounts(db)).filter((row) => row.role === "cashier");
}

export async function createEmployeeFromCashierUser(db, body, req) {
  const userId = Number(body?.user_id);
  if (!userId) throw badRequest("حساب الموظف مطلوب", "USER_REQUIRED");
  const user = await db.get("SELECT id, username, role FROM users WHERE id = ?", [userId]);
  if (!user) throw badRequest("حساب المستخدم غير موجود", "USER_NOT_FOUND");
  if (!isStaffAttendanceRole(user.role)) {
    throw badRequest(
      "يُعدّ سجل الموظف من هذا المسار لحسابات الكاشير والرفوف والمخبز فقط",
      "USER_NOT_STAFF"
    );
  }

  const result = await withTransaction(db, async () =>
    attachEmployeeIdentityToUserInTx(
      db,
      user,
      { ...parseUserEmployeeLinkBody(body), createdBy: req?.user?.id ?? null },
      { autoCreate: true }
    )
  );
  if (!result.employee) {
    throw badRequest("تعذّر إعداد سجل الموظف", "EMPLOYEE_REQUIRED");
  }
  if (req && result.created) {
    await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_CREATE, "employees", result.employee.id, null, {
      name: result.employee.name,
      user_id: user.id,
      source: "staff_user",
    });
  } else if (req && result.linked) {
    await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_CASHIER_LINK, "employees", result.employee.id, {
      user_id: null,
    }, {
      user_id: user.id,
      username: user.username,
      source: "staff_user",
    });
  }
  return { employee: await getEmployee(db, result.employee.id), created: result.created };
}

export async function listDebtCustomers(db) {
  const rows = await db.all(
    `SELECT c.id, c.name, c.customer_code, c.balance, e.id AS linked_employee_id, e.name AS linked_employee_name
     FROM customers c
     LEFT JOIN employees e ON e.customer_id = c.id
     ORDER BY c.name COLLATE NOCASE, c.id`
  );
  const out = [];
  for (const row of rows) {
    const linked = row.linked_employee_id != null;
    const history = linked ? true : await customerHasFinancialHistory(db, row.id);
    out.push({
      id: row.id,
      name: row.name,
      customer_code: row.customer_code || null,
      balance: round2(Number(row.balance) || 0),
      linked_employee_id: row.linked_employee_id ?? null,
      linked_employee_name: row.linked_employee_name || null,
      has_financial_history: history,
      linkable: !linked && !history,
    });
  }
  return out;
}

export async function linkEmployeeToCustomer(db, employeeId, body, req) {
  const emp = await requireEmployee(db, employeeId);
  const customerId =
    body?.customer_id == null || body.customer_id === "" ? null : Number(body.customer_id);
  const updated = await withTransaction(db, async () => {
    await assertEmployeeCustomerLinkChange(db, emp, customerId);
    await db.run(
      "UPDATE employees SET customer_id = ?, updated_at = datetime('now') WHERE id = ?",
      [customerId, emp.id]
    );
    return getEmployee(db, emp.id);
  });
  if (req) {
    await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_CUSTOMER_LINK, "employees", emp.id, {
      customer_id: emp.customer_id ?? null,
    }, {
      customer_id: updated.customer_id ?? null,
    });
  }
  return updated;
}

export async function linkEmployeeToCashierUser(db, employeeId, body, req) {
  const emp = await requireEmployee(db, employeeId);
  const userId = Number(body?.user_id);
  if (!userId) throw badRequest("حساب الكاشير مطلوب", "USER_REQUIRED");
  const user = await db.get("SELECT id, username, role FROM users WHERE id = ?", [userId]);
  if (!user) throw badRequest("حساب المستخدم غير موجود", "USER_NOT_FOUND");
  if (!isStaffAttendanceRole(user.role)) {
    throw badRequest("يُربَط سجل الموظف بحساب كاشير أو رفوف أو مخبز فقط", "USER_NOT_STAFF");
  }

  if (emp.user_id && Number(emp.user_id) === user.id) {
    return { employee: await getEmployee(db, emp.id), created: false };
  }
  if (emp.user_id && Number(emp.user_id) !== user.id) {
    throw conflict("سجل الموظف مربوط بحساب آخر", "EMPLOYEE_ALREADY_LINKED");
  }

  const updated = await updateEmployee(db, emp.id, { user_id: user.id }, req);
  if (req) {
    await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_CASHIER_LINK, "employees", emp.id, {
      user_id: emp.user_id,
    }, {
      user_id: user.id,
      username: user.username,
    });
  }
  return { employee: updated, created: false };
}

/**
 * Historical absorption helper — not called from ordinary link/update.
 * Linking an account with existing sales is rejected instead.
 */
export async function stampEmployeeOnExistingCustomerSales(db, employeeId, customerId) {
  if (!employeeId || !customerId) return;
  await db.run(
    `UPDATE transactions SET employee_id = ? WHERE customer_id = ? AND employee_id IS NULL`,
    [employeeId, customerId]
  );
  await db.run(
    `UPDATE on_account_requests SET employee_id = ? WHERE customer_id = ? AND employee_id IS NULL`,
    [employeeId, customerId]
  );
}

/**
 * Create or reuse the employee's internal debt customer inside an open write tx.
 * Never matches by name. No opening balance or ledger rows.
 */
export async function ensureEmployeeDebtAccountInTx(db, employeeId) {
  const fresh = await requireEmployee(db, employeeId);
  if (fresh.customer_id) {
    return { employee: await getEmployee(db, fresh.id), created: false };
  }
  const groupId = await getDefaultBalanceGroupId(db);
  const code = await ensureEntityCode(db, "customer", null);
  const ins = await db.run(
    `INSERT INTO customers
      (name, phone, price_category, credit_limit, notes, customer_code, opening_balance, balance, balance_group_id)
     VALUES (?, ?, 'retail', 0, ?, ?, 0, 0, ?)`,
    [
      fresh.name,
      fresh.phone || null,
      `حساب ذمة موظف #${fresh.id}`,
      code,
      groupId,
    ]
  );
  await db.run(
    "UPDATE employees SET customer_id = ?, updated_at = datetime('now') WHERE id = ?",
    [ins.lastID, fresh.id]
  );
  return { employee: await getEmployee(db, fresh.id), created: true };
}

/**
 * Canonical customer for posting an employee ذمة sale.
 * Reuses employees.customer_id, preserves an exclusive request-time link,
 * or creates a new internal account. Conflicts are errors, not merges.
 */
export async function resolveEmployeeCustomerForPostedSale(
  db,
  { employeeId, requestCustomerId = null } = {}
) {
  const empId = Number(employeeId);
  if (!Number.isInteger(empId) || empId <= 0) {
    throw badRequest("اختر الموظف", "EMPLOYEE_REQUIRED");
  }
  const emp = await requireEmployee(db, empId);
  if (!Number(emp.active)) {
    throw badRequest("هذا الموظف غير نشط", "EMPLOYEE_INACTIVE");
  }

  const reqCust = requestCustomerId ? Number(requestCustomerId) : null;
  const liveCust = emp.customer_id ? Number(emp.customer_id) : null;

  if (liveCust) {
    if (reqCust && reqCust !== liveCust) {
      throw conflict(
        "حساب ذمة الموظف لا يطابق طلب البيع. لا يُدمج الدين تلقائياً.",
        "EMPLOYEE_CUSTOMER_CONFLICT"
      );
    }
    const customer = await db.get("SELECT id FROM customers WHERE id = ?", [liveCust]);
    if (!customer) {
      throw conflict("حساب الذمة المربوط بهذا الموظف غير موجود", "EMPLOYEE_CUSTOMER_MISSING");
    }
    const taken = await db.get(
      "SELECT id, name FROM employees WHERE customer_id = ? AND id != ?",
      [liveCust, emp.id]
    );
    if (taken) {
      throw conflict("حساب الذمة هذا مربوط بموظف آخر — لا يُنسخ الدين", "CUSTOMER_ALREADY_LINKED");
    }
    return { customerId: liveCust, employeeId: Number(emp.id), created: false };
  }

  if (reqCust) {
    await assertLinkableCustomer(db, reqCust, { exceptEmployeeId: emp.id });
    await assertCustomerHasNoFinancialHistory(db, reqCust);
    await db.run(
      "UPDATE employees SET customer_id = ?, updated_at = datetime('now') WHERE id = ?",
      [reqCust, emp.id]
    );
    return { customerId: reqCust, employeeId: Number(emp.id), created: false };
  }

  const ensured = await ensureEmployeeDebtAccountInTx(db, emp.id);
  return {
    customerId: Number(ensured.employee.customer_id),
    employeeId: Number(emp.id),
    created: Boolean(ensured.created),
  };
}

export async function createEmployeeDebtAccount(db, employeeId, req) {
  const emp = await requireEmployee(db, employeeId);
  if (emp.customer_id) {
    return { employee: await getEmployee(db, emp.id), created: false };
  }

  const updated = await withTransaction(db, () => ensureEmployeeDebtAccountInTx(db, emp.id));

  if (req && updated.created) {
    await logAudit(db, req, AUDIT_ACTIONS.EMPLOYEE_DEBT_ACCOUNT_CREATE, "employees", emp.id, {
      customer_id: emp.customer_id ?? null,
    }, {
      customer_id: updated.employee.customer_id ?? null,
      created: true,
    });
  }
  return updated;
}
