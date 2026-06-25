import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import api from "../apiClient";
import BarcodeInput from "../components/BarcodeInput";
import Cart from "../components/Cart";
import RefundPanel from "../components/RefundPanel";
import PrintReceiptButton from "../components/PrintReceiptButton";
import { getAuthHeaders, getUser, removeToken } from "../utils/auth";
import { isAdminRole, requiresShiftForPos } from "../utils/roles";
import ShiftStart from "../components/ShiftStart";
import ShiftEnd from "../components/ShiftEnd";
import { printReceipt } from "../utils/printReceipt";
import "../components/ShiftModal.css";
import "./Checkout.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

const sameId = (a, b) => Number(a) === Number(b);

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

function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="clock">
      {now.toLocaleTimeString("ar-IL", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })}
    </span>
  );
}

export default function Checkout() {
  const navigate = useNavigate();
  const user = getUser();
  const [state, dispatch] = useReducer(checkoutReducer, initialState);
  const { cartItems, error, blockedScan, receiptData } = state;

  const [selectedPayment, setSelectedPayment] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [shiftLoading, setShiftLoading] = useState(true);
  const [activeShift, setActiveShift] = useState(null);
  const [shiftTxCount, setShiftTxCount] = useState(0);
  const [endShiftOpen, setEndShiftOpen] = useState(false);

  const posNeedsShift = requiresShiftForPos(user?.role);
  const shiftReady = !posNeedsShift || (!!activeShift && !shiftLoading);

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

  const { subtotal, tax, total } = useMemo(() => {
    // Frontend uses server response after checkout; before checkout show gross = total (inclusive)
    if (receiptData) {
      return {
        subtotal: receiptData.subtotal ?? 0,
        tax: receiptData.tax ?? 0,
        total: receiptData.total ?? 0,
      };
    }
    const s = cartItems.reduce((acc, it) => acc + (it.subtotal || 0), 0);
    return { subtotal: s, tax: 0, total: s };
  }, [cartItems, receiptData]);

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
  }, []);

  async function completeSale() {
    if (!cartItems.length || !selectedPayment) return;
    dispatch({ type: "CLEAR_SALE_ERR" });
    setIsLoading(true);
    try {
      const items = cartItems.map((c) => ({
        product_id: c.id,
        quantity: c.quantity,
        price: c.price,
        ...(c.scanned_barcode
          ? { scanned_barcode: c.scanned_barcode, product_barcode_id: c.product_barcode_id ?? undefined }
          : {}),
      }));
      const { data } = await api.post(
        "/api/checkout",
        { items, payment_method: selectedPayment },
        {
          headers: {
            ...getAuthHeaders(),
            "Content-Type": "application/json",
          },
        }
      );
      dispatch({ type: "CHECKOUT_SUCCESS", data });
      setSelectedPayment(null);
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
  }

  function doPrintLocal() {
    if (receiptData?.receipt_text) printReceipt(receiptData.receipt_text);
  }

  function logout() {
    removeToken();
    navigate("/login", { replace: true });
  }

  const canComplete =
    cartItems.length > 0 && selectedPayment && !isLoading && shiftReady;

  return (
    <div className="checkout-page" dir="rtl" lang="ar">
      <header className="checkout-top">
        <div className="checkout-top-left">
          {isAdminRole(user?.role) ? (
            <>
              <Link to="/reports" className="nav-pill">تقرير يومي</Link>
              <Link to="/finance" className="nav-pill">الموردين</Link>
              <Link to="/manage-products" className="nav-pill">المنتجات</Link>
              <Link to="/manage-users" className="nav-pill">الحسابات</Link>
              <Link to="/shift-audit" className="nav-pill">الورديات</Link>
              <Link to="/inventory" className="nav-pill">الجرد</Link>
              <Link to="/customers" className="nav-pill">العملاء</Link>
              <Link to="/banks" className="nav-pill">البنوك</Link>
              <Link to="/vouchers" className="nav-pill">السندات</Link>
              <Link to="/settings" className="nav-pill">الإعدادات</Link>
            </>
          ) : null}
        </div>
        <div className="checkout-top-right">
          {posNeedsShift && activeShift ? (
            <div className="checkout-shift-info">
              <span className="checkout-shift-pill">
                وردية من {activeShift.start_time?.replace("T", " ").slice(0, 16) || "—"}
              </span>
              <span className="checkout-shift-pill">مبيعات: {shiftTxCount}</span>
              <button
                type="button"
                className="checkout-shift-end-btn"
                onClick={() => setEndShiftOpen(true)}
              >
                إغلاق الوردية
              </button>
            </div>
          ) : null}
          <LiveClock />
          <span className="cashier-name">{user?.username}</span>
          <button type="button" className="logout-btn" onClick={logout}>
            خروج
          </button>
        </div>
      </header>

      <div className="checkout-layout">
        <div className="checkout-left">
          <BarcodeInput onProductFound={addToCart} onError={() => {}} />
          {blockedScan ? (
            <div className="blocked-scan-hint" dir="rtl" lang="ar">
              <div className="blocked-scan-title">آخر مسح (لم يُضف للسلة)</div>
              <div className="blocked-scan-name">{blockedScan.name}</div>
              <div className="blocked-scan-rows">
                <div className="blocked-scan-row">
                  <span>سعر الوحدة</span>
                  <span className="blocked-scan-price">
                    {ils(blockedScan.price)}
                  </span>
                </div>
                <div className="blocked-scan-row">
                  <span>المتوفر في النظام</span>
                  <span>{blockedScan.stock}</span>
                </div>
              </div>
            </div>
          ) : null}
          <Cart
            cartItems={cartItems}
            onQuantityChange={changeQuantity}
            onRemoveItem={removeFromCart}
          />
          <RefundPanel shiftReady={shiftReady} onRefundSuccess={loadShift} />
        </div>

        <aside className="checkout-right">
          <div className="big-total">{ils(total)}</div>
          <div className="side-lines">
            <div className="side-row">
              <span>المجموع الفرعي</span>
              <span>{ils(subtotal)}</span>
            </div>
            {tax > 0 ? (
              <div className="side-row vat-row">
                <span>ضريبة القيمة المضافة</span>
                <span>{ils(tax)}</span>
              </div>
            ) : null}
            <div className="side-row total-row">
              <span>الإجمالي</span>
              <span>{ils(total)}</span>
            </div>
          </div>

          <div className="pay-btns">
            <button
              type="button"
              className={selectedPayment === "cash" ? "pay-btn active" : "pay-btn"}
              onClick={() => setSelectedPayment("cash")}
            >
              نقد
            </button>
            <button
              type="button"
              className={selectedPayment === "visa" ? "pay-btn active" : "pay-btn"}
              onClick={() => setSelectedPayment("visa")}
            >
              بطاقة
            </button>
            <button
              type="button"
              className={selectedPayment === "on_account" ? "pay-btn active" : "pay-btn"}
              onClick={() => setSelectedPayment("on_account")}
            >
              ذمة
            </button>
          </div>

          {error ? <div className="checkout-err">{error}</div> : null}

          <button
            type="button"
            className="complete-btn"
            disabled={!canComplete}
            onClick={completeSale}
          >
            {isLoading ? "جاري المعالجة…" : "إتمام البيع"}
          </button>

          {receiptData?.receipt_text ? (
            <>
              <button
                type="button"
                className="complete-btn secondary"
                onClick={doPrintLocal}
              >
                طباعة الإيصال
              </button>
              <PrintReceiptButton transactionId={receiptData.transaction_id} />
            </>
          ) : null}

          <p className="side-cashier">الكاشير: {user?.username}</p>
        </aside>
      </div>

      {endShiftOpen && activeShift?.id ? (
        <ShiftEnd
          shiftId={activeShift.id}
          open={endShiftOpen}
          onClose={() => setEndShiftOpen(false)}
          onSuccess={() => {
            setActiveShift(null);
            setShiftTxCount(0);
            loadShift();
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
