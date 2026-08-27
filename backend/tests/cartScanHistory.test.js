function cartKeyFor(item) {
  return item.cartKey ?? `${item.id}-${item.unitId ?? "0"}`;
}

function mapLookupToCartProduct(data) {
  const product = data.product ?? data;
  const selectedUnit = data.selectedUnit ?? {
    id: data.unit_id,
    unit_name: data.unit_name ?? product.unit ?? "حبة",
    barcode: data.barcode ?? product.barcode,
    price: data.price ?? product.price,
    conversion_to_base: data.conversion_to_base ?? 1,
  };
  const unitId = selectedUnit?.id ?? data.unit_id;
  const productId = product.id ?? data.id;
  const weighed = Boolean(data.weighed ?? product.is_weighed);
  const weight = weighed ? Number(data.weight ?? data.quantity) : null;
  const cartKey = weighed
    ? `${productId}-${unitId ?? "0"}-w-${weight ?? Date.now()}`
    : `${productId}-${unitId ?? "0"}`;
  return {
    cartKey,
    id: productId,
    unitId,
    price: Number(selectedUnit?.price ?? data.price ?? product.price),
    weighed,
    weight,
    quantity: weighed && Number.isFinite(weight) && weight > 0 ? weight : undefined,
  };
}

function createScanHistoryEntry(cartKey, previousQty, wasNewRow) {
  return { cartKey, previousQty, wasNewRow };
}

function pushScanHistory(stack, entry) {
  return [...stack, entry];
}

function popScanHistory(stack) {
  if (!stack.length) return { stack, entry: null };
  const entry = stack[stack.length - 1];
  return { stack: stack.slice(0, -1), entry };
}

function applyUndoScan(cartItems, entry, keyFor) {
  if (!entry) return null;
  const idx = cartItems.findIndex((x) => keyFor(x) === entry.cartKey);
  if (idx < 0) return null;
  if (entry.wasNewRow) return cartItems.filter((_, i) => i !== idx);
  const next = [...cartItems];
  const row = { ...next[idx] };
  if (entry.previousQty <= 0) return cartItems.filter((_, i) => i !== idx);
  row.quantity = entry.previousQty;
  row.subtotal = row.quantity * row.price;
  next[idx] = row;
  return next;
}

const checkoutInitialState = {
  cartItems: [],
  scanHistory: [],
  lastScannedCartKey: null,
  error: null,
  blockedScan: null,
  receiptData: null,
};

function checkoutReducer(state, action) {
  switch (action.type) {
    case "ADD_PRODUCT": {
      const mapped = mapLookupToCartProduct(action.product);
      const price = Number(mapped.price);
      const prev = state.cartItems;
      if (mapped.weighed) {
        const quantity = Number(mapped.quantity ?? mapped.weight);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          return { ...state, error: "وزن غير صالح من الباركود" };
        }
        return {
          ...state,
          cartItems: [...prev, { ...mapped, quantity, subtotal: quantity * price }],
          scanHistory: pushScanHistory(state.scanHistory, createScanHistoryEntry(mapped.cartKey, 0, true)),
          lastScannedCartKey: mapped.cartKey,
        };
      }
      const idx = prev.findIndex((x) => cartKeyFor(x) === mapped.cartKey);
      if (idx >= 0) {
        const row = { ...prev[idx] };
        const previousQty = row.quantity;
        row.quantity += 1;
        row.subtotal = row.quantity * row.price;
        const cartItems = [...prev];
        cartItems[idx] = row;
        return {
          ...state,
          cartItems,
          scanHistory: pushScanHistory(state.scanHistory, createScanHistoryEntry(mapped.cartKey, previousQty, false)),
          lastScannedCartKey: mapped.cartKey,
        };
      }
      return {
        ...state,
        cartItems: [...prev, { ...mapped, quantity: 1, subtotal: price }],
        scanHistory: pushScanHistory(state.scanHistory, createScanHistoryEntry(mapped.cartKey, 0, true)),
        lastScannedCartKey: mapped.cartKey,
      };
    }
    case "UNDO_LAST_SCAN": {
      const { stack, entry } = popScanHistory(state.scanHistory);
      if (!entry) return state;
      const cartItems = applyUndoScan(state.cartItems, entry, cartKeyFor);
      if (!cartItems) return { ...state, scanHistory: stack };
      return { ...state, cartItems, scanHistory: stack, lastScannedCartKey: entry.cartKey };
    }
    case "CHANGE_QTY": {
      const { cartKey, newQty } = action;
      if (!(Number(newQty) > 0)) return state;
      const idx = state.cartItems.findIndex((x) => cartKeyFor(x) === cartKey);
      if (idx < 0) return state;
      const next = [...state.cartItems];
      const row = { ...next[idx], quantity: newQty };
      row.subtotal = newQty * row.price;
      next[idx] = row;
      return { ...state, cartItems: next, scanHistory: [] };
    }
    case "CLEAR_CART":
      return { ...checkoutInitialState };
    default:
      return state;
  }
}

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

  test("CHANGE_QTY allows fractional quantities", () => {
    let state = checkoutReducer(checkoutInitialState, {
      type: "ADD_PRODUCT",
      product: sampleProduct,
    });
    const key = cartKeyFor(state.cartItems[0]);
    state = checkoutReducer(state, { type: "CHANGE_QTY", cartKey: key, newQty: 0.25 });
    expect(state.cartItems[0].quantity).toBe(0.25);
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
