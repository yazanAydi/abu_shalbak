import { getToken, getUser, removeToken, setToken, setUser } from "./auth";

function fakeJwt(role, username) {
  const payload = btoa(JSON.stringify({ role, username }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `e30.${payload}.sig`;
}

describe("office session storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("writes and reads only office keys", () => {
    setToken("office-token");
    setUser({ username: "admin", role: "admin" });
    expect(localStorage.getItem("office.token")).toBe("office-token");
    expect(JSON.parse(localStorage.getItem("office.user")).username).toBe("admin");
    expect(localStorage.getItem("token")).toBeNull();
    expect(localStorage.getItem("user")).toBeNull();
    expect(localStorage.getItem("pos.token")).toBeNull();
    expect(getToken()).toBe("office-token");
    expect(getUser().username).toBe("admin");
  });

  test("adopts a legacy admin token and leaves POS keys alone", () => {
    const legacy = fakeJwt("admin", "admin");
    localStorage.setItem("token", legacy);
    localStorage.setItem("user", JSON.stringify({ username: "admin", role: "admin" }));
    localStorage.setItem("pos.token", "cashier-stays");
    localStorage.setItem("pos.user", JSON.stringify({ username: "cashier1", role: "cashier" }));

    expect(getToken()).toBe(legacy);
    expect(getUser()).toEqual({ username: "admin", role: "admin" });
    expect(localStorage.getItem("office.token")).toBe(legacy);
    expect(localStorage.getItem("token")).toBeNull();
    expect(localStorage.getItem("user")).toBeNull();
    expect(localStorage.getItem("pos.token")).toBe("cashier-stays");
    expect(JSON.parse(localStorage.getItem("pos.user")).username).toBe("cashier1");
  });

  test("does not adopt a legacy cashier token", () => {
    const legacy = fakeJwt("cashier", "cashier1");
    localStorage.setItem("token", legacy);
    localStorage.setItem("user", JSON.stringify({ username: "cashier1", role: "cashier" }));

    expect(getToken()).toBeNull();
    expect(getUser()).toBeNull();
    expect(localStorage.getItem("token")).toBe(legacy);
    expect(localStorage.getItem("office.token")).toBeNull();
  });

  test("login and logout do not replace a POS session or a cashier legacy token", () => {
    const cashierLegacy = fakeJwt("cashier", "cashier1");
    localStorage.setItem("token", cashierLegacy);
    localStorage.setItem("user", JSON.stringify({ username: "cashier1", role: "cashier" }));
    localStorage.setItem("pos.token", "pos-live");
    localStorage.setItem("pos.user", JSON.stringify({ username: "cashier1", role: "cashier" }));

    setToken("new-office");
    setUser({ username: "admin", role: "admin" });
    expect(localStorage.getItem("office.token")).toBe("new-office");
    expect(localStorage.getItem("token")).toBe(cashierLegacy);
    expect(localStorage.getItem("pos.token")).toBe("pos-live");

    removeToken();
    expect(localStorage.getItem("office.token")).toBeNull();
    expect(localStorage.getItem("office.user")).toBeNull();
    expect(localStorage.getItem("token")).toBe(cashierLegacy);
    expect(localStorage.getItem("pos.token")).toBe("pos-live");
    expect(JSON.parse(localStorage.getItem("pos.user")).username).toBe("cashier1");
  });

  test("logout clears a legacy office token that was not migrated yet", () => {
    localStorage.setItem("token", fakeJwt("accountant", "books"));
    localStorage.setItem("user", JSON.stringify({ username: "books", role: "accountant" }));
    removeToken();
    expect(localStorage.getItem("token")).toBeNull();
    expect(localStorage.getItem("user")).toBeNull();
  });
});
