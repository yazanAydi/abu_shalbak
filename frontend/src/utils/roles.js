export const USER_ROLES = [
  "admin",
  "accountant",
  "cashier",
  "shelves_employee",
  "bakery_employee",
];

/** Human-readable (Arabic) labels for POS role picker */
export const ROLE_LABELS_AR = {
  admin: "مدير",
  accountant: "محاسب",
  cashier: "كاشير",
  shelves_employee: "موظف رفوف",
  bakery_employee: "موظف مخبز",
};

export function isAdminRole(role) {
  return role === "admin";
}

export function canLoginOffice(role) {
  return role === "admin" || role === "accountant";
}

export function wrongPortalLoginMessage(role) {
  if (role === "cashier") {
    return "هذا الحساب لنقطة البيع. افتح تطبيق الكاشير وسجّل الدخول من هناك.";
  }
  return "هذا الحساب غير مفعّل لتسجيل الدخول.";
}

export function canUseCheckout(role) {
  return (
    role === "admin" ||
    role === "cashier" ||
    role === "shelves_employee" ||
    role === "bakery_employee"
  );
}

/** POS roles that must have an open shift before checkout/refunds */
export function requiresShiftForPos(role) {
  return canUseCheckout(role);
}

export function canViewReports(role) {
  return role === "admin" || role === "accountant";
}

/** Default path after login in the admin (office) app */
export function homePathForRole(role) {
  if (role === "admin" || role === "accountant") return "/reports";
  return "/reports";
}
