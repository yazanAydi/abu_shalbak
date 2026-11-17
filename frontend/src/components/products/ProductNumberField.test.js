import { act } from "react";
import { createRoot } from "react-dom/client";
import api from "../../apiClient";
import ProductNumberField, { PENDING_PRODUCT_NUMBER, savedProductNumber } from "./ProductNumberField";
import EditProductModal from "../../pages/productDashboard/EditProductModal";

jest.mock("../../apiClient", () => ({
  __esModule: true,
  default: {
    get: jest.fn(() => Promise.resolve({ data: [] })),
    put: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
  },
}));

jest.mock("../CategorySelect", () => function CategorySelect() {
  return null;
});
jest.mock("../UnitNameSelect", () => function UnitNameSelect() {
  return null;
});
jest.mock("../barcode/CameraBarcodeButton", () => function CameraBarcodeButton() {
  return null;
});
jest.mock("../../pages/productDashboard/ProductUnitsSection", () => function ProductUnitsSection() {
  return null;
});

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

function render(ui) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(ui);
  });
  return {
    host,
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  act(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const existing = {
  id: 5,
  sku: "42",
  barcode: "6281000000042",
  name: "طحين",
  price: 3,
  cost: 1,
  stock: 8,
  unit: "كغم",
  category: "مخبز",
  inventory_scope: "bakery",
};

describe("bakery product number field", () => {
  beforeEach(() => {
    api.get.mockClear();
    api.put.mockClear();
    document.body.innerHTML = "";
  });

  test("saved number is the existing sku, never a barcode or a guess", () => {
    expect(savedProductNumber("0042")).toBe("42");
    expect(savedProductNumber(null)).toBe("");
    expect(savedProductNumber("6281000000042")).toBe("");
  });

  test("create shows the automatic-assignment note and does not accept typing", () => {
    const view = render(<ProductNumberField />);
    const input = view.host.querySelector("input");
    expect(view.host.textContent).toContain("رقم الصنف");
    expect(view.host.textContent).not.toContain("*");
    expect(input.readOnly).toBe(true);
    expect(input.disabled).toBe(false);
    expect(input.required).toBe(false);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe(PENDING_PRODUCT_NUMBER);
    setInputValue(input, "99");
    expect(input.value).toBe("");
    view.cleanup();
  });

  test("edit shows the saved product number and keeps it out of the save body", async () => {
    const view = render(
      <EditProductModal open product={existing} productNumberReadOnly onClose={() => {}} onSaved={() => {}} />
    );
    const number = [...view.host.querySelectorAll("input")].find((el) => el.value === "42");
    expect(number).toBeTruthy();
    expect(number.readOnly).toBe(true);
    expect(number.disabled).toBe(false);
    expect(view.host.textContent).toContain("رقم الصنف");
    expect(view.host.textContent).not.toContain(PENDING_PRODUCT_NUMBER);

    const name = [...view.host.querySelectorAll("input")].find((el) => el.value === "طحين");
    setInputValue(name, "طحين فاخر");
    const save = [...view.host.querySelectorAll("button")].find((el) => el.textContent.includes("حفظ"));
    await act(async () => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(api.put).toHaveBeenCalledTimes(1);
    const body = api.put.mock.calls[0][1];
    expect(body).toEqual({ name: "طحين فاخر" });
    expect(body.sku).toBeUndefined();
    view.cleanup();
  });

  test("other product edits can still send a changed product number", async () => {
    const view = render(
      <EditProductModal open product={existing} onClose={() => {}} onSaved={() => {}} />
    );
    const number = [...view.host.querySelectorAll("input")].find((el) => el.value === "42");
    expect(number.readOnly).toBe(false);
    setInputValue(number, "43");
    const save = [...view.host.querySelectorAll("button")].find((el) => el.textContent.includes("حفظ"));
    await act(async () => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(api.put.mock.calls[0][1]).toEqual({ sku: "43" });
    view.cleanup();
  });
});
