import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../apiClient";
import PosHeader from "../components/pos/PosHeader";
import PosCartTable from "../components/pos/PosCartTable";
import PosQuickGrid from "../components/pos/PosQuickGrid";
import PosPaymentPanel from "../components/pos/PosPaymentPanel";
import PosPaymentModal from "../components/pos/PosPaymentModal";
import PosRefundModal from "../components/pos/PosRefundModal";
import PosRefundNotifications from "../components/pos/PosRefundNotifications";
import { getAuthHeaders, getUser, removeToken } from "../utils/auth";
import { requiresShiftForPos } from "../utils/roles";
import ShiftStart from "../components/ShiftStart";
import ShiftEnd from "../components/ShiftEnd";
import { printReceipt } from "../utils/printReceipt";
import { estimateCartTotals } from "../utils/posTotals";
import "../components/ShiftModal.css";
import "./pos-theme.css";
import "./Checkout.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

const sameId = (a, b) => Number(a) === Number(b);

function newIdempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

const initialState = {
  cartItems: [],
  error: null,
  blockedScan: null,
  receiptData: null,
};

function checkoutReducer(state, action) {
  switch (action.type) {
    case "ADD_PRODUCT": {
      const product = action.product;
      const pid = Number(product.id);
      const price = Number(product.price);
      const stockNum = Number(product.stock);
      const prev = state.cartItems;
      const idx = prev.findIndex((x) => sameId(x.id, pid));

      if (idx >= 0) {
        const row = { ...prev[idx] };
        const newQty = row.quantity + 1;
        row.quantity = newQty;
        row.subtotal = newQty * row.price;
        const cartItems = [...prev];
        cartItems[idx] = row;
        return {
          ...state,
          cartItems,
          error: null,
          blockedScan: null,
          receiptData: null,
        };
      }

      return {
        ...state,
        cartItems: [
          ...prev,
          {
            id: pid,
            barcode: product.barcode,
            scanned_barcode: product.scanned_barcode ?? product.matched_barcode ?? null,
            product_barcode_id: product.product_barcode_id ?? null,
            name: product.name,
            price,
            stock: stockNum,
            tax_rate: product.tax_rate ?? null,
            quantity: 1,
            subtotal: price,
          },
        ],
        error: null,
        blockedScan: null,
        receiptData: null,
      };
    }
    case "REMOVE_ITEM":
      return {
        ...state,
        cartItems: state.cartItems.filter((x) => !sameId(x.id, action.id)),
      };
    case "CHANGE_QTY": {
      const { id, newQty } = action;
      if (newQty < 1) return state;
      const idx = state.cartItems.findIndex((x) => sameId(x.id, id));
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
        error: null,
        blockedScan: null,
      };
    }
    case "CLEAR_CART":
      return {
        ...state,
        cartItems: [],
        error: null,
        blockedScan: null,
        receiptData: null,
      };
    case "CHECKOUT_SUCCESS":
      return {
        ...state,
        cartItems: [],
        error: null,
        blockedScan: null,
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

export default function Checkout() {
  const navigate = useNavigate();
  const user = getUser();
  const [state, dispatch] = useReducer(checkoutReducer, initialState);
  const { cartItems, error, blockedScan, receiptData } = state;

  const [appSettings, setAppSettings] = useState(null);
  const [selectedPayment, setSelectedPayment] = useState(null);
  const [customerId, setCustomerId] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [shiftLoading, setShiftLoading] = useState(true);
  const [activeShift, setActiveShift] = useState(null);
  const [shiftTxCount, setShiftTxCount] = useState(0);
  const [endShiftOpen, setEndShiftOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);

  const posNeedsShift = requiresShiftForPos(user?.role);
  const shiftReady = !posNeedsShift || (!!activeShift && !shiftLoading);

  // One key per cart state: reused across retries of the SAME cart so the
  // server dedupes double submissions; reset whenever the cart changes.
  const idempotencyKeyRef = useRef(null);
  useEffect(() => {
    idempotencyKeyRef.current = null;
  }, [cartItems]);

  useEffect(() => {
    api
      .get("/api/settings", { headers: getAuthHeaders() })
      .then(({ data }) => setAppSettings(data))
      .catch(() => setAppSettings(null));
  }, []);

  const loadShift = useCallback(async () => {
    if (!posNeedsShift) {
      setShiftLoading(false);
      return;
    }
    setShiftLoading(true);
    try {
      const { data } = await api.get("/api/shifts/current", {
        headers: getAuthHeaders(),
      });
      setActiveShift(data.shift);
      setShiftTxCount(Number(data.transactions_count) || 0);
    } catch {
      setActiveShift(null);
      setShiftTxCount(0);
    } finally {
      setShiftLoading(false);
    }
  }, [posNeedsShift]);

  useEffect(() => {
    loadShift();
  }, [loadShift]);

  const estimated = useMemo(
    () => estimateCartTotals(cartItems, appSettings),
    [cartItems, appSettings]
  );

  const { subtotal, tax, total } = estimated;

  const addToCart = useCallback((product) => {
    dispatch({ type: "ADD_PRODUCT", product });
  }, []);

  const removeFromCart = useCallback((itemId) => {
    dispatch({ type: "REMOVE_ITEM", id: itemId });
  }, []);

  const changeQuantity = useCallback((itemId, newQty) => {
    if (newQty < 1) return;
    dispatch({ type: "CHANGE_QTY", id: itemId, newQty });
  }, []);

  const clearCart = useCallback(() => {
    dispatch({ type: "CLEAR_CART" });
    setSelectedPayment(null);
    setCustomerId(null);
    setPayModalOpen(false);
  }, []);

  async function completeSale() {
    if (!cartItems.length || !selectedPayment || isLoading) return;
    if (selectedPayment === "on_account" && !customerId) {
      dispatch({
        type: "CHECKOUT_ERROR",
        fallback: "اختر عميلاً للبيع على الذمة",
      });
      return;
    }
    dispatch({ type: "CLEAR_SALE_ERR" });
    setIsLoading(true);
    // Reuse the existing key on retry; mint one for a fresh attempt.
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = newIdempotencyKey();
    }
    let receiptToPrint = null;
    try {
      const items = cartItems.map((c) => ({
        product_id: c.id,
        quantity: c.quantity,
        price: c.price,
        ...(c.scanned_barcode
          ? { scanned_barcode: c.scanned_barcode, product_barcode_id: c.product_barcode_id ?? undefined }
          : {}),
      }));
      const body = {
        items,
        payment_method: selectedPayment,
        idempotency_key: idempotencyKeyRef.current,
      };
      if (customerId) body.customer_id = customerId;

      const { data } = await api.post("/api/checkout", body, {
        headers: {
          ...getAuthHeaders(),
          "Content-Type": "application/json",
        },
      });
      dispatch({ type: "CHECKOUT_SUCCESS", data });
      receiptToPrint = data?.receipt_text || null;
      idempotencyKeyRef.current = null; // next sale gets a fresh key
      setSelectedPayment(null);
      setCustomerId(null);
      setPayModalOpen(false);
      loadShift();
    } catch (e) {
      dispatch({
        type: "CHECKOUT_ERROR",
        payload: e.response?.data,
        fallback: e.message || "فشل إتمام البيع",
      });
    } finally {
      setIsLoading(false);
    }
    if (receiptToPrint) {
      printReceipt(receiptToPrint);
    }
  }

  function doPrintLocal() {
    if (receiptData?.receipt_text) printReceipt(receiptData.receipt_text);
  }

  function handleCompleteClick() {
    if (!cartItems.length || !shiftReady || isLoading) return;
    dispatch({ type: "CLEAR_SALE_ERR" });
    setSelectedPayment(null);
    setCustomerId(null);
    setPayModalOpen(true);
  }

  function handlePayModalClose() {
    if (isLoading) return;
    setPayModalOpen(false);
    setSelectedPayment(null);
    setCustomerId(null);
  }

  const canComplete = cartItems.length > 0 && !isLoading && shiftReady;

  return (
    <div className="pos-screen" dir="rtl" lang="ar">
      <PosHeader
        user={user}
        posNeedsShift={posNeedsShift}
        activeShift={activeShift}
        shiftTxCount={shiftTxCount}
        onEndShift={() => setEndShiftOpen(true)}
        onProductFound={addToCart}
      />

      <PosRefundNotifications />

      {blockedScan ? (
        <div className="pos-blocked">
          آخر مسح: {blockedScan.name} — {ils(blockedScan.price)} (متوفر: {blockedScan.stock})
        </div>
      ) : null}

      <div className="pos-main">
        <PosCartTable
          cartItems={cartItems}
          displayTotal={total}
          onQuantityChange={changeQuantity}
          onRemoveItem={removeFromCart}
        />
        <PosQuickGrid onProductFound={addToCart} />
      </div>

      <footer className="pos-footer">
        <div className="pos-toolbar">
          <button type="button" className="pos-toolbar-btn" onClick={clearCart}>
            مسح السلة
          </button>
          <button type="button" className="pos-toolbar-btn" onClick={() => setRefundOpen(true)}>
            استرجاع
          </button>
          <a href="/my-refunds" className="pos-toolbar-btn">
            طلباتي
          </a>
        </div>
        <PosPaymentPanel
          subtotal={subtotal}
          tax={tax}
          total={total}
          error={error}
          isLoading={isLoading}
          canComplete={canComplete}
          onComplete={handleCompleteClick}
          receiptData={receiptData}
          onPrintLocal={doPrintLocal}
        />
      </footer>

      <PosRefundModal
        open={refundOpen}
        onClose={() => setRefundOpen(false)}
        shiftReady={shiftReady}
        shiftId={activeShift?.id ?? null}
        onRefundSuccess={() => {
          setRefundOpen(false);
          loadShift();
        }}
      />

      <PosPaymentModal
        open={payModalOpen}
        total={total}
        selectedPayment={selectedPayment}
        onSelectPayment={setSelectedPayment}
        customerId={customerId}
        onSelectCustomer={setCustomerId}
        error={error}
        isLoading={isLoading}
        onTarhil={completeSale}
        onClose={handlePayModalClose}
      />

      {endShiftOpen && activeShift?.id ? (
        <ShiftEnd
          shiftId={activeShift.id}
          txCount={shiftTxCount}
          open={endShiftOpen}
          onClose={() => setEndShiftOpen(false)}
          onSuccess={() => {
            removeToken();
            navigate("/login", { replace: true });
          }}
        />
      ) : null}

      {posNeedsShift && !shiftLoading && !activeShift ? (
        <div className="shift-gate-overlay" aria-live="polite">
          <div className="shift-gate-backdrop" />
          <div className="shift-gate-card-wrap">
            <ShiftStart onSuccess={() => loadShift()} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
