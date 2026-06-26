import { cartKeyFor, mapLookupToCartProduct } from "./cartProduct";
import {
  createScanHistoryEntry,
  pushScanHistory,
  popScanHistory,
  applyUndoScan,
} from "./scanHistory";

const sameId = (a, b) => Number(a) === Number(b);

export const checkoutInitialState = {
  cartItems: [],
  scanHistory: [],
  lastScannedCartKey: null,
  error: null,
  blockedScan: null,
  receiptData: null,
};

export function checkoutReducer(state, action) {
  switch (action.type) {
    case "ADD_PRODUCT": {
      const mapped = mapLookupToCartProduct(action.product);
      const price = Number(mapped.price);
      const prev = state.cartItems;
      const idx = prev.findIndex((x) => cartKeyFor(x) === mapped.cartKey);

      if (idx >= 0) {
        const row = { ...prev[idx] };
        const previousQty = row.quantity;
        const newQty = row.quantity + 1;
        row.quantity = newQty;
        row.subtotal = newQty * row.price;
        const cartItems = [...prev];
        cartItems[idx] = row;
        const scanEntry = createScanHistoryEntry(mapped.cartKey, previousQty, false);
        return {
          ...state,
          cartItems,
          scanHistory: pushScanHistory(state.scanHistory, scanEntry),
          lastScannedCartKey: mapped.cartKey,
          error: null,
          blockedScan: null,
          receiptData: null,
        };
      }

      const scanEntry = createScanHistoryEntry(mapped.cartKey, 0, true);
      return {
        ...state,
        cartItems: [
          ...prev,
          {
            ...mapped,
            quantity: 1,
            subtotal: price,
          },
        ],
        scanHistory: pushScanHistory(state.scanHistory, scanEntry),
        lastScannedCartKey: mapped.cartKey,
        error: null,
        blockedScan: null,
        receiptData: null,
      };
    }
    case "UNDO_LAST_SCAN": {
      const { stack, entry } = popScanHistory(state.scanHistory);
      if (!entry) return state;
      const cartItems = applyUndoScan(state.cartItems, entry, cartKeyFor);
      if (!cartItems) return { ...state, scanHistory: stack };
      return {
        ...state,
        cartItems,
        scanHistory: stack,
        lastScannedCartKey: entry.cartKey,
        error: null,
        blockedScan: null,
      };
    }
    case "REMOVE_ITEM":
      return {
        ...state,
        cartItems: state.cartItems.filter((x) => cartKeyFor(x) !== action.cartKey),
        scanHistory: [],
      };
    case "CHANGE_QTY": {
      const { cartKey, newQty } = action;
      if (newQty < 1) return state;
      const idx = state.cartItems.findIndex((x) => cartKeyFor(x) === cartKey);
      if (idx < 0) return state;
      const prev = state.cartItems;
      const next = [...prev];
      const row = { ...next[idx] };
      row.quantity = newQty;
      row.subtotal = newQty * row.price;
      next[idx] = row;
      return {
        ...state,
        cartItems: next,
        scanHistory: [],
        error: null,
        blockedScan: null,
      };
    }
    case "CHANGE_UNIT": {
      const { cartKey, unitId } = action;
      const idx = state.cartItems.findIndex((x) => cartKeyFor(x) === cartKey);
      if (idx < 0) return state;
      const row = { ...state.cartItems[idx] };
      const unit = (row.availableUnits || []).find((u) => sameId(u.id, unitId));
      if (!unit) return state;
      const newKey = `${row.id}-${unit.id}`;
      const existingIdx = state.cartItems.findIndex(
        (x, i) => i !== idx && cartKeyFor(x) === newKey
      );
      if (existingIdx >= 0) {
        const merged = [...state.cartItems];
        const target = { ...merged[existingIdx] };
        target.quantity += row.quantity;
        target.subtotal = target.quantity * target.price;
        merged[existingIdx] = target;
        merged.splice(idx, 1);
        return { ...state, cartItems: merged, scanHistory: [], error: null, blockedScan: null };
      }
      row.cartKey = newKey;
      row.unitId = unit.id;
      row.unitName = unit.unit_name;
      row.barcode = unit.barcode;
      row.price = Number(unit.price);
      row.conversionToBase = Number(unit.conversion_to_base) || 1;
      row.subtotal = row.quantity * row.price;
      const cartItems = [...state.cartItems];
      cartItems[idx] = row;
      return { ...state, cartItems, scanHistory: [], error: null, blockedScan: null };
    }
    case "CLEAR_CART":
      return {
        ...checkoutInitialState,
      };
    case "LOAD_CART": {
      const incoming = Array.isArray(action.cartItems) ? action.cartItems : [];
      return {
        ...checkoutInitialState,
        cartItems: incoming,
        lastScannedCartKey: incoming.length ? cartKeyFor(incoming[incoming.length - 1]) : null,
      };
    }
    case "MERGE_CART": {
      const incoming = Array.isArray(action.cartItems) ? action.cartItems : [];
      if (!incoming.length) return state;
      const merged = [...state.cartItems];
      for (const row of incoming) {
        const key = cartKeyFor(row);
        const idx = merged.findIndex((x) => cartKeyFor(x) === key);
        if (idx >= 0) {
          const existing = { ...merged[idx] };
          existing.quantity += row.quantity;
          existing.subtotal = existing.quantity * existing.price;
          merged[idx] = existing;
        } else {
          merged.push({ ...row });
        }
      }
      return {
        ...state,
        cartItems: merged,
        scanHistory: [],
        error: null,
        blockedScan: null,
        receiptData: null,
      };
    }
    case "CHECKOUT_SUCCESS":
      return {
        ...checkoutInitialState,
        receiptData: action.data,
      };
    case "CHECKOUT_ERROR": {
      const d = action.payload;
      const errMsg = d?.error || action.fallback || "فشل إتمام البيع";
      return {
        ...state,
        error: errMsg,
        blockedScan:
          d && d.name != null && d.price != null
            ? {
                name: d.name,
                price: Number(d.price),
                stock: Number(d.stock),
              }
            : null,
      };
    }
    case "CLEAR_SALE_ERR":
      return { ...state, error: null, blockedScan: null };
    default:
      return state;
  }
}

export { cartKeyFor };
