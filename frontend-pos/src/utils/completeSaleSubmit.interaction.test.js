import { act, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { checkoutInitialState, checkoutReducer } from "./checkoutCartReducer";
import {
  IDEMPOTENCY_REUSE_AR,
  MISSING_ON_ACCOUNT_CUSTOMER,
  SUSPENDED_ALREADY_COMPLETED_AR,
  checkoutAttemptSignature,
  submitCompleteSale,
} from "./completeSaleSubmit";

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

const mockPost = jest.fn();

jest.mock("../apiClient", () => ({
  __esModule: true,
  default: {
    post: (...args) => mockPost(...args),
    get: jest.fn(),
    put: jest.fn(),
  },
}));

jest.mock("./auth", () => ({
  getAuthHeaders: () => ({ Authorization: "Bearer test" }),
}));

const mockPrintReceipt = jest.fn(async () => ({ ok: true }));

jest.mock("./printReceipt", () => ({
  printReceipt: (...args) => mockPrintReceipt(...args),
  saleSavedPrintFailedMessage: (n, detail) =>
    `تم حفظ عملية البيع رقم ${n}، لكن تعذّرت طباعة الإيصال. لا تُعد إدخال البيع.${detail ? ` ${detail}` : ""}`,
}));

jest.mock("./posSounds", () => ({
  playCheckoutDone: jest.fn(),
  unlockPosAudio: jest.fn(),
}));

jest.mock("./posWaitingRequests", () => ({
  writeWaitingRequestId: jest.fn(),
}));

jest.mock("./focusBarcodeInput", () => ({
  focusBarcodeInput: jest.fn(),
}));

const CART = [
  {
    id: 11,
    unitId: 1,
    quantity: 2,
    price: 5,
    name: "خبز",
  },
];

function OnAccountRetryHarness() {
  const [state, dispatch] = useReducer(checkoutReducer, {
    ...checkoutInitialState,
    cartItems: CART,
  });
  const [customerId, setCustomerId] = useState(null);
  const [employeeId, setEmployeeId] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const isSubmittingRef = useRef(false);
  const idempotencyKeyRef = useRef(null);
  const submittedPayloadRef = useRef(null);
  const noop = () => {};

  async function onComplete() {
    await submitCompleteSale({
      paymentPayload: { payment_method: "on_account" },
      selectedPayment: "on_account",
      cartItems: CART,
      customerId,
      employeeId,
      isLoading,
      isSubmittingRef,
      idempotencyKeyRef,
      submittedPayloadRef,
      activeSuspendedSaleId: null,
      dispatch,
      setIsLoading,
      setOnAccountWaitingId: noop,
      setPayModalOpen: noop,
      setSelectedPayment: noop,
      setCustomerId,
      setEmployeeId,
      setActiveSuspendedSaleId: noop,
      loadShift: noop,
      loadSuspendedList: noop,
      syncSuspendedCart: jest.fn(),
    });
  }

  return (
    <div dir="rtl" lang="ar">
      {state.error ? <p className="pos-err">{state.error}</p> : null}
      <button type="button" onClick={() => setCustomerId(42)}>
        اختر العميل
      </button>
      <button type="button" onClick={() => setEmployeeId(7)}>
        اختر الموظف
      </button>
      <button type="button" onClick={() => void onComplete()}>
        إتمام البيع
      </button>
    </div>
  );
}

describe("on-account checkout lock interaction", () => {
  let container;
  let root;

  beforeEach(() => {
    mockPost.mockReset();
    mockPrintReceipt.mockReset();
    mockPrintReceipt.mockResolvedValue({ ok: true });
    mockPost.mockResolvedValue({
      data: {
        transaction_id: 99,
        receipt_number: "R-1",
        pending_approval: false,
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<OnAccountRetryHarness />);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  test("missing customer shows Arabic error then retry succeeds without refresh", async () => {
    const completeBtn = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "إتمام البيع"
    );
    const pickCustomerBtn = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "اختر العميل"
    );

    await act(async () => {
      completeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const err = container.querySelector(".pos-err");
    expect(err).toBeTruthy();
    expect(err.textContent).toBe(MISSING_ON_ACCOUNT_CUSTOMER);
    expect(mockPost).not.toHaveBeenCalled();

    await act(async () => {
      pickCustomerBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      completeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockPost).toHaveBeenCalledTimes(1);
    const body = mockPost.mock.calls[0][1];
    expect(body.payment_method).toBe("on_account");
    expect(body.customer_id).toBe(42);
    expect(body.employee_id).toBeUndefined();
    expect(container.querySelector(".pos-err")).toBeNull();
  });

  test("employee selection submits employee_id without a customer_id", async () => {
    const completeBtn = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "إتمام البيع"
    );
    const pickEmployeeBtn = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "اختر الموظف"
    );

    await act(async () => {
      pickEmployeeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      completeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockPost).toHaveBeenCalledTimes(1);
    const body = mockPost.mock.calls[0][1];
    expect(body.payment_method).toBe("on_account");
    expect(body.employee_id).toBe(7);
    expect(body.customer_id).toBeUndefined();
  });
});

describe("checkout conflict codes", () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPrintReceipt.mockReset();
    mockPrintReceipt.mockResolvedValue({ ok: true });
  });

  function ctx() {
    const errors = [];
    return {
      paymentPayload: { payment_method: "cash" },
      selectedPayment: "cash",
      cartItems: CART,
      customerId: null,
      employeeId: null,
      isLoading: false,
      isSubmittingRef: { current: false },
      idempotencyKeyRef: { current: "keep-this-key-xxxx" },
      submittedPayloadRef: { current: null },
      activeSuspendedSaleId: 9,
      dispatch: (action) => {
        if (action.type === "CHECKOUT_ERROR") errors.push(action);
      },
      setIsLoading: jest.fn(),
      setOnAccountWaitingId: jest.fn(),
      setPayModalOpen: jest.fn(),
      setSelectedPayment: jest.fn(),
      setCustomerId: jest.fn(),
      setEmployeeId: jest.fn(),
      setActiveSuspendedSaleId: jest.fn(),
      loadShift: jest.fn(),
      loadSuspendedList: jest.fn(),
      syncSuspendedCart: jest.fn(),
      errors,
    };
  }

  function apiError(code, status = 409) {
    const err = new Error("conflict");
    err.response = { status, data: { error: "x", code } };
    return err;
  }

  test("IDEMPOTENCY_KEY_REUSE keeps the key and does not invent a new POST", async () => {
    mockPost.mockRejectedValueOnce(apiError("IDEMPOTENCY_KEY_REUSE"));
    const args = ctx();
    args.activeSuspendedSaleId = null;
    const out = await submitCompleteSale(args);
    expect(out.code).toBe("IDEMPOTENCY_KEY_REUSE");
    expect(args.idempotencyKeyRef.current).toBe("keep-this-key-xxxx");
    expect(args.errors[0].fallback).toBe(IDEMPOTENCY_REUSE_AR);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  test("SUSPENDED_ALREADY_COMPLETED keeps the key and does not resubmit", async () => {
    mockPost.mockRejectedValueOnce(apiError("SUSPENDED_ALREADY_COMPLETED"));
    const args = ctx();
    const out = await submitCompleteSale(args);
    expect(out.code).toBe("SUSPENDED_ALREADY_COMPLETED");
    expect(args.idempotencyKeyRef.current).toBe("keep-this-key-xxxx");
    expect(args.errors[0].fallback).toBe(SUSPENDED_ALREADY_COMPLETED_AR);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  test("reprint helper is not used for checkout POST", async () => {
    mockPost.mockResolvedValueOnce({
      data: {
        transaction_id: 44,
        receipt_number: "INV-44",
        receipt_html: "<p>خبز</p>",
      },
    });
    const args = ctx();
    args.activeSuspendedSaleId = null;
    await submitCompleteSale(args);
    expect(mockPost.mock.calls.map((c) => c[0])).toEqual(["/api/checkout"]);
    expect(mockPrintReceipt).toHaveBeenCalledTimes(1);
    expect(mockPrintReceipt.mock.calls[0][0]).toMatchObject({ transaction_id: 44 });
  });

  test("checkout failure does not print", async () => {
    mockPost.mockRejectedValueOnce(apiError("IDEMPOTENCY_KEY_REUSE"));
    const args = ctx();
    args.activeSuspendedSaleId = null;
    await submitCompleteSale(args);
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPrintReceipt).not.toHaveBeenCalled();
  });

  test("print starts only after a saved transaction id", async () => {
    mockPost.mockResolvedValueOnce({
      data: { receipt_html: "<p>x</p>", receipt_number: "NO-ID" },
    });
    const args = ctx();
    args.activeSuspendedSaleId = null;
    await submitCompleteSale(args);
    expect(mockPrintReceipt).not.toHaveBeenCalled();
  });

  test("print failure after saved sale does not checkout again", async () => {
    mockPost.mockResolvedValueOnce({
      data: {
        transaction_id: 77,
        receipt_number: "INV-9",
        receipt_html: "<p>x</p>",
      },
    });
    mockPrintReceipt.mockResolvedValueOnce({ ok: false, error: "dispatch failed" });
    const args = ctx();
    args.activeSuspendedSaleId = null;
    const warnings = [];
    const orig = args.dispatch;
    args.dispatch = (action) => {
      orig(action);
      if (action.type === "CHECKOUT_PRINT_WARNING") warnings.push(action);
    };
    await submitCompleteSale(args);
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPrintReceipt).toHaveBeenCalledTimes(1);
    expect(warnings[0].message).toContain("INV-9");
    expect(warnings[0].message).toContain("لا تُعد إدخال البيع");
    expect(warnings[0].message).toContain("dispatch failed");
  });
});

describe("on-account notes payload signature", () => {
  test("empty notes match an omitted notes field", () => {
    const base = {
      items: CART,
      payment_method: "on_account",
      customer_id: 42,
    };
    expect(checkoutAttemptSignature(base)).toBe(checkoutAttemptSignature({ ...base, notes: "" }));
    expect(checkoutAttemptSignature(base)).toBe(checkoutAttemptSignature({ ...base, notes: "  " }));
    expect(checkoutAttemptSignature({ ...base, notes: "ملاحظة" })).not.toBe(
      checkoutAttemptSignature(base)
    );
  });

  test("retry after a server error keeps notes and the same idempotency key", async () => {
    mockPost.mockReset();
    const serverErr = new Error("server");
    serverErr.response = { status: 500, data: { error: "x" } };
    mockPost.mockRejectedValueOnce(serverErr);
    mockPost.mockResolvedValueOnce({ data: { pending_approval: true, request_id: 11 } });

    const args = {
      paymentPayload: { payment_method: "on_account", notes: "ملاحظة الذمة" },
      selectedPayment: "on_account",
      cartItems: CART,
      customerId: 42,
      employeeId: null,
      isLoading: false,
      isSubmittingRef: { current: false },
      idempotencyKeyRef: { current: null },
      submittedPayloadRef: { current: null },
      activeSuspendedSaleId: null,
      dispatch: jest.fn(),
      setIsLoading: jest.fn(),
      setOnAccountWaitingId: jest.fn(),
      setPayModalOpen: jest.fn(),
      setSelectedPayment: jest.fn(),
      setCustomerId: jest.fn(),
      setEmployeeId: jest.fn(),
      setActiveSuspendedSaleId: jest.fn(),
      loadShift: jest.fn(),
      loadSuspendedList: jest.fn(),
      syncSuspendedCart: jest.fn(),
    };

    await submitCompleteSale(args);
    expect(args.idempotencyKeyRef.current).toBeTruthy();
    expect(mockPost.mock.calls[0][1].notes).toBe("ملاحظة الذمة");
    const key = args.idempotencyKeyRef.current;

    await submitCompleteSale(args);
    expect(mockPost.mock.calls[1][1].idempotency_key).toBe(key);
    expect(mockPost.mock.calls[1][1].notes).toBe("ملاحظة الذمة");
  });

  test("changing notes after an error mints a new idempotency key", async () => {
    mockPost.mockReset();
    const serverErr = new Error("server");
    serverErr.response = { status: 500, data: { error: "x" } };
    mockPost.mockRejectedValueOnce(serverErr);
    mockPost.mockRejectedValueOnce(serverErr);

    const args = {
      paymentPayload: { payment_method: "on_account", notes: "أولى" },
      selectedPayment: "on_account",
      cartItems: CART,
      customerId: 42,
      employeeId: null,
      isLoading: false,
      isSubmittingRef: { current: false },
      idempotencyKeyRef: { current: null },
      submittedPayloadRef: { current: null },
      activeSuspendedSaleId: null,
      dispatch: jest.fn(),
      setIsLoading: jest.fn(),
      setOnAccountWaitingId: jest.fn(),
      setPayModalOpen: jest.fn(),
      setSelectedPayment: jest.fn(),
      setCustomerId: jest.fn(),
      setEmployeeId: jest.fn(),
      setActiveSuspendedSaleId: jest.fn(),
      loadShift: jest.fn(),
      loadSuspendedList: jest.fn(),
      syncSuspendedCart: jest.fn(),
    };

    await submitCompleteSale(args);
    const firstKey = args.idempotencyKeyRef.current;
    args.paymentPayload = { payment_method: "on_account", notes: "ثانية" };
    await submitCompleteSale(args);
    expect(args.idempotencyKeyRef.current).toBeTruthy();
    expect(args.idempotencyKeyRef.current).not.toBe(firstKey);
    expect(mockPost.mock.calls[1][1].notes).toBe("ثانية");
  });
});
