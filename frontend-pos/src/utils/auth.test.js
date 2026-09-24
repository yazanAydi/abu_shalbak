import { getToken, getUser, removeToken, setToken, setUser } from "./auth";

function fakeJwt(role, username) {
  const payload = btoa(JSON.stringify({ role, username }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `e30.${payload}.sig`;
}

describe("POS session storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("writes and reads only POS keys", () => {
    setToken("pos-token");
    setUser({ username: "cashier1", role: "cashier" });
    expect(localStorage.getItem("pos.token")).toBe("pos-token");
    expect(JSON.parse(localStorage.getItem("pos.user")).username).toBe("cashier1");
    expect(localStorage.getItem("token")).toBeNull();
    expect(localStorage.getItem("user")).toBeNull();
    expect(localStorage.getItem("office.token")).toBeNull();
    expect(getToken()).toBe("pos-token");
    expect(getUser().username).toBe("cashier1");
  });

  test("adopts a legacy cashier token and leaves office keys alone", () => {
    const legacy = fakeJwt("cashier", "cashier1");
    localStorage.setItem("token", legacy);
    localStorage.setItem("user", JSON.stringify({ username: "cashier1", role: "cashier" }));
    localStorage.setItem("office.token", "admin-stays");
    localStorage.setItem("office.user", JSON.stringify({ username: "admin", role: "admin" }));

    expect(getToken()).toBe(legacy);
    expect(getUser()).toEqual({ username: "cashier1", role: "cashier" });
    expect(localStorage.getItem("pos.token")).toBe(legacy);
    expect(localStorage.getItem("token")).toBeNull();
    expect(localStorage.getItem("user")).toBeNull();
    expect(localStorage.getItem("office.token")).toBe("admin-stays");
    expect(JSON.parse(localStorage.getItem("office.user")).username).toBe("admin");
  });

  test("does not adopt a legacy office token", () => {
    const legacy = fakeJwt("admin", "admin");
    localStorage.setItem("token", legacy);
    localStorage.setItem("user", JSON.stringify({ username: "admin", role: "admin" }));

    expect(getToken()).toBeNull();
    expect(getUser()).toBeNull();
    expect(localStorage.getItem("token")).toBe(legacy);
    expect(localStorage.getItem("pos.token")).toBeNull();
  });

  test("login and logout do not replace an office session or an admin legacy token", () => {
    const adminLegacy = fakeJwt("admin", "admin");
    localStorage.setItem("token", adminLegacy);
    localStorage.setItem("user", JSON.stringify({ username: "admin", role: "admin" }));
    localStorage.setItem("office.token", "office-live");
    localStorage.setItem("office.user", JSON.stringify({ username: "admin", role: "admin" }));

    setToken("new-pos");
    setUser({ username: "cashier2", role: "cashier" });
    expect(localStorage.getItem("pos.token")).toBe("new-pos");
    expect(localStorage.getItem("token")).toBe(adminLegacy);
    expect(localStorage.getItem("office.token")).toBe("office-live");

    removeToken();
    expect(localStorage.getItem("pos.token")).toBeNull();
    expect(localStorage.getItem("pos.user")).toBeNull();
    expect(localStorage.getItem("token")).toBe(adminLegacy);
    expect(localStorage.getItem("office.token")).toBe("office-live");
    expect(JSON.parse(localStorage.getItem("office.user")).username).toBe("admin");
  });

  test("logout clears a legacy cashier token that was not migrated yet", () => {
    localStorage.setItem("token", fakeJwt("cashier", "cashier1"));
    localStorage.setItem("user", JSON.stringify({ username: "cashier1", role: "cashier" }));
    removeToken();
    expect(localStorage.getItem("token")).toBeNull();
    expect(localStorage.getItem("user")).toBeNull();
  });
});
