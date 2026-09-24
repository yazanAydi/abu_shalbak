import { act } from "react";
import { createRoot } from "react-dom/client";
import PosApprovalWaitingModal from "./PosApprovalWaitingModal";

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

const mockGet = jest.fn();

jest.mock("../../apiClient", () => ({
  __esModule: true,
  default: {
    get: (...args) => mockGet(...args),
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
    mockGet.mockResolvedValue({ data: { id: 1, status: "pending" } });
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
});
