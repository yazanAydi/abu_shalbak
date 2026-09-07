import {
  ACCOUNTANT_PERMISSION_DEFS,
  allAccountantPermissionKeys,
  allAccountantPermissionsDisabled,
  allAccountantPermissionsEnabled,
  canAccessOfficePath,
  defaultAccountantPermissions,
  getEffectivePermissions,
  hasAccountantPermission,
  homePathForPermissions,
  normalizeAccountantPermissions,
  permissionKeyForPath,
} from "./accountantPermissions";

describe("accountant permission catalog", () => {
  test("keys are unique and every def has an Arabic label", () => {
    const keys = allAccountantPermissionKeys();
    expect(new Set(keys).size).toBe(keys.length);
    for (const def of ACCOUNTANT_PERMISSION_DEFS) {
      expect(typeof def.labelAr).toBe("string");
      expect(def.labelAr.length).toBeGreaterThan(0);
      expect(typeof def.defaultEnabled).toBe("boolean");
    }
  });

  test("previously existing keys stay enabled by default, newly added keys are disabled", () => {
    const defaults = defaultAccountantPermissions();
    // Keys that already existed before the nav-level permissions work.
    for (const key of [
      "dashboard",
      "finance",
      "expenses",
      "sales_reports",
      "shift_audit",
      "refunds",
      "refund_approvals",
      "on_account_approvals",
      "advance_approvals",
      "expiry",
      "sales_by_price",
      "banks",
      "account_statement",
      "vouchers",
      "deliveries",
      "employee_payroll",
    ]) {
      expect(defaults[key]).toBe(true);
    }
    // Newly introduced nav keys must not grant anything automatically.
    for (const key of [
      "products",
      "product_organization",
      "customers",
      "suppliers",
      "units",
      "categories",
      "stock_count",
      "bakery_supplies",
      "warehouses",
      "purchases",
      "sales_invoices",
      "inventory_receipts",
      "inventory_issues",
      "marketing",
      "user_accounts",
      "store_settings",
      "currencies",
      "permissions",
    ]) {
      expect(defaults[key]).toBe(false);
    }
  });

  test("select all / deselect all cover every catalog key", () => {
    const on = allAccountantPermissionsEnabled();
    const off = allAccountantPermissionsDisabled();
    for (const key of allAccountantPermissionKeys()) {
      expect(on[key]).toBe(true);
      expect(off[key]).toBe(false);
    }
    expect(Object.keys(on)).toHaveLength(allAccountantPermissionKeys().length);
    expect(Object.keys(off)).toHaveLength(allAccountantPermissionKeys().length);
  });
});

describe("normalizeAccountantPermissions", () => {
  test("legacy saved maps keep their old behaviour", () => {
    const legacy = { dashboard: true, finance: true, expenses: false };
    const out = normalizeAccountantPermissions(legacy);
    expect(out.dashboard).toBe(true);
    expect(out.finance).toBe(true);
    expect(out.expenses).toBe(false);
    // Untouched legacy keys keep defaulting to enabled…
    expect(out.sales_reports).toBe(true);
    expect(out.vouchers).toBe(true);
    // …while keys the legacy map never knew about stay off.
    expect(out.products).toBe(false);
    expect(out.user_accounts).toBe(false);
  });

  test("accepts stringy booleans and ignores unknown keys", () => {
    const out = normalizeAccountantPermissions({
      products: "true",
      customers: 1,
      suppliers: "1",
      units: "false",
      categories: 0,
      not_a_real_permission: true,
    });
    expect(out.products).toBe(true);
    expect(out.customers).toBe(true);
    expect(out.suppliers).toBe(true);
    expect(out.units).toBe(false);
    expect(out.categories).toBe(false);
    expect(out.not_a_real_permission).toBeUndefined();
  });

  test("garbage input falls back to defaults", () => {
    expect(normalizeAccountantPermissions(null)).toEqual(defaultAccountantPermissions());
    expect(normalizeAccountantPermissions([])).toEqual(defaultAccountantPermissions());
    expect(normalizeAccountantPermissions("nope")).toEqual(defaultAccountantPermissions());
  });
});

