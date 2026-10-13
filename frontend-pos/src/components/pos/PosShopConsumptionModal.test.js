import { act } from "react";
import { createRoot } from "react-dom/client";
import PosShopConsumptionModal from "./PosShopConsumptionModal";

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

const mockPost = jest.fn();

jest.mock("../../apiClient", () => ({
  __esModule: true,
  default: {
    post: (...args) => mockPost(...args),
  },
}));

jest.mock("../../utils/auth", () => ({
  getAuthHeaders: () => ({ Authorization: "Bearer test" }),
}));

const cart = [{ id: 7, unitId: 3, quantity: 2, price: 10, name: "صنف" }];

describe("Post as store expenses confirmation", () => {
  let container;
  let root;

  beforeEach(() => {
    sessionStorage.clear();
    mockPost.mockReset();
    mockPost.mockImplementation((url) => {
      if (String(url).includes("preview")) {
        return Promise.resolve({
          data: {
            total_cost: 20,
            discount: 0,
            rounding_adjustment: 0,
            lines: [{ product_id: 7, name: "صنف", quantity: 2, unit_name: "حبة", unit_price: 10, line_amount: 20 }],
          },
        });
      }
      return Promise.resolve({ data: { pending_approval: true, request_id: 4, total_cost: 20 } });
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test("shows the selling-price total and posts that price once", async () => {
    const onWaiting = jest.fn();
    await act(async () => {
      root.render(
        <PosShopConsumptionModal open cartItems={cart} onClose={jest.fn()} onWaiting={onWaiting} />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("ترحيل كمصاريف محل");
    expect(container.textContent).toContain("سعر البيع");
    expect(container.textContent).toContain("إجمالي المصروف");
    expect(container.textContent).toContain("20.00");
    expect(mockPost.mock.calls[0][1].items[0].price).toBe(10);
    expect(mockPost.mock.calls[0][1].items[0].total).toBeUndefined();

    const button = [...container.querySelectorAll("button")].find((el) => el.textContent.includes("تأكيد"));
    await act(async () => {
      button.click();
      button.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const posts = mockPost.mock.calls.filter((call) => !String(call[0]).includes("preview"));
    expect(posts).toHaveLength(1);
    expect(posts[0][1].items[0].price).toBe(10);
    expect(posts[0][1].idempotency_key).toBeTruthy();
    expect(onWaiting).toHaveBeenCalledWith(4, { telegram: false });
  });
});
