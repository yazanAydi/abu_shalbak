/**
 * Whitelist of user roles. Stored in `users.role` (TEXT).
 * accountant: reports; cashier / shelves_employee / bakery_employee: POS; admin: full access.
 */
export const USER_ROLES = [
  "admin",
  "accountant",
  "cashier",
  "shelves_employee",
  "bakery_employee",
];

/** Shop-floor roles tracked in employee attendance / payroll */
export const ATTENDANCE_ROLES = ["cashier", "bakery_employee", "shelves_employee"];

/** Roles that clock in/out via face kiosk punches */
export const PUNCH_ROLES = ["bakery_employee", "shelves_employee"];

/** Face-kiosk employees — no app login; username is for attendance only */
export function isKioskOnlyRole(role) {
  return PUNCH_ROLES.includes(String(role));
}

export function isValidRole(role) {
  return USER_ROLES.includes(String(role));
}

export function canRunCheckout(role) {
  return role === "admin" || role === "cashier" || role === "shelves_employee" || role === "bakery_employee";
}

export function canViewReports(role) {
  return role === "admin" || role === "accountant";
}

export function isAdmin(role) {
  return role === "admin";
}

/** Admin panel login: admin and accountant only. */
export function canLoginOffice(role) {
  return role === "admin" || role === "accountant";
}

/** POS login: cashier only. */
export function canLoginPos(role) {
  return role === "cashier";
}

const DISABLED_LOGIN_MSG = "هذا الحساب غير مفعّل لتسجيل الدخول.";

export function wrongPortalLoginMessage(role, app) {
  if (app === "office") {
    if (role === "cashier") {
      return "هذا الحساب لنقطة البيع. افتح تطبيق الكاشير وسجّل الدخول من هناك.";
    }
    return DISABLED_LOGIN_MSG;
  }
  if (app === "pos") {
    if (role === "admin" || role === "accountant") {
      return "هذا الحساب للوحة الإدارة. افتح تطبيق المكتب وسجّل الدخول من هناك.";
    }
    return DISABLED_LOGIN_MSG;
  }
  return DISABLED_LOGIN_MSG;
}
