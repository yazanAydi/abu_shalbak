import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import SalesReports from "./SalesReports";
import { ToastProvider } from "../components/ui";

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

const mockGet = jest.fn();

jest.mock("../apiClient", () => ({
  __esModule: true,
  default: {
    get: (...args) => mockGet(...args),
  },
}));

const dailyReport = {
  net_sales: 80,
  total_sales: 90,
  item_revenue: 89.5,
  rounding_adjustment: 0.5,
  total_transactions: 3,
  refunds_total: 10,
  items_sold: 4,
  cost: 40,
  profit: 40,
  cost_unknown: false,
  cash_total: 70,
  card_total: 15,
  on_account_total: 5,
  net_cash_total: 55,
  net_card_total: 15,
  change_total: 12,
  top_products: [],
};

describe("daily POS payment cards", () => {
  let container;
  let root;

  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockResolvedValue({ data: dailyReport });
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
        <MemoryRouter initialEntries={["/sales-reports?date=2026-10-05"]}>
          <ToastProvider>
            <SalesReports />
          </ToastProvider>
        </MemoryRouter>
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  test("drops cash-total and returned-change cards and closes the payment grid", async () => {
    await renderPage();

    const text = container.textContent;
    expect(text).not.toContain("نقد (إجمالي)");
    expect(text).not.toContain("الباقي المُرجَع");
    expect(text).not.toContain("الباقي المُرجع");

    const paymentTitle = [...container.querySelectorAll("h3")].find(
      (el) => el.textContent === "تفاصيل الدفع والتحصيل"
    );
    expect(paymentTitle).toBeTruthy();
    const paymentCard = paymentTitle.closest(".ui-card");
    const stats = [...paymentCard.querySelectorAll(".ui-stat")];
    expect(stats.map((el) => el.querySelector(".ui-stat__label").textContent)).toEqual([
      "مبيعات الفيزا",
      "مبيعات الذمة",
      "صافي النقد",
      "صافي مبيعات الفيزا",
    ]);
    expect(paymentCard.textContent).toContain("فاتورة مكتب بلا وردية");
    expect(stats.every((el) => el.querySelector(".ui-stat__icon"))).toBe(true);
    expect(paymentCard.querySelectorAll(".ui-stat-grid")).toHaveLength(1);
    expect(paymentCard.textContent).not.toContain("₪70.00");
    expect(paymentCard.textContent).not.toContain("₪12.00");
    expect(paymentCard.textContent).toContain("₪15.00");
    expect(paymentCard.textContent).toContain("₪55.00");

    expect(text).toContain("صافي المبيعات");
    expect(text).toContain("إجمالي المبيعات");
  });
});
