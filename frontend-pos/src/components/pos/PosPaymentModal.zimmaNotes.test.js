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

describe("POS ذمة notes field", () => {
  let container;
  let root;
  const onTarhil = jest.fn();
  const onClose = jest.fn();

  beforeEach(() => {
    mockGet.mockReset();
    onTarhil.mockReset();
    onClose.mockReset();
    mockGet.mockImplementation((url) => {
      if (String(url).includes("/currencies")) {
        return Promise.resolve({
          data: { currencies: [{ id: 1, code: "NIS", symbol: "₪", is_base: 1, exchange_rate_to_nis: 1 }] },
        });
      }
      if (String(url).includes("/employees")) {
        return Promise.resolve({
          data: [{ id: 7, name: "موظف اختبار", display_name: "موظف اختبار", employee_no: "1" }],
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
          total={12.5}
          selectedPayment="on_account"
          onSelectPayment={jest.fn()}
          customerId={null}
          onSelectCustomer={jest.fn()}
          employeeId={null}
          onSelectEmployee={jest.fn()}
          error={null}
          isLoading={false}
          onTarhil={onTarhil}
          onClose={onClose}
          {...props}
        />
      );
    });
  }

  test("shows a small optional notes textarea below the party selector", async () => {
    renderModal();
    await act(async () => {
      await Promise.resolve();
    });
    const label = [...container.querySelectorAll("label")].find((el) =>
      el.textContent.includes("ملاحظات (اختياري)")
    );
    expect(label).toBeTruthy();
    const ta = label.querySelector("textarea");
    expect(ta).toBeTruthy();
    expect(ta.getAttribute("placeholder")).toBe("اكتب ملاحظة عن عملية الذمة…");
    expect(ta.getAttribute("maxLength")).toBe("500");
    const pick = container.querySelector(".pos-customer-pick");
    expect(pick.contains(ta)).toBe(true);
    const party = pick.querySelector(".pos-zimma-party");
    expect(party.compareDocumentPosition(ta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("Enter inserts a newline and does not submit checkout", async () => {
    renderModal();
    await act(async () => {
      await Promise.resolve();
    });
    const ta = container.querySelector("textarea");
    ta.value = "سطر";
    ta.focus();
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(onTarhil).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector(".shift-modal-title")?.textContent).toBe("إتمام البيع");
  });
});
