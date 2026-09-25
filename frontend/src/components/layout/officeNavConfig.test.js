import {
  OFFICE_NAV,
  SECTION_ORDER,
  filterOfficeNav,
  groupOfficeNav,
  permissionTopicsFromNav,
} from "./officeNavConfig";
import {
  allAccountantPermissionKeys,
  allAccountantPermissionsDisabled,
  allAccountantPermissionsEnabled,
} from "../../utils/accountantPermissions";

const NONE = allAccountantPermissionsDisabled();
const ALL = allAccountantPermissionsEnabled();

function navFor(role, permissions) {
  return groupOfficeNav(filterOfficeNav(role, permissions));
}

function sectionsOf(groups) {
  return groups.map((g) => g.section);
}

function pathsIn(groups, section) {
  return (groups.find((g) => g.section === section)?.items || []).map((i) => i.path);
}

describe("office nav filtering", () => {
  test("admin sees every nav item, including admin-only ones", () => {
    const items = filterOfficeNav("admin", ALL);
    expect(items).toHaveLength(OFFICE_NAV.length);
    expect(items.map((i) => i.path)).toContain("/import-supplier-balances");
  });

  test("non-office roles see nothing", () => {
    for (const role of ["cashier", "shelves_employee", "delivery"]) {
      expect(filterOfficeNav(role, ALL)).toHaveLength(0);
    }
  });

  test("accountant only sees leaves that are enabled", () => {
    const groups = navFor("accountant", {
      ...NONE,
      products: true,
      customers: true,
      stock_count: true,
    });
    expect(sectionsOf(groups)).toEqual(["catalog"]);
    expect(pathsIn(groups, "catalog")).toEqual(["/manage-products", "/customers", "/inventory"]);
    // Disabled siblings are absent.
    expect(pathsIn(groups, "catalog")).not.toContain("/suppliers");
    expect(pathsIn(groups, "catalog")).not.toContain("/units");
  });

  test("a group disappears when all of its children are disabled", () => {
    const groups = navFor("accountant", { ...NONE, dashboard: true });
    expect(sectionsOf(groups)).toEqual(["overview"]);
    expect(sectionsOf(groups)).not.toContain("catalog");
    expect(sectionsOf(groups)).not.toContain("admin");
  });

  test("a group stays visible when at least one child is enabled", () => {
    const groups = navFor("accountant", { ...NONE, warehouses: true });
    expect(sectionsOf(groups)).toEqual(["catalog"]);
    expect(pathsIn(groups, "catalog")).toEqual(["/warehouses"]);
  });

  test("the admin group can expose الصلاحيات alone", () => {
    const groups = navFor("accountant", { ...NONE, permissions: true });
    expect(sectionsOf(groups)).toEqual(["admin"]);
    expect(pathsIn(groups, "admin")).toEqual(["/permissions"]);
  });

  test("admin-only items stay hidden even with every permission granted", () => {
    const items = filterOfficeNav("accountant", ALL);
    expect(items.map((i) => i.path)).not.toContain("/import-supplier-balances");
  });

  test("ordering, labels, icons and badges are preserved after filtering", () => {
    const items = filterOfficeNav("accountant", ALL);
    const expected = OFFICE_NAV.filter((i) => i.permissionKey);
    expect(items.map((i) => i.path)).toEqual(expected.map((i) => i.path));
    expect(items.map((i) => i.label)).toEqual(expected.map((i) => i.label));
    expect(items.map((i) => i.icon)).toEqual(expected.map((i) => i.icon));
    expect(items.map((i) => i.badgePath)).toEqual(expected.map((i) => i.badgePath));
  });

  test("groups follow the section order", () => {
    const groups = navFor("admin", ALL);
    const order = sectionsOf(groups);
    expect(order).toEqual(SECTION_ORDER.filter((s) => order.includes(s)));
  });

  test("المخبز sits after overview and hides finance actions without their keys", () => {
    const bakeryOnly = navFor("accountant", { ...NONE, bakery: true });
    expect(sectionsOf(bakeryOnly)).toEqual(["bakery"]);
    expect(pathsIn(bakeryOnly, "bakery")).toEqual(["/bakery", "/bakery/products", "/bakery/sales"]);

    const suppliesOnly = navFor("accountant", { ...NONE, bakery_supplies: true });
    expect(pathsIn(suppliesOnly, "bakery")).toEqual([
      "/bakery/products",
      "/bakery/purchases",
      "/bakery/warehouses",
      "/bakery/movements",
    ]);
    expect(pathsIn(suppliesOnly, "bakery")).not.toContain("/bakery/returns");
    expect(pathsIn(suppliesOnly, "bakery")).not.toContain("/bakery/expiry");

    const withPurchases = navFor("accountant", { ...NONE, bakery: true, purchases: true });
    expect(pathsIn(withPurchases, "bakery")).toEqual(expect.arrayContaining([
      "/bakery/purchases",
      "/bakery/returns",
    ]));
    expect(filterOfficeNav("admin", ALL).map((i) => i.path)).not.toContain("/bakery-supplies");
  });

  test("bakery filtered views are omitted from permission topics", () => {
    const topics = permissionTopicsFromNav();
    const bakery = topics.find((t) => t.id === "bakery");
    expect(bakery.labelAr).toBe("المخبز");
    expect(bakery.features.map((f) => f.key)).toEqual(["bakery", "bakery_supplies"]);
    expect(topics.find((t) => t.id === "catalog").features.map((f) => f.key)).not.toContain("bakery");
  });
});

