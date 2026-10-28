import { act } from "react";
import { createRoot } from "react-dom/client";
import PosApprovalWaitingModal from "./PosApprovalWaitingModal";

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

jest.mock("../../utils/posSounds", () => ({
  playApprovalDecision: jest.fn(),
}));

describe("PosApprovalWaitingModal minimized chip", () => {
  let container;
  let root;
  let slot;

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockGet.mockResolvedValue({ data: { id: 1, status: "pending", telegram_message_id: 1 } });
    slot = document.createElement("div");
    slot.id = "pos-waiting-chip-slot";
    slot.className = "pos-waiting-chip-slot";
    document.body.appendChild(slot);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    slot.remove();
  });

  test("hide sends the chip into the footer slot instead of a fixed overlay", async () => {
    await act(async () => {
      root.render(
        <PosApprovalWaitingModal
          open
          requestId={1}
          apiPath="/api/supplier-payment-requests"
          titlePrefix="طلب دفع لمورد"
          statusLabels={{ pending: "بانتظار الموافقة" }}
          onClose={() => {}}
        />
      );
    });
    await flush();

    const hide = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent || "").includes("إخفاء")
    );
    expect(hide).toBeTruthy();

    await act(async () => {
      hide.click();
    });

    const chip = slot.querySelector(".pos-waiting-chip");
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain("بانتظار الموافقة — طلب دفع لمورد #1");
    expect(container.querySelector(".pos-waiting-chip")).toBeNull();
    expect(container.querySelector(".shift-modal-overlay")).toBeNull();
  });

  test("a scan key cannot reach the register, and hide restores the scan field", async () => {
    container.className = "pos-screen";
    await act(async () => {
      root.render(
        <>
          <input className="barcode-input" defaultValue="625" />
          <PosApprovalWaitingModal
            open
            requestId={1}
            apiPath="/api/customer-cash-debt-requests"
            titlePrefix="طلب ذمة نقدية"
            statusLabels={{ pending: "بانتظار الموافقة" }}
            onClose={() => {}}
          />
        </>
      );
    });
    await flush();

    const barcode = container.querySelector(".barcode-input");
    const dialog = container.querySelector("[role='dialog']");
    expect(dialog).toBeTruthy();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(barcode.inert).toBe(true);

    const seen = jest.fn();
    barcode.addEventListener("keydown", seen);
    const scan = new KeyboardEvent("keydown", { key: "9", bubbles: true, cancelable: true });
    act(() => {
      barcode.dispatchEvent(scan);
    });
    expect(scan.defaultPrevented).toBe(true);
    expect(seen).not.toHaveBeenCalled();
    expect(barcode.value).toBe("625");

    const hide = [...dialog.querySelectorAll("button")].find((b) => (b.textContent || "").includes("إخفاء"));
    await act(async () => {
      hide.click();
    });
    expect(container.querySelector("[role='dialog']")).toBeNull();
    expect(barcode.inert).toBe(false);
    expect(document.activeElement).toBe(barcode);
    const after = new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true });
    barcode.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    barcode.removeEventListener("keydown", seen);
  });

  test("queued delivery stays open and a failed send can be retried without a new request", async () => {
    mockGet.mockResolvedValue({
      data: { id: 9, status: "pending", telegram_message_id: null, telegram_delivery: "queued" },
    });
    await act(async () => {
      root.render(
        <PosApprovalWaitingModal
          open
          requestId={9}
          initialTelegram="queued"
          apiPath="/api/advance-requests"
          titlePrefix="طلب سلف"
          statusLabels={{ pending: "بانتظار الموافقة" }}
          onClose={() => {}}
        />
      );
    });
    await flush();
    expect(container.textContent).toContain("جاري إرسال رسالة تيليجرام");
    expect(container.textContent).not.toContain("حُفظ بدون تيليجرام");
    const close = [...container.querySelectorAll("button")].find((b) => b.textContent === "—");
    expect(close.disabled).toBe(true);

    mockGet.mockResolvedValue({
      data: { id: 9, status: "pending", telegram_message_id: null, telegram_delivery: "failed" },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2600));
    });
    expect(container.textContent).toContain("تعذّر إرسال تيليجرام");
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent.includes("إعادة الإرسال"));
    expect(retry).toBeTruthy();
    mockPost.mockResolvedValue({ data: { telegram_delivery: "queued" } });
    mockGet.mockResolvedValue({
      data: { id: 9, status: "pending", telegram_message_id: "41", telegram_delivery: "sent" },
    });
    await act(async () => {
      retry.click();
    });
    await flush();
    expect(mockPost).toHaveBeenCalledWith(
      "/api/telegram/outbound/retry",
      { kind: "advance", request_id: 9 },
      expect.any(Object)
    );
    expect(container.textContent).toContain("بانتظار الموافقة عبر تيليجرام");
    expect([...container.querySelectorAll("button")].find((b) => b.textContent === "—").disabled).toBe(true);

    mockGet.mockResolvedValue({
      data: { id: 9, status: "approved", telegram_message_id: "41", telegram_delivery: "sent" },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2600));
    });
    const done = [...container.querySelectorAll("button")].find((b) => b.textContent === "إغلاق");
    expect(done.disabled).toBe(false);
  }, 10000);
});
