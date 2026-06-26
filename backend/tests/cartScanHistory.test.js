import {
  checkoutReducer,
  checkoutInitialState,
} from "../../frontend-pos/src/utils/checkoutCartReducer.js";
import { cartKeyFor } from "../../frontend-pos/src/utils/cartProduct.js";
import {
  createScanHistoryEntry,
  pushScanHistory,
  popScanHistory,
  applyUndoScan,
} from "../../frontend-pos/src/utils/scanHistory.js";

const sampleProduct = {
  product: { id: 1, name: "Item A", price: 5, stock: 10 },
  unit_id: 1,
  unit_name: "حبة",
  barcode: "111",
  price: 5,
  conversion_to_base: 1,
};

describe("scan history / undo last scan", () => {
  test("undo removes a newly scanned row", () => {
    let state = checkoutReducer(checkoutInitialState, {
      type: "ADD_PRODUCT",
      product: sampleProduct,
    });
    expect(state.cartItems).toHaveLength(1);
    expect(state.scanHistory).toHaveLength(1);

    state = checkoutReducer(state, { type: "UNDO_LAST_SCAN" });
    expect(state.cartItems).toHaveLength(0);
    expect(state.scanHistory).toHaveLength(0);
  });

  test("undo decrements quantity when scan increased existing row", () => {
    let state = checkoutReducer(checkoutInitialState, {
      type: "ADD_PRODUCT",
      product: sampleProduct,
    });
    state = checkoutReducer(state, { type: "ADD_PRODUCT", product: sampleProduct });
    expect(state.cartItems[0].quantity).toBe(2);

    state = checkoutReducer(state, { type: "UNDO_LAST_SCAN" });
    expect(state.cartItems[0].quantity).toBe(1);
  });

  test("undo at quantity 1 removes the row", () => {
    let state = checkoutReducer(checkoutInitialState, {
      type: "ADD_PRODUCT",
      product: sampleProduct,
    });
    state = checkoutReducer(state, { type: "UNDO_LAST_SCAN" });
    expect(state.cartItems).toHaveLength(0);
  });

  test("manual quantity change is not undone", () => {
    let state = checkoutReducer(checkoutInitialState, {
      type: "ADD_PRODUCT",
      product: sampleProduct,
    });
    const key = cartKeyFor(state.cartItems[0]);
    state = checkoutReducer(state, { type: "CHANGE_QTY", cartKey: key, newQty: 5 });
    expect(state.scanHistory).toHaveLength(0);
    state = checkoutReducer(state, { type: "UNDO_LAST_SCAN" });
    expect(state.cartItems[0].quantity).toBe(5);
  });

  test("applyUndoScan pure helpers", () => {
    const entry = createScanHistoryEntry("1-1", 2, false);
    const stack = pushScanHistory([], entry);
    const { entry: popped } = popScanHistory(stack);
    const items = [{ cartKey: "1-1", quantity: 3, price: 5, subtotal: 15 }];
    const next = applyUndoScan(items, popped, (x) => x.cartKey);
    expect(next[0].quantity).toBe(2);
  });
});

describe("clear invoice / cart", () => {
  test("CLEAR_CART resets items and scan stack", () => {
    let state = checkoutReducer(checkoutInitialState, {
      type: "ADD_PRODUCT",
      product: sampleProduct,
    });
    state = checkoutReducer(state, { type: "ADD_PRODUCT", product: sampleProduct });
    expect(state.cartItems.length).toBeGreaterThan(0);
    expect(state.scanHistory.length).toBeGreaterThan(0);

    state = checkoutReducer(state, { type: "CLEAR_CART" });
    expect(state.cartItems).toEqual([]);
    expect(state.scanHistory).toEqual([]);
    expect(state.lastScannedCartKey).toBeNull();
  });
});