describe("permission settings topics", () => {
  const topics = permissionTopicsFromNav();
  const leafKeys = topics.flatMap((t) => t.features.map((f) => f.key));

  test("topics mirror the nav hierarchy", () => {
    expect(topics.map((t) => t.id)).toEqual(
      SECTION_ORDER.filter((s) => topics.some((t) => t.id === s))
    );
    for (const topic of topics) {
      expect(topic.labelAr.length).toBeGreaterThan(0);
      expect(topic.features.length).toBeGreaterThan(0);
    }
  });

  test("every catalog key is offered exactly once, and nothing extra", () => {
    expect(new Set(leafKeys).size).toBe(leafKeys.length);
    expect([...leafKeys].sort()).toEqual([...allAccountantPermissionKeys()].sort());
  });

  test("the الإدارة group offers the four remaining admin leaves", () => {
    const admin = topics.find((t) => t.id === "admin");
    expect(admin.features.map((f) => f.key)).toEqual([
      "user_accounts",
      "store_settings",
      "currencies",
      "permissions",
    ]);
    expect(admin.features.map((f) => f.labelAr)).toEqual([
      "الحسابات",
      "الإعدادات",
      "العملات",
      "الصلاحيات",
    ]);
  });

  test("الموظفون lists the employee pages and hides when none are allowed", () => {
    const adminEmployees = pathsIn(navFor("admin", ALL), "employees");
    expect(adminEmployees).toEqual([
      "/employee-statements",
      "/employee-salaries",
      "/cashier-payroll",
      "/employee-attendance",
    ]);
    expect(pathsIn(navFor("admin", ALL), "finance")).not.toEqual(
      expect.arrayContaining(adminEmployees)
    );

    const payrollOnly = navFor("accountant", { ...NONE, employee_payroll: true });
    expect(sectionsOf(payrollOnly)).toEqual(["employees"]);
    expect(pathsIn(payrollOnly, "employees")).toEqual([
      "/employee-statements",
      "/employee-salaries",
      "/cashier-payroll",
      "/employee-attendance",
    ]);
    expect(sectionsOf(payrollOnly)).not.toContain("finance");

    const financeOnly = navFor("accountant", { ...NONE, finance: true, expenses: true });
    expect(sectionsOf(financeOnly)).toEqual(["finance", "operations"]);
    expect(pathsIn(financeOnly, "operations")).toEqual(["/shop-consumption-approvals"]);
    expect(pathsIn(financeOnly, "finance")).not.toContain("/employee-statements");
    expect(sectionsOf(navFor("accountant", NONE))).not.toContain("employees");
  });

  test("كشف حساب ورواتب الموظفين is grouped under الموظفون", () => {
    const employees = topics.find((t) => t.id === "employees");
    expect(employees.labelAr).toBe("الموظفون");
    expect(employees.features.map((f) => f.key)).toEqual(["employee_payroll"]);
    expect(employees.features[0].labelAr).toBe("كشف حساب ورواتب الموظفين");
    expect(topics.find((t) => t.id === "finance").features.map((f) => f.key)).not.toContain(
      "employee_payroll"
    );
  });

  test("group select-all / clear-all toggles exactly that group's leaves", () => {
    const catalog = topics.find((t) => t.id === "catalog");
    const keys = catalog.features.map((f) => f.key);

    let perms = { ...NONE };
    for (const key of keys) perms[key] = true; // تحديد الكل
    const groups = navFor("accountant", perms);
    expect(pathsIn(groups, "catalog")).toHaveLength(keys.length);

    for (const key of keys) perms[key] = false; // إلغاء الكل
    expect(sectionsOf(navFor("accountant", perms))).not.toContain("catalog");
  });
});
