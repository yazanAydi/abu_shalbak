import { act } from "react";
import { createRoot } from "react-dom/client";
import PosCartTable, { bumpQty } from "./PosCartTable";

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

function renderTable(cartItems, onQuantityChange = jest.fn()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <PosCartTable
        cartItems={cartItems}
        lineDiscounts={{}}
        activePromos={[]}
        onQuantityChange={onQuantityChange}
        onRemoveItem={jest.fn()}
      />
    );
  });
  return { container, root, onQuantityChange };
}

describe("cart quantity stepper math", () => {
  test("piece lines step by whole units", () => {
    expect(bumpQty(1, 1, 0)).toBe(2);
    expect(bumpQty(2, -1, 0)).toBe(1);
  });

  test("manual kg lines step by 0.1 without float drift", () => {
    expect(bumpQty(1, 0.1, 3)).toBe(1.1);
    expect(bumpQty(1.1, -0.1, 3)).toBe(1);
    expect(bumpQty(0.1, 0.1, 3)).toBe(0.2);
  });
});

describe("POS cart quantity buttons", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("piece line has +/−, minus disabled at 1, plus bumps by 1", () => {
    const onQuantityChange = jest.fn();
    const { container } = renderTable(
      [
        {
          cartKey: "1-1",
          id: 1,
          unitId: 1,
          unitName: "حبة",
          name: "حليب",
          quantity: 1,
          price: 5,
          availableUnits: [{ id: 1, unit_name: "حبة", price: 5 }],
        },
      ],
      onQuantityChange
    );

    const minus = container.querySelector('[aria-label="إنقاص الكمية"]');
    const plus = container.querySelector('[aria-label="زيادة الكمية"]');
    expect(minus).toBeTruthy();
    expect(plus).toBeTruthy();
    expect(minus.disabled).toBe(true);

    act(() => {
      plus.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onQuantityChange).toHaveBeenCalledWith("1-1", 2);
  });

  test("scale-weighed kg line stays read-only without buttons", () => {
    const { container } = renderTable([
      {
        cartKey: "2-2-w-x",
        id: 2,
        unitId: 2,
        unitName: "كغم",
        weighed: true,
        name: "جبنة",
        quantity: 0.255,
        price: 10,
        availableUnits: [{ id: 2, unit_name: "كغم", price: 10 }],
      },
    ]);

    expect(container.querySelector('[aria-label="إنقاص الكمية"]')).toBeNull();
    expect(container.querySelector('[aria-label="زيادة الكمية"]')).toBeNull();
    expect(container.querySelector(".pos-qty-val--weight")).toBeTruthy();
  });

  test("manual kg line steps by 0.1", () => {
    const onQuantityChange = jest.fn();
    const { container } = renderTable(
      [
        {
          cartKey: "3-3",
          id: 3,
          unitId: 3,
          unitName: "كغم",
          weighed: false,
          name: "أرز",
          quantity: 1,
          price: 8,
          availableUnits: [{ id: 3, unit_name: "كغم", price: 8 }],
        },
      ],
      onQuantityChange
    );

    const plus = container.querySelector('[aria-label="زيادة الكمية"]');
    act(() => {
      plus.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onQuantityChange).toHaveBeenCalledWith("3-3", 1.1);
  });
});
