import { act, useCallback, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { checkoutInitialState, checkoutReducer } from "../utils/checkoutCartReducer";
import BarcodeInput, {
  barcodeNotFoundCacheHasForTests,
  resetBarcodeNotFoundCacheForTests,
  seedBarcodeNotFoundCacheForTests,
} from "./BarcodeInput";

if (typeof globalThis.IS_REACT_ACT_ENVIRONMENT === "undefined") {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

const mockLookup = jest.fn();

jest.mock("../utils/barcode", () => {
  const actual = jest.requireActual("../utils/barcode");
  return {
    ...actual,
    lookupProductByBarcode: (...args) => mockLookup(...args),
  };
});

jest.mock("../utils/posSounds", () => ({
  beginProductNotFound: jest.fn(() => jest.fn()),
  playProductNotFound: jest.fn(),
  playScanSuccess: jest.fn(),
  unlockPosAudio: jest.fn(),
  warmPosSounds: jest.fn(),
}));

jest.mock("../utils/focusBarcodeInput", () => ({
  focusBarcodeInput: jest.fn(),
}));

jest.mock("../utils/productSearch", () => ({
  searchProductsApi: jest.fn(async () => []),
}));

const {
  beginProductNotFound,
  playProductNotFound,
  playScanSuccess,
} = require("../utils/posSounds");
const { searchProductsApi } = require("../utils/productSearch");

const KNOWN_CODE = "7290012345678";
const knownProduct = {
  found: true,
  product: { id: 41, name: "حليب", price: 5, stock: 10, barcode: KNOWN_CODE },
  selectedUnit: {
    id: 7,
    unit_name: "حبة",
    barcode: KNOWN_CODE,
    price: 5,
    conversion_to_base: 1,
  },
  availableUnits: [
    {
      id: 7,
      unit_name: "حبة",
      barcode: KNOWN_CODE,
      price: 5,
      conversion_to_base: 1,
    },
  ],
  barcode: KNOWN_CODE,
  price: 5,
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setInputValue(el, value, { emitInput = true } = {}) {
  const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
  proto.set.call(el, value);
  if (emitInput) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function pressEnter(el) {
  el.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
  );
}

function ScanHarness() {
  const [state, dispatch] = useReducer(checkoutReducer, checkoutInitialState);
  const addToCart = useCallback((product) => {
    dispatch({ type: "ADD_PRODUCT", product });
    playScanSuccess();
  }, []);
  const qty = state.cartItems[0]?.quantity ?? 0;
  return (
    <div>
      <BarcodeInput onProductFound={addToCart} onError={() => {}} />
      <div data-testid="qty">{qty}</div>
      <div data-testid="lines">{state.cartItems.length}</div>
    </div>
  );
}

describe("BarcodeInput scan lookup", () => {
  let container;
  let root;

  beforeEach(() => {
    mockLookup.mockReset();
    searchProductsApi.mockReset();
    searchProductsApi.mockResolvedValue([]);
    beginProductNotFound.mockClear();
    playProductNotFound.mockClear();
    playScanSuccess.mockClear();
    resetBarcodeNotFoundCacheForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<ScanHarness />);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function inputEl() {
    return container.querySelector(".barcode-input");
  }

  test("known product never plays not-found sound even if lookup is slow", async () => {
    const pending = deferred();
    mockLookup.mockImplementation(() => pending.promise);

    act(() => {
      setInputValue(inputEl(), KNOWN_CODE);
      pressEnter(inputEl());
    });

    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(mockLookup).toHaveBeenCalledWith(KNOWN_CODE);
    expect(playProductNotFound).not.toHaveBeenCalled();
    expect(beginProductNotFound).not.toHaveBeenCalled();
    expect(playScanSuccess).not.toHaveBeenCalled();
    expect(container.querySelector(".barcode-err")).toBeNull();
    expect(container.querySelector("[data-testid='qty']").textContent).toBe("0");

    await act(async () => {
      pending.resolve(knownProduct);
    });

    expect(playProductNotFound).not.toHaveBeenCalled();
    expect(beginProductNotFound).not.toHaveBeenCalled();
    expect(playScanSuccess).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-testid='qty']").textContent).toBe("1");
    expect(container.querySelector("[data-testid='lines']").textContent).toBe("1");
    expect(container.querySelector(".barcode-err")).toBeNull();
    expect(container.textContent).not.toContain("لم يُعثر على المنتج");
  });

  test("confirmed unknown product plays not-found sound once after the response", async () => {
    mockLookup.mockRejectedValueOnce(new Error(`لم يُعثر على المنتج (${KNOWN_CODE})`));

    await act(async () => {
      setInputValue(inputEl(), KNOWN_CODE);
      pressEnter(inputEl());
    });

    expect(playProductNotFound).toHaveBeenCalledTimes(1);
    expect(beginProductNotFound).not.toHaveBeenCalled();
    expect(playScanSuccess).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='qty']").textContent).toBe("0");
    const err = container.querySelector(".barcode-err");
    expect(err).not.toBeNull();
    expect(err.textContent).toContain(`لم يُعثر على المنتج (${KNOWN_CODE})`);
  });

  test("cached miss that is now found does not play error sound and adds the product", async () => {
    seedBarcodeNotFoundCacheForTests(KNOWN_CODE);
    expect(barcodeNotFoundCacheHasForTests(KNOWN_CODE)).toBe(true);
    mockLookup.mockResolvedValueOnce(knownProduct);

    await act(async () => {
      setInputValue(inputEl(), KNOWN_CODE);
      pressEnter(inputEl());
    });

    expect(playProductNotFound).not.toHaveBeenCalled();
    expect(beginProductNotFound).not.toHaveBeenCalled();
    expect(playScanSuccess).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-testid='qty']").textContent).toBe("1");
    expect(barcodeNotFoundCacheHasForTests(KNOWN_CODE)).toBe(false);
    expect(container.querySelector(".barcode-err")).toBeNull();
  });

  test("cached miss that is still missing plays not-found sound after the server response", async () => {
    seedBarcodeNotFoundCacheForTests(KNOWN_CODE);
    const pending = deferred();
    mockLookup.mockImplementation(() => pending.promise);

    act(() => {
      setInputValue(inputEl(), KNOWN_CODE);
      pressEnter(inputEl());
    });

    expect(playProductNotFound).not.toHaveBeenCalled();
    expect(container.querySelector(".barcode-err")).toBeNull();

    await act(async () => {
      pending.reject(new Error(`لم يُعثر على المنتج (${KNOWN_CODE})`));
    });

    expect(playProductNotFound).toHaveBeenCalledTimes(1);
    expect(beginProductNotFound).not.toHaveBeenCalled();
    expect(playScanSuccess).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='qty']").textContent).toBe("0");
    expect(container.querySelector(".barcode-err")?.textContent).toContain("لم يُعثر على المنتج");
    expect(barcodeNotFoundCacheHasForTests(KNOWN_CODE)).toBe(true);
  });

  test("Enter submits the live input value, not a stale React state prefix", async () => {
    mockLookup.mockResolvedValue(knownProduct);

    act(() => {
      setInputValue(inputEl(), "729");
    });

    await act(async () => {
      const el = inputEl();
      setInputValue(el, KNOWN_CODE);
      pressEnter(el);
    });

    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(mockLookup).toHaveBeenCalledWith(KNOWN_CODE);
    expect(mockLookup).not.toHaveBeenCalledWith("729");
    expect(playScanSuccess).toHaveBeenCalledTimes(1);
  });

  test("duplicate Enter while the same lookup is in flight is ignored; a later scan still adds", async () => {
    const pending = deferred();
    mockLookup.mockImplementationOnce(() => pending.promise);
    mockLookup.mockResolvedValue(knownProduct);

    act(() => {
      setInputValue(inputEl(), KNOWN_CODE);
      pressEnter(inputEl());
      pressEnter(inputEl());
    });

    expect(mockLookup).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(knownProduct);
    });

    expect(playScanSuccess).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-testid='qty']").textContent).toBe("1");

    await act(async () => {
      setInputValue(inputEl(), KNOWN_CODE);
      pressEnter(inputEl());
    });

    expect(mockLookup).toHaveBeenCalledTimes(2);
    expect(playScanSuccess).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-testid='qty']").textContent).toBe("2");
  });

  test("network failures do not play the product-not-found sound", async () => {
    mockLookup.mockRejectedValueOnce(new Error("تعذّر الاتصال بالخادم"));

    await act(async () => {
      setInputValue(inputEl(), KNOWN_CODE);
      pressEnter(inputEl());
    });

    expect(playProductNotFound).not.toHaveBeenCalled();
    expect(beginProductNotFound).not.toHaveBeenCalled();
    expect(playScanSuccess).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='qty']").textContent).toBe("0");
    expect(container.querySelector(".barcode-err")?.textContent).toContain("تعذّر الاتصال بالخادم");
  });

  test("Arabic name search selects one product and does not scan the name as a barcode", async () => {
    const milk = { id: 9, name: "حليب طازج", barcode: "1112223334445", price: 6, sku: "44" };
    searchProductsApi.mockResolvedValue([milk]);
    mockLookup.mockResolvedValue({
      found: true,
      product: milk,
      barcode: milk.barcode,
      price: 6,
    });

    act(() => {
      setInputValue(inputEl(), "حليب");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    const option = container.querySelector("[role='option']");
    expect(option.textContent).toContain("حليب طازج");
    await act(async () => {
      option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(mockLookup).toHaveBeenCalledWith("1112223334445");
    expect(playScanSuccess).toHaveBeenCalledTimes(1);
    expect(inputEl().value).toBe("");
    expect(container.querySelector("[role='listbox']")).toBeNull();
  });

  test("an unknown barcode does not add a visible suggestion", async () => {
    searchProductsApi.mockResolvedValue([
      { id: 2, name: "خبز", barcode: "999", price: 2 },
    ]);
    mockLookup.mockRejectedValueOnce(new Error("لم يُعثر على المنتج (000111)"));

    act(() => {
      setInputValue(inputEl(), "000111");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(container.querySelector("[role='option']")).not.toBeNull();

    await act(async () => {
      pressEnter(inputEl());
    });

    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(mockLookup).toHaveBeenCalledWith("000111");
    expect(playScanSuccess).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='lines']").textContent).toBe("0");
    expect(container.querySelector(".barcode-err").textContent).toContain("لم يُعثر على المنتج");
    expect(container.querySelector("[role='listbox']")).toBeNull();
  });

  test("arrow keys choose a suggestion and Escape closes the list", async () => {
    searchProductsApi.mockResolvedValue([
      { id: 1, name: "أ", barcode: "1", price: 1 },
      { id: 2, name: "ب", barcode: "2", price: 2 },
    ]);
    act(() => {
      setInputValue(inputEl(), "منتج");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    const input = inputEl();
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(container.querySelector("[aria-selected='true']").textContent).toContain("ب");

    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector("[role='listbox']")).toBeNull();
    expect(input.value).toBe("منتج");
  });

  test("a scale barcode is looked up once as scanned", async () => {
    const scaleCode = "2100410015504";
    mockLookup.mockResolvedValue({
      found: true,
      product: { id: 5, name: "بندورة", barcode: null, is_weighed: 1 },
      quantity: 1.55,
      barcode: scaleCode,
      price: 8,
    });

    await act(async () => {
      setInputValue(inputEl(), scaleCode);
      pressEnter(inputEl());
    });

    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(mockLookup).toHaveBeenCalledWith(scaleCode);
    expect(playScanSuccess).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-testid='lines']").textContent).toBe("1");
  });
});
