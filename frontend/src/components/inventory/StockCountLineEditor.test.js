import { act } from "react";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import StockCountLineEditor from "./StockCountLineEditor";
import { searchProductsApi } from "../../utils/productSearch";
import api from "../../apiClient";

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

jest.mock("../../utils/productSearch", () => ({
  searchProductsApi: jest.fn(async () => [
    { id: 7, name: "حليب", barcode: "123456", stock: 4, sku: "12" },
  ]),
}));

jest.mock("../../apiClient", () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

function pictureResponse(body) {
  return Promise.resolve({ data: body });
}

function Harness({ initial = [], scope = "retail", membership = null }) {
  const [items, setItems] = useState(initial);
  return (
    <StockCountLineEditor
      items={items}
      setItems={setItems}
      scope={scope}
      membership={membership}
    />
  );
}

describe("StockCountLineEditor", () => {
  let container;
  let root;

  beforeEach(() => {
    searchProductsApi.mockReset();
    searchProductsApi.mockResolvedValue([
      { id: 7, name: "حليب", barcode: "123456", stock: 4, sku: "12" },
    ]);
    api.get.mockReset();
    api.get.mockImplementation(() => pictureResponse({
      has_dated_batches: false,
      product_stock: 0,
      product_expiry_date: null,
      sources: [],
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {});
    act(() => root.unmount());
    container.remove();
  });

  function render(node) {
    act(() => {
      root.render(node);
    });
  }

  function clickAdd() {
    const button = [...container.querySelectorAll("button")].find((el) => el.textContent.includes("إضافة صنف"));
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  test("add item creates one blank row, focuses the product, and keeps earlier rows", () => {
    render(<Harness />);
    clickAdd();
    const product = container.querySelector("[data-invoice-field='product']");
    expect(product).toBeTruthy();
    expect(document.activeElement).toBe(product);
    expect(container.querySelector("[placeholder='ابحث عن منتج بالاسم أو الباركود…']")).toBeNull();
  });

  test("adding a row keeps the quantity already entered on the previous row", () => {
    render(<Harness initial={[{
      line_key: "line-1",
      product_id: 7,
      name: "حليب",
      counted_qty: "3",
      expiry_date: "2027-04-01",
      expiry_invalid: false,
    }]} />);
    clickAdd();
    const qtys = [...container.querySelectorAll("[data-invoice-field='qty']")];
    const expiries = [...container.querySelectorAll("[data-invoice-field='expiry']")];
    expect(qtys).toHaveLength(2);
    expect(qtys[0].value).toBe("3");
    expect(expiries[0].value).toBe("01/04/27");
    expect(qtys[1].value).toBe("");
    expect(expiries[1].value).toBe("");
    expect(document.activeElement).toBe(container.querySelectorAll("[data-invoice-field='product']")[1]);
  });

  test("the entry table has the three count columns and a remove control", () => {
    render(<Harness initial={[{
      line_key: "line-1",
      product_id: 7,
      name: "حليب",
      counted_qty: "2",
      expiry_date: "2027-01-01",
      expiry_invalid: false,
    }]} />);
    const headers = [...container.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(headers.slice(0, 5)).toEqual(["الصنف", "الكمية الحالية", "الوحدة", "الكمية المعدودة", "تاريخ الصلاحية"]);
    expect(container.textContent).not.toMatch(/رصيد النظام|الفرق|خصم البند|بونص|سعر/);
    const remove = container.querySelector("[aria-label='حذف']");
    expect(remove).toBeTruthy();
    act(() => {
      remove.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector("[data-invoice-line]")).toBeNull();
  });

  test("Enter after the expiry field adds the next row, including an explicit zero", () => {
    render(<Harness initial={[{
      line_key: "line-1",
      product_id: 7,
      name: "حليب",
      counted_qty: "0",
      expiry_date: "",
      expiry_invalid: false,
    }]} />);
    const expiry = container.querySelector("[data-invoice-field='expiry']");
    act(() => {
      expiry.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(container.querySelectorAll("[data-invoice-line]")).toHaveLength(2);
    expect(container.querySelector("[data-invoice-field='qty']").value).toBe("0");
  });

  test("an invalid expiry and an open date picker do not add a row", () => {
    render(<Harness initial={[{
      line_key: "line-1",
      product_id: 7,
      name: "حليب",
      counted_qty: "2",
      expiry_date: "",
      expiry_invalid: false,
    }]} />);
    const expiry = container.querySelector("[data-invoice-field='expiry']");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    act(() => {
      setter.call(expiry, "31/02/26");
      expiry.dispatchEvent(new Event("input", { bubbles: true }));
      expiry.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(container.querySelectorAll("[data-invoice-line]")).toHaveLength(1);
    expect(container.textContent).toMatch(/تاريخ الصلاحية غير صالح/);

    const picker = container.querySelector(".ui-date__picker");
    act(() => {
      picker.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(container.querySelectorAll("[data-invoice-line]")).toHaveLength(1);
  });

  test("search selection fills the same row and retail or bakery search stays in scope", async () => {
    render(<Harness />);
    clickAdd();
    const product = container.querySelector("[data-invoice-field='product']");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    act(() => {
      setter.call(product, "حلي");
      product.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(searchProductsApi).toHaveBeenCalledWith("حلي", expect.objectContaining({ scope: "retail" }));
    expect(searchProductsApi.mock.calls[0][1].membership).toBeUndefined();
    act(() => {
      product.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(container.querySelectorAll("[data-invoice-line]")).toHaveLength(1);
    expect(container.querySelector("[data-invoice-field='product']").value).toBe("حليب");

    searchProductsApi.mockClear();
    act(() => root.unmount());
    root = createRoot(container);
    render(<Harness membership="bakery" />);
    clickAdd();
    const bakeryProduct = container.querySelector("[data-invoice-field='product']");
    act(() => {
      setter.call(bakeryProduct, "طحين");
      bakeryProduct.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(searchProductsApi).toHaveBeenCalledWith("طحين", expect.objectContaining({
      membership: "bakery",
      kind: "workspace",
    }));
    expect(searchProductsApi.mock.calls[searchProductsApi.mock.calls.length - 1][1].scope).toBeUndefined();
  });

  async function pickMilk({ last = false } = {}) {
    clickAdd();
    const products = container.querySelectorAll("[data-invoice-field='product']");
    const product = products[last ? products.length - 1 : 0];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    act(() => {
      setter.call(product, "حلي");
      product.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await act(async () => {
      product.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
  }

  test("marks the original and every duplicate product, including different dates, and clears after removal", async () => {
    render(<Harness initial={[
      { line_key: "duplicate-1", product_id: 7, name: "حليب", counted_qty: "2", expiry_date: "2027-01-01" },
      { line_key: "duplicate-2", product_id: 7, name: "حليب", counted_qty: "3", expiry_date: "2027-02-01" },
    ]} />);
    await act(async () => {});
    expect(container.querySelectorAll(".invoice-product-cell--duplicate")).toHaveLength(2);
    expect(container.querySelector("[data-invoice-line='duplicate-1'] .invoice-product-cell--duplicate")).toBeTruthy();
    expect(container.querySelector("[data-invoice-line='duplicate-2'] .invoice-product-cell--duplicate")).toBeTruthy();
    // Selecting another copy marks that copy as well, rather than only the last row.
    await pickMilk({ last: true });
    expect(container.querySelectorAll(".invoice-product-cell--duplicate")).toHaveLength(3);
    const inputs = [...container.querySelectorAll("[data-invoice-field='product']")];
    expect(inputs.every((input) => document.getElementById(input.getAttribute("aria-describedby"))?.textContent === "الصنف مكرر في الجرد")).toBe(true);
    const quantities = [...container.querySelectorAll("[data-testid='count-qty']")];
    expect(quantities.map((input) => input.value)).toEqual(["2", "3", ""]);
    act(() => container.querySelectorAll("[aria-label='حذف']")[2].click());
    expect(container.querySelectorAll(".invoice-product-cell--duplicate")).toHaveLength(2);
    act(() => container.querySelectorAll("[aria-label='حذف']")[1].click());
    expect(container.querySelectorAll(".invoice-product-cell--duplicate")).toHaveLength(0);
    expect(container.querySelector("[data-testid='count-qty']").value).toBe("2");
  });

  test("unit defaults to the product unit and switching units compares stock without replacing the typed count", async () => {
    api.get.mockResolvedValue({ data: {
      has_dated_batches: false, product_stock: 12, unit: "حبة", sources: [],
      count_units: [{ id: 71, unit_name: "حبة", conversion_to_base: 1 },
        { id: 72, unit_name: "كرتونة", conversion_to_base: 6 }],
    } });
    render(<Harness />);
    await pickMilk();
    const unit = container.querySelector("[data-testid='count-unit']");
    const quantity = container.querySelector("[data-testid='count-qty']");
    expect(unit.value).toBe("base");
    expect(unit.options[unit.selectedIndex].textContent).toBe("حبة");
    expect(container.querySelector("[data-testid='count-system-qty']").textContent).toBe("12 حبة");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(quantity, "2");
      quantity.dispatchEvent(new Event("input", { bubbles: true }));
      unit.value = "72";
      unit.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(quantity.value).toBe("2");
    expect(container.querySelector("[data-testid='count-system-qty']").textContent).toBe("2 كرتونة");
    act(() => { unit.value = "base"; unit.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(quantity.value).toBe("2");
    expect(container.querySelector("[data-testid='count-system-qty']").textContent).toBe("12 حبة");
  });

  test("tapping a product focuses counted quantity inside the click without changing the count", async () => {
    render(<Harness />);
    clickAdd();
    const product = container.querySelector("[data-invoice-field='product']");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    act(() => {
      setter.call(product, "حلي");
      product.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    const option = document.querySelector(".invoice-product-cell__list li");
    const quantity = container.querySelector("[data-testid='count-qty']");
    await act(async () => {
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      option.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      // An effect/animation-frame focus would be too late for this assertion.
      expect(document.activeElement).toBe(quantity);
    });
    expect(quantity.getAttribute("inputmode")).toBe("decimal");
    expect(quantity.value).toBe("");
    expect(container.querySelector("[data-testid='count-expiry-verified']").checked).toBe(false);
  });

  test("one recorded batch prefills the expiry and a quantity edit keeps it", async () => {
    api.get.mockImplementation(() => pictureResponse({
      has_dated_batches: true,
      product_stock: 4,
      product_expiry_date: "2031-01-15",
      sources: [
        { batch_source: "dated", expiry_date: "2027-04-01", quantity: 4 },
        { batch_source: "undated", expiry_date: null, quantity: 0 },
      ],
    }));
    render(<Harness />);
    await pickMilk();
    const expiry = container.querySelector("[data-invoice-field='expiry']");
    expect(expiry.value).toBe("01/04/27");
    expect(container.querySelector("[data-testid='count-product-expiry']").textContent)
      .toContain("تاريخ الصنف المسجل");
    expect(container.querySelector("[data-testid='count-expiry-choices']")).toBeNull();
    const qty = container.querySelector("[data-invoice-field='qty']");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    await act(async () => {
      setter.call(qty, "6");
      qty.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector("[data-invoice-field='expiry']").value).toBe("01/04/27");
    expect(container.querySelector("[data-invoice-field='qty']").value).toBe("6");
  });

  test("several recorded dates are choices and are not prefilled", async () => {
    api.get.mockImplementation(() => pictureResponse({
      has_dated_batches: true,
      product_stock: 6,
      product_expiry_date: null,
      sources: [
        { batch_source: "dated", expiry_date: "2027-01-01", quantity: 4 },
        { batch_source: "dated", expiry_date: "2027-06-01", quantity: 2 },
        { batch_source: "undated", expiry_date: null, quantity: 0 },
      ],
    }));
    render(<Harness />);
    await pickMilk();
    expect(container.querySelector("[data-invoice-field='expiry']").value).toBe("");
    const choices = container.querySelector("[data-testid='count-expiry-choices']");
    expect(choices).toBeTruthy();
    expect([...choices.options].map((option) => option.value)).toEqual(["", "2027-01-01", "2027-06-01"]);
    expect(choices.value).toBe("");
    await act(async () => {
      choices.value = "2027-06-01";
      choices.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector("[data-invoice-field='expiry']").value).toBe("01/06/27");
    expect(container.querySelector("[data-testid='count-no-expiry']")).toBeNull();
  });

  test("a product expiry is labeled separately and a missing expiry stays blank", async () => {
    api.get.mockImplementation(() => pictureResponse({
      has_dated_batches: false,
      product_stock: 5,
      product_expiry_date: "2031-01-15",
      sources: [],
    }));
    render(<Harness />);
    await pickMilk();
    expect(container.querySelector("[data-invoice-field='expiry']").value).toBe("");
    expect(container.querySelector("[data-testid='count-product-expiry']").textContent)
      .toBe("تاريخ الصنف المسجل: 15/01/31");
    expect(container.querySelector("[data-testid='count-no-expiry']")).toBeNull();

    api.get.mockImplementation(() => pictureResponse({
      has_dated_batches: false,
      product_stock: 0,
      product_expiry_date: null,
      sources: [],
    }));
    act(() => root.unmount());
    root = createRoot(container);
    render(<Harness />);
    await pickMilk();
    expect(container.querySelector("[data-invoice-field='expiry']").value).toBe("");
    expect(container.querySelector("[data-testid='count-no-expiry']").textContent).toBe("لا يوجد تاريخ مسجل");
  });

  test("a date entered before the recorded expiry arrives is kept", async () => {
    let release;
    api.get.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({
        data: {
          has_dated_batches: true,
          product_stock: 4,
          product_expiry_date: null,
          sources: [{ batch_source: "dated", expiry_date: "2027-04-01", quantity: 4 }],
        },
      });
    }));
    render(<Harness />);
    await pickMilk();
    const expiry = container.querySelector("[data-invoice-field='expiry']");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    await act(async () => {
      setter.call(expiry, "15/01/28");
      expiry.dispatchEvent(new Event("input", { bubbles: true }));
      expiry.dispatchEvent(new Event("blur", { bubbles: true }));
    });
    await act(async () => {
      release();
    });
    expect(container.querySelector("[data-invoice-field='expiry']").value).toBe("15/01/28");
  });

  test("shows the warehouse source quantity, keeps a blank count, and focuses it after a barcode", async () => {
    searchProductsApi.mockResolvedValue([
      { id: 7, name: "حليب", barcode: "1234567890123", stock: 40, sku: "12", unit: "حبة" },
    ]);
    api.get.mockImplementation(() => pictureResponse({
      has_dated_batches: true,
      product_stock: 40,
      unit: "حبة",
      main_warehouse_id: 1,
      product_expiry_date: null,
      sources: [
        { batch_source: "dated", expiry_date: "2027-01-01", quantity: 13 },
        { batch_source: "undated", expiry_date: null, quantity: 27 },
      ],
      locations: [
        { warehouse_id: 1, warehouse_type: "main", expiry_date: "2027-01-01", quantity: 4 },
        { warehouse_id: 2, warehouse_type: "returns", expiry_date: "2027-01-01", quantity: 9 },
      ],
    }));
    render(<Harness />);
    clickAdd();
    const product = container.querySelector("[data-invoice-field='product']");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    act(() => {
      setter.call(product, "1234567890123");
      product.dispatchEvent(new Event("input", { bubbles: true }));
      product.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(container.querySelectorAll("[data-invoice-line]")).toHaveLength(1);
    expect(container.querySelector("[data-invoice-field='qty']").value).toBe("");
    expect(container.querySelector("[data-testid='count-system-qty']").textContent).toBe("—");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(container.querySelector("[data-invoice-field='product']").value).toBe("حليب");
    expect(container.querySelectorAll("[data-invoice-line]")).toHaveLength(1);
    expect(document.activeElement).toBe(container.querySelector("[data-invoice-field='qty']"));
    expect(container.querySelector("[data-invoice-field='qty']").value).toBe("");
    expect(container.querySelector("[data-testid='count-expiry-verified']").checked).toBe(false);
    expect(container.querySelector("[data-testid='count-system-qty']").textContent).toContain("4");
    expect(container.querySelector("[data-testid='count-system-qty']").textContent).not.toContain("40");
    expect(container.querySelector("[data-testid='count-system-qty']").textContent).not.toContain("13");

    act(() => {
      const again = container.querySelector("[data-invoice-field='product']");
      setter.call(again, "1234567890123");
      again.dispatchEvent(new Event("input", { bubbles: true }));
      again.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(container.querySelector("[data-invoice-field='qty']").value).toBe("");
    expect(container.querySelector("[data-testid='count-expiry-verified']").checked).toBe(false);
  });

  test("an unknown barcode does not add a row or fill the count", async () => {
    searchProductsApi.mockResolvedValue([]);
    render(<Harness />);
    clickAdd();
    const product = container.querySelector("[data-invoice-field='product']");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    act(() => {
      setter.call(product, "9999999999999");
      product.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    act(() => {
      product.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(container.querySelectorAll("[data-invoice-line]")).toHaveLength(1);
    expect(container.querySelector("[data-invoice-field='product']").value).toBe("9999999999999");
    expect(container.querySelector("[data-invoice-field='qty']").value).toBe("");
    expect(document.activeElement).not.toBe(container.querySelector("[data-invoice-field='qty']"));
  });
});
