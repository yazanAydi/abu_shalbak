import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import CountAdvanceSection from "./CountAdvanceSection";

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock("../apiClient", () => ({
  __esModule: true,
  default: {
    get: (...args) => mockGet(...args),
    post: (...args) => mockPost(...args),
  },
}));

jest.mock("../utils/auth", () => ({
  getAuthHeaders: () => ({ Authorization: "Bearer test" }),
}));

function setNativeValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function Harness({ onPosted }) {
  const [counts] = useState({ ILS: "77.50", JOD: "2", USD: "1", notes: "عدّ يدوي" });
  const [advances, setAdvances] = useState([]);
  const [expected, setExpected] = useState(77.5);
  return (
    <div>
      <output data-testid="expected">{expected}</output>
      <output data-testid="ils">{counts.ILS}</output>
      <output data-testid="notes">{counts.notes}</output>
      <CountAdvanceSection
        shiftId={4}
        advances={advances}
        advancesTotal={advances.reduce((sum, row) => sum + Number(row.amount || 0), 0)}
        onPosted={async () => {
          setExpected(57.5);
          setAdvances([{ request_id: 9, amount: 20, employee_name: "سامي" }]);
          await onPosted?.();
        }}
      />
    </div>
  );
}

describe("CountAdvanceSection", () => {
  let container;
  let root;

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockGet.mockResolvedValue({ data: [{ id: 9, name: "سامي", display_name: "سامي" }] });
    mockPost.mockResolvedValue({
      data: { request_id: 9, amount: 20, replayed: false },
    });
    window.HTMLElement.prototype.scrollIntoView = jest.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test("cancel writes nothing and keeps typed count values", async () => {
    await act(async () => {
      root.render(<Harness />);
    });
    const openBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent.includes("تسجيل سلف من هذه الوردية")
    );
    await act(async () => openBtn.click());
    await flush();
    const cancel = [...container.querySelectorAll("button")].find((b) => b.textContent.trim() === "إلغاء");
    await act(async () => cancel.click());
    expect(mockPost).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="ils"]').textContent).toBe("77.50");
    expect(container.querySelector('[data-testid="notes"]').textContent).toBe("عدّ يدوي");
    expect(container.querySelector('[data-testid="expected"]').textContent).toBe("77.5");
  });

  test("posts once and leaves counted text untouched after expected cash refresh", async () => {
    const onPosted = jest.fn();
    await act(async () => {
      root.render(<Harness onPosted={onPosted} />);
    });
    const openBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent.includes("تسجيل سلف من هذه الوردية")
    );
    await act(async () => openBtn.click());
    await flush();
    const combo = container.querySelector('input[role="combobox"]');
    act(() => combo.focus());
    await flush();
    const option = [...document.querySelectorAll(".ui-combobox__option")].find((el) =>
      el.textContent.includes("سامي")
    );
    await act(async () => {
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    const amount = container.querySelector('input[placeholder="0.00"]');
    await act(async () => setNativeValue(amount, "20"));
    const save = [...container.querySelectorAll("button")].find((b) =>
      b.textContent.includes("تسجيل السلفة")
    );
    expect(save.getAttribute("type")).toBe("button");
    await act(async () => save.click());
    await flush();
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [, body] = mockPost.mock.calls[0];
    expect(body.amount).toBe(20);
    expect(body.employee_id).toBe(9);
    expect(String(body.idempotency_key).length).toBeGreaterThanOrEqual(8);
    expect(container.querySelector('[data-testid="expected"]').textContent).toBe("57.5");
    expect(container.querySelector('[data-testid="ils"]').textContent).toBe("77.50");
    expect(container.textContent).toContain("طلب #9");
    expect(onPosted).toHaveBeenCalled();
  });
});
