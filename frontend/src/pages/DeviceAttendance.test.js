import { act } from "react";
import { createRoot } from "react-dom/client";
import DeviceAttendance from "./DeviceAttendance";
import { ToastProvider } from "../components/ui";

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

const mockGet = jest.fn();
const mockPut = jest.fn();
const mockPost = jest.fn();

jest.mock("../apiClient", () => ({
  __esModule: true,
  default: {
    get: (...args) => mockGet(...args),
    put: (...args) => mockPut(...args),
    post: (...args) => mockPost(...args),
  },
}));

jest.mock("../utils/auth", () => ({
  getAuthHeaders: () => ({ Authorization: "Bearer test" }),
}));

describe("DeviceAttendance cutover save", () => {
  let container;
  let root;

  beforeEach(() => {
    mockGet.mockReset();
    mockPut.mockReset();
    mockPost.mockReset();
    mockGet.mockResolvedValue({
      data: {
        enabled: false,
        cutover: "2026-10-03",
        users: [],
        trackable_employees: [],
      },
    });
    mockPut.mockResolvedValue({ data: { cutover: "2026-10-03" } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderPage() {
    await act(async () => {
      root.render(
        <ToastProvider>
          <DeviceAttendance />
        </ToastProvider>
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  test("حفظ التاريخ sends the loaded date string, not the click event", async () => {
    await renderPage();

    const datePicker = container.querySelector(".ui-date input[type='date']");
    expect(datePicker.value).toBe("2026-10-03");

    const saveBtn = [...container.querySelectorAll("button")].find((button) => button.textContent === "حفظ التاريخ");
    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockPut).toHaveBeenCalledTimes(1);
    const [url, body] = mockPut.mock.calls[0];
    expect(url).toBe("/api/attendance/device/cutover");
    expect(body).toEqual({ cutover: "2026-10-03" });
    expect(() => JSON.stringify(body)).not.toThrow();
    expect(typeof body.cutover).toBe("string");
  });

  test("a typed cutover date is the payload, and clearing sends an empty string", async () => {
    await renderPage();

    const dateText = container.querySelector(".ui-date input[type='text']");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    await act(async () => {
      dateText.focus();
      setter.call(dateText, "01/10/26");
      dateText.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector(".ui-date input[type='date']").value).toBe("2026-10-01");

    const saveBtn = [...container.querySelectorAll("button")].find((button) => button.textContent === "حفظ التاريخ");
    await act(async () => {
      saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockPut.mock.calls[0][1]).toEqual({ cutover: "2026-10-01" });
    expect(() => JSON.stringify(mockPut.mock.calls[0][1])).not.toThrow();

    mockPut.mockResolvedValueOnce({ data: { cutover: null } });
    mockGet.mockResolvedValue({
      data: { enabled: false, cutover: "", users: [], trackable_employees: [] },
    });
    const clearBtn = [...container.querySelectorAll("button")].find((button) => button.textContent === "إلغاء الاعتماد");
    await act(async () => {
      clearBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockPut.mock.calls[1][1]).toEqual({ cutover: "" });
  });
});
