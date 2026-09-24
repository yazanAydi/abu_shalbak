import {
  allAccountantPermissionsDisabled,
  allAccountantPermissionsEnabled,
  defaultAccountantPermissions,
  getEffectivePermissions,
  hasAccountantPermission,
  userHasOfficePermission,
  userHasAccountantPermission,
} from "../utils/accountantPermissions.js";

describe("permission helpers", () => {
  const noneAllowed = allAccountantPermissionsDisabled();

  test("hasAccountantPermission: admin follows an explicit custom map", () => {
    expect(hasAccountantPermission("admin", noneAllowed, "products")).toBe(false);
    expect(hasAccountantPermission("admin", { products: true }, "products")).toBe(true);
    expect(hasAccountantPermission("admin", { products: true }, "finance")).toBe(false);
    expect(hasAccountantPermission("admin", {}, "permissions")).toBe(false);
    expect(hasAccountantPermission("admin", null, "products")).toBe(true);
  });

  test("hasAccountantPermission: accountant follows the map", () => {
    const perms = { ...noneAllowed, customers: true };
    expect(hasAccountantPermission("accountant", perms, "customers")).toBe(true);
    expect(hasAccountantPermission("accountant", perms, "suppliers")).toBe(false);
  });

  test("hasAccountantPermission: other roles never pass", () => {
    const all = allAccountantPermissionsEnabled();
    for (const role of ["cashier", "shelves_employee", "bakery_employee"]) {
      expect(hasAccountantPermission(role, all, "customers")).toBe(false);
    }
  });

  test("getEffectivePermissions: custom map wins; admin without a map is all-on", () => {
    expect(getEffectivePermissions("admin", noneAllowed)).toEqual(noneAllowed);
    expect(getEffectivePermissions("admin", null)).toEqual(allAccountantPermissionsEnabled());
    const partial = getEffectivePermissions("accountant", { products: true });
    expect(partial.products).toBe(true);
    expect(partial.finance).toBe(false);
    expect(partial.refund_approvals).toBe(false);
    expect(getEffectivePermissions("cashier", allAccountantPermissionsEnabled())).toEqual(
      defaultAccountantPermissions()
    );
  });

  test("userHasOfficePermission is an alias of userHasAccountantPermission", () => {
    expect(userHasOfficePermission).toBe(userHasAccountantPermission);
  });
});
