import { act } from "react";
import { createRoot } from "react-dom/client";
import ShiftCountTotals from "./ShiftCountTotals";

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

const screenshot = {
  opening_cash: 0,
  cash_sales: 117,
  visa_sales: 2,
  tender_total: 119,
  cash_refunds: 0,
  visa_refunds: 0,
  cash_net: 117,
  visa_net: 2,
  supplier_payments_total: 210,
  expected_cash: -93,
};

function render(source, props = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ShiftCountTotals source={source} {...props} />);
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("ShiftCountTotals", () => {
  test("shows the sales trio and the expected cash once", () => {
    const view = render(screenshot);
    const sales = view.container.querySelector('[data-testid="shift-count-sales"]');
    const drawer = view.container.querySelector('[data-testid="shift-count-drawer"]');
    expect(sales.textContent).toContain("مبيعات نقدية");
    expect(sales.textContent).toContain("مبيعات فيزا");
    expect(sales.textContent).toContain("إجمالي المبيعات النقدية والفيزا");
    expect(sales.textContent).toContain("117.00");
    expect(sales.textContent).toContain("2.00");
    expect(sales.textContent).toContain("119.00");
    expect(sales.textContent).not.toContain("النقد المتوقع");
    expect(drawer.textContent).not.toContain("مبيعات فيزا");
    expect(drawer.textContent).toContain("رصيد بداية الوردية");
    expect(drawer.textContent).toContain("0.00");
    expect(drawer.textContent).toContain("المبيعات النقدية");
    expect(drawer.textContent).toContain("دفعات الموردين");
    expect(drawer.textContent).toContain("\u2212210.00");
    const expectedNodes = view.container.querySelectorAll('[data-testid="shift-count-expected"]');
    expect(expectedNodes).toHaveLength(1);
    expect(expectedNodes[0].textContent).toContain("النقد المتوقع في الصندوق");
    expect(expectedNodes[0].textContent).toContain("\u221293.00");
    expect(view.container.textContent).toContain("راجع رصيد البداية وحركات الصندوق");
    expect(view.container.textContent).not.toContain("عجز");
    view.unmount();
  });

  test("hides the review note when expected cash is zero or positive", () => {
    const zero = render({ ...screenshot, opening_cash: 119, supplier_payments_total: 0, expected_cash: 0 });
    expect(zero.container.querySelector('[data-testid="shift-count-expected-note"]')).toBeNull();
    expect(zero.container.textContent).not.toContain("غير متوفر");
    zero.unmount();

    const positive = render({ ...screenshot, opening_cash: 200, supplier_payments_total: 0, expected_cash: 317 });
    expect(positive.container.querySelector('[data-testid="shift-count-expected-note"]')).toBeNull();
    expect(positive.container.textContent).toContain("317.00");
    positive.unmount();
  });

  test("keeps every tender figure, including zeros and غير مكتمل, when details ask for them", () => {
    const example = render({
      cash_sales: 54,
      visa_sales: 41,
      tender_total: 95,
      cash_refunds: 8,
      visa_refunds: 36,
      cash_net: 46,
      visa_net: 5,
      expected_cash: 66,
    }, { includeZeros: true });
    const sales = example.container.querySelector('[data-testid="shift-count-sales"]');
    expect(sales.textContent).toContain("مبيعات نقدية");
    expect(sales.textContent).toContain("54.00");
    expect(sales.textContent).toContain("مبيعات فيزا");
    expect(sales.textContent).toContain("41.00");
    expect(sales.textContent).toContain("إجمالي المبيعات النقدية والفيزا");
    expect(sales.textContent).toContain("95.00");
    expect(sales.textContent).toContain("مرتجعات نقدية");
    expect(sales.textContent).toContain("8.00");
    expect(sales.textContent).toContain("مرتجعات الفيزا");
    expect(sales.textContent).toContain("36.00");
    expect(sales.textContent).toContain("صافي المبيعات النقدية");
    expect(sales.textContent).toContain("46.00");
    expect(sales.textContent).toContain("صافي المبيعات الفيزا");
    expect(sales.textContent).toContain("5.00");
    example.unmount();

    const zeros = render({
      cash_sales: 0,
      visa_sales: 0,
      tender_total: 0,
      cash_refunds: 0,
      visa_refunds: 0,
      cash_net: 0,
      visa_net: 0,
      expected_cash: 0,
    }, { includeZeros: true });
    const zeroSales = zeros.container.querySelector('[data-testid="shift-count-sales"]');
    for (const label of [
      "مبيعات نقدية",
      "مبيعات فيزا",
      "إجمالي المبيعات النقدية والفيزا",
      "مرتجعات نقدية",
      "مرتجعات الفيزا",
      "صافي المبيعات النقدية",
      "صافي المبيعات الفيزا",
    ]) {
      expect(zeroSales.textContent).toContain(label);
    }
    expect(zeroSales.textContent).toContain("0.00");
    expect(zeroSales.textContent).not.toContain("غير مكتمل");
    zeros.unmount();

    const incomplete = render({
      cash_sales: 10,
      visa_sales: 0,
      tender_total: 10,
      cash_refunds: 0,
      visa_refunds: 0,
      cash_net: 10,
      visa_net: 0,
      cash_sales_incomplete: true,
      visa_incomplete: true,
      expected_cash: 15,
    }, { includeZeros: true });
    const flagged = incomplete.container.querySelector('[data-testid="shift-count-sales"]');
    expect(flagged.textContent).toContain("غير مكتمل");
    expect(flagged.textContent).toContain("10.00");
    expect(flagged.textContent).toContain("0.00");
    incomplete.unmount();
  });

  test("shows غير متوفر when opening cash is missing", () => {
    const view = render({ cash_sales: 10, visa_sales: 0, expected_cash: 10 });
    const drawer = view.container.querySelector('[data-testid="shift-count-drawer"]');
    expect(drawer.textContent).toContain("غير متوفر");
    expect(drawer.textContent).not.toContain("عجز");
    view.unmount();
  });
});
