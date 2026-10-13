import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import PosPreviousSalesModal from "./PosPreviousSalesModal";

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPut = jest.fn();
const mockDelete = jest.fn();

jest.mock("../../apiClient", () => ({
  __esModule: true,
  default: {
    get: (...args) => mockGet(...args),
    post: (...args) => mockPost(...args),
    put: (...args) => mockPut(...args),
    delete: (...args) => mockDelete(...args),
  },
}));

jest.mock("../../utils/auth", () => ({
  getAuthHeaders: () => ({ Authorization: "Bearer test" }),
}));

const LIST = {
  sales: [
    {
      transaction_id: 41,
      receipt_number: "INV-2026-000041",
      created_at: "2026-04-02 09:30:00",
      total: 10,
      payment_method: "mixed",
      sale_state: "partial_return",
      sale_state_label: "مرتجعة جزئياً",
    },
  ],
  page: 1,
  limit: 20,
  total: 1,
  page_count: 1,
};

const DETAIL = {
  transaction_id: 41,
  receipt_number: "INV-2026-000041",
  created_at: "2026-04-02 09:30:00",
  business_day: "2026-04-02",
  sale_state: "partial_return",
  sale_state_label: "مرتجعة جزئياً",
  subtotal: 11.25,
  discount: 1.25,
  tax: 0,
  amount_before_rounding: 10.02,
  rounding_adjustment: -0.02,
  total: 10,
  change_amount: 0,
  payment_method: "mixed",
  lines: [
    {
      id: 1,
      name: "اسم محفوظ",
      unit_name: "حبة",
      quantity: 2,
      unit_price: 5.63,
      discount: 1.25,
      line_total: 10,
    },
  ],
  payments: [
    { method: "cash", amount: 6 },
    { method: "visa", amount: 4 },
  ],
  returns: [{ id: 3, kind: "refund", status: "approved", total: 5, payment_method: "cash", created_at: "2026-04-02 10:00:00", lines: [] }],
};

function Harness() {
  const [cart] = useState("خبز|hold-15");
  return (
    <div>
      <output data-testid="cart">{cart}</output>
      <PosPreviousSalesModal open onClose={() => {}} />
    </div>
  );
}

describe("PosPreviousSalesModal", () => {
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
    mockPut.mockReset();
    mockDelete.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test("lists a saved sale and opens its stored lines without touching the cart", async () => {
    mockGet.mockImplementation((url) => {
      if (String(url).includes("/my-sales/41")) return Promise.resolve({ data: DETAIL });
      return Promise.resolve({ data: LIST });
    });
    await act(async () => {
      root.render(<Harness />);
    });
    await flush();
    expect(container.textContent).toContain("الفواتير السابقة");
    expect(container.textContent).toContain("INV-2026-000041");
    expect(container.textContent).toContain("مختلط");
    expect(container.textContent).toContain("مرتجعة جزئياً");
    const view = [...container.querySelectorAll("button")].find((b) => b.textContent === "عرض التفاصيل");
    await act(async () => {
      view.click();
    });
    await flush();
    expect(container.textContent).toContain("اسم محفوظ");
    expect(container.textContent).toContain("1.25");
    expect(container.textContent).toContain("نقدي");
    expect(container.textContent).toContain("فيزا");
    expect(container.textContent).toContain("عرض فقط");
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent.trim());
    expect(labels).not.toContain("حذف");
    expect(labels).not.toContain("استرجاع");
    expect(labels).not.toContain("تعديل");
    expect(container.querySelector("[data-testid=cart]").textContent).toBe("خبز|hold-15");
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockPut).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test("shows an empty list", async () => {
    mockGet.mockResolvedValue({ data: { sales: [], page: 1, limit: 20, total: 0, page_count: 0 } });
    await act(async () => {
      root.render(<Harness />);
    });
    await flush();
    expect(container.textContent).toContain("لا توجد فواتير سابقة");
  });

  test("shows an error and a retry action", async () => {
    mockGet.mockRejectedValue({ response: { data: { error: "تعذّر تحميل الفواتير" } } });
    await act(async () => {
      root.render(<Harness />);
    });
    await flush();
    expect(container.textContent).toContain("تعذّر تحميل الفواتير");
    expect(container.textContent).toContain("إعادة المحاولة");
  });
});
