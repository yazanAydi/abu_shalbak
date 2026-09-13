import { act } from "react";
import { createRoot } from "react-dom/client";
import Login from "./Login";

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

const mockNavigate = jest.fn();
const mockPost = jest.fn();

jest.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams()],
}));

jest.mock("../apiClient", () => ({
  __esModule: true,
  default: {
    post: (...args) => mockPost(...args),
  },
}));

jest.mock("../utils/appLinks", () => ({
  getPosLoginUrl: () => "/pos/login",
}));

describe("Office login password-change recovery", () => {
  let container;
  let root;

  beforeEach(() => {
    mockNavigate.mockReset();
    mockPost.mockReset();
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<Login />);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  test("must-change login shows Arabic form then restores access after change", async () => {
    mockPost.mockResolvedValueOnce({
      data: {
        token: "tok",
        user: { id: 2, username: "a1", role: "admin", must_change_password: true, permissions: {} },
      },
    });
    mockPost.mockResolvedValueOnce({ data: { success: true } });

    const setInput = (el, value) => {
      const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      proto.set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const inputs = container.querySelectorAll("input");
    act(() => {
      setInput(inputs[0], "a1");
      setInput(inputs[1], "oldadmin1");
    });
    const loginBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "دخول");
    await act(async () => {
      loginBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("يجب تغيير كلمة المرور");
    expect(mockNavigate).not.toHaveBeenCalled();

    const pwInputs = container.querySelectorAll("input[type='password']");
    act(() => {
      setInput(pwInputs[0], "oldadmin1");
      setInput(pwInputs[1], "newadmin1");
      setInput(pwInputs[2], "newadmin1");
    });
    const saveBtn = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "حفظ كلمة المرور"
    );
    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockPost.mock.calls[1][0]).toBe("/api/auth/change-password");
    expect(mockNavigate).toHaveBeenCalled();
  });
});
