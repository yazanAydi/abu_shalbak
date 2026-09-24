import { act } from "react";
import { createRoot } from "react-dom/client";
import PosPaymentModal from "./PosPaymentModal";

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

const mockGet = jest.fn();

jest.mock("../../apiClient", () => ({
  __esModule: true,
  default: {
    get: (...args) => mockGet(...args),
    post: jest.fn(),
  },
}));

jest.mock("../../utils/auth", () => ({
  getAuthHeaders: () => ({ Authorization: "Bearer test" }),
}));

function setNativeValue(el, value) {
  const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
  proto.set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(el, value) {
  const proto = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value");
  proto.set.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("POS mixed payment rows", () => {
  let container;
  let root;
  const onTarhil = jest.fn();

  beforeEach(() => {
    mockGet.mockReset();
    onTarhil.mockReset();
    mockGet.mockImplementation((url) => {
      if (String(url).includes("/currencies")) {
        return Promise.resolve({
          data: {
            currencies: [{ id: 1, code: "NIS", symbol: "₪", is_base: 1, exchange_rate_to_nis: 1 }],
          },
        });
      }
      return Promise.resolve({ data: [] });
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderModal(props = {}) {
    act(() => {
      root.render(
        <PosPaymentModal
          open
          total={45}
          selectedPayment="mixed"
          onSelectPayment={jest.fn()}
          customerId={null}
          onSelectCustomer={jest.fn()}
          employeeId={null}
          onSelectEmployee={jest.fn()}
          error={null}
          isLoading={false}
          onTarhil={onTarhil}
          onClose={jest.fn()}
          {...props}
        />
      );
    });
  }

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function methods() {
    return [...container.querySelectorAll('[aria-label^="طريقة الدفع"]')].map((el) => el.value);
  }

  function amounts() {
    return [...container.querySelectorAll('[aria-label^="مبلغ الدفع"]')];
  }

  test("opens with empty Visa and cash rows in NIS", async () => {
    renderModal();
    const lines = container.querySelectorAll(".pos-mixed-line");
    expect(lines.length).toBe(2);
    expect(methods()).toEqual(["visa", "cash"]);
    expect(amounts().map((el) => el.value)).toEqual(["", ""]);
    expect(amounts().map((el) => el.getAttribute("placeholder"))).toEqual(["0.00", "0.00"]);
    await flush();
    const currencies = [...container.querySelectorAll('[aria-label^="عملة الدفع"]')];
    expect(currencies.map((el) => el.selectedOptions[0].textContent)).toEqual([
      "₪ NIS",
      "₪ NIS",
    ]);
  });

  test("switching either method swaps the pair and keeps amounts and focus", async () => {
    renderModal();
    await flush();
    setNativeValue(amounts()[0], "20");
    await flush();
    const firstMethod = container.querySelector('[aria-label="طريقة الدفع 1"]');
    firstMethod.focus();
    setSelectValue(firstMethod, "cash");
    await flush();
    expect(methods()).toEqual(["cash", "visa"]);
    expect(amounts().map((el) => el.value)).toEqual(["20", "25.00"]);
    expect(document.activeElement).toBe(container.querySelector('[aria-label="طريقة الدفع 1"]'));

    const secondMethod = container.querySelector('[aria-label="طريقة الدفع 2"]');
    secondMethod.focus();
    setSelectValue(secondMethod, "cash");
    await flush();
    expect(methods()).toEqual(["visa", "cash"]);
    expect(amounts().map((el) => el.value)).toEqual(["20", "25.00"]);
    expect(document.activeElement).toBe(container.querySelector('[aria-label="طريقة الدفع 2"]'));
  });

  test("either amount fills the opposite remainder and typing keeps focus", async () => {
    renderModal();
    await flush();
    const first = amounts()[0];
    first.focus();
    setNativeValue(first, "20");
    await flush();
    expect(document.activeElement).toBe(container.querySelector('[aria-label="مبلغ الدفع 1"]'));
    expect(amounts().map((el) => el.value)).toEqual(["20", "25.00"]);

    const second = amounts()[1];
    second.focus();
    setNativeValue(second, "10");
    await flush();
    expect(document.activeElement).toBe(container.querySelector('[aria-label="مبلغ الدفع 2"]'));
    expect(amounts().map((el) => el.value)).toEqual(["35.00", "10"]);
  });

  test("rejects negative and over-total amounts without changing them or the other row", async () => {
    renderModal();
    await flush();
    setNativeValue(amounts()[0], "20");
    await flush();
    setNativeValue(amounts()[0], "50");
    await flush();
    expect(amounts().map((el) => el.value)).toEqual(["50", "25.00"]);
    expect(container.querySelector(".shift-modal-err")?.textContent).toBe(
      "المبلغ أكبر من إجمالي الفاتورة"
    );
    expect(container.querySelector(".pos-payment-modal-tarhil").disabled).toBe(true);

    setNativeValue(amounts()[0], "-5");
    await flush();
    expect(amounts()[0].value).toBe("-5");
    expect(amounts()[1].value).toBe("25.00");
    expect(container.querySelector(".shift-modal-err")?.textContent).toBe(
      "لا يمكن إدخال مبلغ سالب"
    );
  });

  test("extra rows stop automatic redistribution and show the unpaid remainder", async () => {
    renderModal();
    await flush();
    setNativeValue(amounts()[0], "20");
    await flush();
    await act(async () => {
      container.querySelector(".pos-mixed-add").click();
    });
    expect(container.querySelectorAll(".pos-mixed-line").length).toBe(3);
    setNativeValue(amounts()[0], "15");
    await flush();
    expect(amounts().map((el) => el.value)).toEqual(["15", "25.00", ""]);
    expect(container.textContent).toContain("المتبقي: ₪5.00");
  });

  test("posting sends the cash and visa shares once", async () => {
    renderModal();
    await flush();
    setNativeValue(amounts()[0], "20");
    await flush();
    const button = container.querySelector(".pos-payment-modal-tarhil");
    expect(button.disabled).toBe(false);
    await act(async () => {
      button.click();
      button.click();
    });
    expect(onTarhil).toHaveBeenCalledTimes(1);
    expect(onTarhil.mock.calls[0][0].payments).toEqual([
      { method: "visa", currency_id: 1, original_amount: 20 },
      { method: "cash", currency_id: 1, original_amount: 25 },
    ]);
  });
});
