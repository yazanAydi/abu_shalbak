export const USER_ROLES = [
  "admin",
  "accountant",
  "cashier",
  "shelves_employee",
  "bakery_employee",
];

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

export function canLoginPos(role) {
  return role === "cashier";
}

export function canUseCheckout(role) {
  return role === "cashier";
}

export function requiresShiftForPos(role) {
  return canUseCheckout(role);
}

export function canViewReports(role) {
  return role === "admin" || role === "accountant";
}

export function wrongPortalLoginMessage(role) {
  if (role === "admin" || role === "accountant") {
    return "هذا الحساب للوحة الإدارة. افتح تطبيق المكتب وسجّل الدخول من هناك.";
  }
  return "هذا الحساب غير مفعّل لتسجيل الدخول.";
}

export function homePathForRole(role) {
  if (canUseCheckout(role)) return "/checkout";
  return "/login";
}