describe("hasAccountantPermission", () => {
  const noneAllowed = allAccountantPermissionsDisabled();

  test("admin follows an explicit custom map and stays open when a key is missing", () => {
    expect(hasAccountantPermission("admin", noneAllowed, "products")).toBe(false);
    expect(hasAccountantPermission("admin", { products: true }, "products")).toBe(true);
    expect(hasAccountantPermission("admin", {}, "permissions")).toBe(true);
    expect(hasAccountantPermission("admin", null, "products")).toBe(true);
  });

  test("accountant follows the shared map", () => {
    const perms = { ...noneAllowed, customers: true };
    expect(hasAccountantPermission("accountant", perms, "customers")).toBe(true);
    expect(hasAccountantPermission("accountant", perms, "suppliers")).toBe(false);
  });

  test("other roles never pass, whatever the map says", () => {
    const all = allAccountantPermissionsEnabled();
    for (const role of ["cashier", "shelves_employee", "delivery", undefined]) {
      expect(hasAccountantPermission(role, all, "customers")).toBe(false);
      expect(hasAccountantPermission(role, all, "dashboard")).toBe(false);
    }
  });

  test("effective permissions: admin everything, accountant normalized, others defaults", () => {
    expect(getEffectivePermissions("admin", noneAllowed)).toEqual(allAccountantPermissionsEnabled());
    expect(getEffectivePermissions("accountant", { products: true })).toEqual(
      normalizeAccountantPermissions({ products: true })
    );
    expect(getEffectivePermissions("cashier", allAccountantPermissionsEnabled())).toEqual(
      defaultAccountantPermissions()
    );
  });
});

describe("office path guards", () => {
  const noneAllowed = allAccountantPermissionsDisabled();

  test("permissionKeyForPath maps exact and nested routes", () => {
    expect(permissionKeyForPath("/manage-products")).toBe("products");
    expect(permissionKeyForPath("/products/42")).toBe("products");
    expect(permissionKeyForPath("/vouchers/payment")).toBe("vouchers");
    expect(permissionKeyForPath("/inventory-receipts/new")).toBe("inventory_receipts");
    expect(permissionKeyForPath("/inventory-issues/12")).toBe("inventory_issues");
    expect(permissionKeyForPath("/suppliers/7/statement")).toBe("account_statement");
    expect(permissionKeyForPath("/import-supplier-balances")).toBeNull();
  });

  test("a disabled page cannot be reached by typing its URL", () => {
    const perms = { ...noneAllowed, customers: true };
    expect(canAccessOfficePath("accountant", perms, "/customers")).toBe(true);
    expect(canAccessOfficePath("accountant", perms, "/suppliers")).toBe(false);
    expect(canAccessOfficePath("accountant", perms, "/manage-users")).toBe(false);
    expect(canAccessOfficePath("accountant", perms, "/products/9")).toBe(false);
  });

  test("admin-only pages are closed to accountants and open to admins", () => {
    const all = allAccountantPermissionsEnabled();
    expect(canAccessOfficePath("accountant", all, "/import-supplier-balances")).toBe(false);
    expect(canAccessOfficePath("admin", noneAllowed, "/import-supplier-balances")).toBe(true);
  });

  test("home path is the first page the accountant may open", () => {
    expect(homePathForPermissions("accountant", { ...noneAllowed, dashboard: true })).toBe("/reports");
    expect(homePathForPermissions("accountant", { ...noneAllowed, suppliers: true })).toBe("/suppliers");
    expect(homePathForPermissions("accountant", noneAllowed)).toBe("/reports");
    expect(homePathForPermissions("admin", noneAllowed)).toBe("/reports");
  });
});
