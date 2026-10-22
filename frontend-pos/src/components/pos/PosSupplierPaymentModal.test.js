import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import PosSupplierPaymentModal from "./PosSupplierPaymentModal";

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock("../../apiClient", () => ({
  __esModule: true,
  default: {
    get: (...args) => mockGet(...args),
    post: (...args) => mockPost(...args),
  },
}));

jest.mock("../../utils/auth", () => ({
  getAuthHeaders: () => ({ Authorization: "Bearer test" }),
}));

function setNativeValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function Harness({ onPaid }) {
  const [open, setOpen] = useState(true);
  const [cart] = useState(["خبز"]);
  return (
    <div>
      <output data-testid="cart">{cart.join(",")}</output>
      <PosSupplierPaymentModal open={open} onClose={() => setOpen(false)} onPaid={onPaid} />
      {!open ? <output data-testid="closed">closed</output> : null}
    </div>
  );
}

describe("PosSupplierPaymentModal", () => {
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
    mockGet.mockImplementation((url) => {
      if (String(url).includes("/customers/4")) {
        return Promise.resolve({ data: { id: 4, name: "أحمد", outstanding: 80 } });
      }
      if (String(url).includes("/customers")) {
        return Promise.resolve({ data: [{ id: 4, name: "أحمد" }] });
      }
      return Promise.resolve({ data: [{ id: 9, name: "مورد الألبان" }] });
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

  test("searches suppliers, keeps amount focus for 77.50, and cancel leaves the cart", async () => {
    await act(async () => {
      root.render(<Harness />);
    });
    await flush();
    expect(container.textContent).toContain("سيتم خصم المبلغ من نقد الوردية وتسجيل سند صرف للمورد");
    const combo = container.querySelector('input[role="combobox"]');
    act(() => combo.focus());
    await flush();
    expect(container.textContent).toContain("مورد الألبان");

    const amount = container.querySelector('input[placeholder="0.00"]');
    const node = amount;
    amount.focus();
    let typed = "";
    for (const ch of "77.50") {
      typed += ch;
      act(() => setNativeValue(amount, typed));
      expect(document.activeElement).toBe(node);
      expect(container.querySelector('input[placeholder="0.00"]')).toBe(node);
    }
    expect(amount.value).toBe("77.50");
    expect(container.querySelector('[data-testid="cart"]').textContent).toBe("خبز");

    const cancel = [...container.querySelectorAll("button")].find((b) => b.textContent === "إلغاء");
    act(() => cancel.click());
    expect(container.querySelector('[data-testid="cart"]').textContent).toBe("خبز");
    expect(container.querySelector('[data-testid="closed"]').textContent).toBe("closed");
    expect(mockPost).not.toHaveBeenCalled();
  });

  test("successful submit keeps the cart and shows the voucher", async () => {
    const onPaid = jest.fn();
    mockPost.mockResolvedValue({
      data: { supplier_name: "مورد الألبان", amount: 77.5, voucher_no: 12, replayed: false },
    });
    await act(async () => {
      root.render(<Harness onPaid={onPaid} />);
    });
    await flush();
    const amount = container.querySelector('input[placeholder="0.00"]');
    act(() => setNativeValue(amount, "77.50"));
    const combo = container.querySelector('input[role="combobox"]');
    act(() => combo.focus());
    const dairy = [...container.querySelectorAll("li")].find((el) => el.textContent.includes("مورد الألبان"));
    act(() => {
      dairy.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    const confirm = [...container.querySelectorAll("button")].find((b) => b.textContent === "تأكيد الدفع");
    await act(async () => {
      confirm.click();
    });
    expect(onPaid).toHaveBeenCalled();
    expect(container.textContent).toContain("سند صرف #12");
    expect(container.querySelector('[data-testid="cart"]').textContent).toBe("خبز");
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][1].amount).toBe(77.5);
    expect(mockPost.mock.calls[0][1].idempotency_key).toBeTruthy();
  });

  test("customer tab searches in Arabic, types a decimal, and cancel keeps the cart", async () => {
    mockGet.mockImplementation((url) => {
      if (String(url).includes("/customers/")) {
        return Promise.resolve({ data: { id: 4, name: "أحمد الذمة", outstanding: 100 } });
      }
      if (String(url).includes("/customers")) {
        return Promise.resolve({
          data: [
            { id: 4, name: "أحمد الذمة" },
            { id: 5, name: "سامي نقد" },
          ],
        });
      }
      return Promise.resolve({ data: [{ id: 9, name: "مورد الألبان" }] });
    });
    await act(async () => {
      root.render(<Harness />);
    });
    await flush();
    const customerTab = [...container.querySelectorAll("button")].find((b) => b.textContent === "ذمم عملاء نقدي");
    await act(async () => {
      customerTab.click();
    });
    expect(mockPost).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "طلب صرف نقد للعميل على الذمة. بعد الموافقة، يزداد رصيد ذمة العميل ويُخصم المبلغ من نقد الوردية"
    );

    const combo = container.querySelector('input[role="combobox"]');
    act(() => combo.focus());
    await flush();
    act(() => setNativeValue(combo, "أحمد"));
    await flush();
    expect(container.textContent).toContain("أحمد الذمة");
    expect(container.textContent).not.toContain("سامي نقد");
    const ahmad = [...container.querySelectorAll("li")].find((el) => el.textContent.includes("أحمد الذمة"));
    act(() => {
      ahmad.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain("الذمة الحالية");

    const amount = container.querySelector('input[placeholder="0.00"]');
    let typed = "";
    amount.focus();
    for (const ch of "30.50") {
      typed += ch;
      act(() => setNativeValue(amount, typed));
      expect(document.activeElement).toBe(amount);
    }
    expect(amount.value).toBe("30.50");
    const cancel = [...container.querySelectorAll("button")].find((b) => b.textContent === "إلغاء");
    act(() => cancel.click());
    expect(container.querySelector('[data-testid="cart"]').textContent).toBe("خبز");
    expect(mockPost).not.toHaveBeenCalled();
  });

  test("a pending collection blocks the other tab and a success keeps the cart", async () => {
    let release;
    mockPost.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    mockGet.mockImplementation((url) => {
      if (String(url).includes("/customers/")) {
        return Promise.resolve({ data: { id: 4, name: "أحمد الذمة", outstanding: 100 } });
      }
      if (String(url).includes("/customers")) {
        return Promise.resolve({ data: [{ id: 4, name: "أحمد الذمة" }] });
      }
      return Promise.resolve({ data: [{ id: 9, name: "مورد الألبان" }] });
    });
    await act(async () => {
      root.render(<Harness />);
    });
    await flush();
    const customerTab = [...container.querySelectorAll('[role="tab"]')].find((b) =>
      b.textContent.includes("ذمم")
    );
    const supplierTab = [...container.querySelectorAll('[role="tab"]')].find((b) =>
      b.textContent.includes("دفع لمورد")
    );
    act(() => customerTab.click());
    await flush();
    const combo = container.querySelector('input[role="combobox"]');
    act(() => combo.focus());
    await flush();
    const ahmad = [...container.querySelectorAll("li")].find((el) => el.textContent.includes("أحمد الذمة"));
    act(() => {
      ahmad.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    act(() => setNativeValue(container.querySelector('input[placeholder="0.00"]'), "30"));
    const confirm = [...container.querySelectorAll("button")].find((b) => b.textContent === "إرسال طلب الموافقة");
    await act(async () => {
      confirm.click();
    });
    expect(customerTab.disabled).toBe(true);
    expect(supplierTab.disabled).toBe(true);
    act(() => supplierTab.click());
    expect(container.querySelector("#pos-panel-customer")).toBeTruthy();
    await act(async () => {
      release({
        data: {
          request_id: 15,
          customer_name: "أحمد الذمة",
          amount: 30,
          status: "pending",
          replayed: false,
        },
      });
    });
    await flush();
    expect(container.textContent).toContain("بانتظار الموافقة — لا تسلّم المبلغ قبل الموافقة");
    expect(container.querySelector('[data-testid="cart"]').textContent).toBe("خبز");
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][0]).toContain("/customer-cash-debt-requests");
  });

  test("opening the dialog keeps the keyboard in its fields and restores the scanner on close", async () => {
    mockGet.mockImplementation(() => new Promise(() => {}));
    window.HTMLMediaElement.prototype.play = () => Promise.resolve();
    const add = jest.spyOn(window, "addEventListener");
    const remove = jest.spyOn(window, "removeEventListener");
    function keyCount(spy) {
      return spy.mock.calls.filter((call) => call[0] === "keydown").length;
    }

    function Screen() {
      const [open, setOpen] = useState(true);
      return (
        <div className="pos-screen">
          <input className="barcode-input" defaultValue="625" />
          <button type="button" onClick={() => setOpen(true)}>
            موردين/ذمم
          </button>
          <PosSupplierPaymentModal open={open} onClose={() => setOpen(false)} />
        </div>
      );
    }

    await act(async () => {
      root.render(<Screen />);
    });
    await flush();

    const barcode = container.querySelector(".barcode-input");
    const supplierSearch = container.querySelector("input[role='combobox']");
    expect(supplierSearch.disabled).toBe(false);
    expect(supplierSearch.placeholder).toContain("جاري تحميل الموردين");
    expect(document.activeElement).toBe(supplierSearch);
    expect(barcode.inert).toBe(true);

    const seen = jest.fn();
    barcode.addEventListener("keydown", seen);
    barcode.focus();
    const scan = new KeyboardEvent("keydown", { key: "9", bubbles: true, cancelable: true });
    act(() => {
      barcode.dispatchEvent(scan);
    });
    expect(scan.defaultPrevented).toBe(true);
    expect(seen).not.toHaveBeenCalled();
    expect(barcode.value).toBe("625");
    expect(document.activeElement.closest("[role='dialog']")).toBeTruthy();
    expect(document.activeElement.disabled).toBe(false);

    const amount = container.querySelector('input[placeholder="0.00"]');
    amount.focus();
    act(() => setNativeValue(amount, "15.50"));
    expect(amount.value).toBe("15.50");
    expect(document.activeElement).toBe(amount);
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    amount.dispatchEvent(enter);
    expect(document.activeElement.getAttribute("maxlength")).toBe("500");
    expect(document.activeElement).not.toBe(amount);

    const cancel = [...container.querySelectorAll("button")].find((b) => b.textContent === "إلغاء");
    cancel.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    cancel.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement.textContent).toContain("دفع لمورد");

    const customerTab = [...container.querySelectorAll('[role="tab"]')].find((b) =>
      b.textContent.includes("ذمم")
    );
    await act(async () => {
      customerTab.click();
    });
    const customerSearch = container.querySelector("input[role='combobox']");
    expect(customerSearch.disabled).toBe(false);
    expect(customerSearch.placeholder).toContain("جاري تحميل العملاء");
    expect(document.activeElement).toBe(customerSearch);

    const closeList = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      document.activeElement.dispatchEvent(closeList);
    });
    expect(container.querySelector("[role='dialog']")).toBeTruthy();
    expect(container.querySelector(".ui-combobox__list")).toBeNull();

    await act(async () => {
      document.activeElement.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
    });
    expect(container.querySelector("[role='dialog']")).toBeNull();
    expect(barcode.inert).toBe(false);
    expect(document.activeElement).toBe(barcode);
    const after = new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true });
    barcode.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);

    const afterFirstClose = keyCount(add);
    expect(keyCount(remove)).toBe(afterFirstClose);

    await act(async () => {
      container.querySelector("button").click();
    });
    await flush();
    expect(container.querySelector("input[role='combobox']").disabled).toBe(false);
    expect(document.activeElement).toBe(container.querySelector("input[role='combobox']"));

    await act(async () => {
      [...container.querySelectorAll("button")].find((b) => b.textContent === "إلغاء").click();
    });
    expect(keyCount(add)).toBe(keyCount(remove));
    expect(keyCount(add)).toBe(afterFirstClose + 1);
    expect(barcode.inert).toBe(false);
    expect(document.activeElement).toBe(barcode);
    barcode.removeEventListener("keydown", seen);
    add.mockRestore();
    remove.mockRestore();
  });
});
