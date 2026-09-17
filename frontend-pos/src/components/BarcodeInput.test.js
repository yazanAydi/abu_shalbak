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

const {
  beginProductNotFound,
  playProductNotFound,
  playScanSuccess,
} = require("../utils/posSounds");

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
});
