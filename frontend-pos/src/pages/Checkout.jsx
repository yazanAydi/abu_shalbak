import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../apiClient";
import PosHeader from "../components/pos/PosHeader";
import PosCartTable from "../components/pos/PosCartTable";
import PosQuickGrid from "../components/pos/PosQuickGrid";
import PosPaymentPanel from "../components/pos/PosPaymentPanel";
import PosPaymentModal from "../components/pos/PosPaymentModal";
import PosClearCartModal from "../components/pos/PosClearCartModal";
import PosSuspendedSalesModal from "../components/pos/PosSuspendedSalesModal";
import PosSuspendedDetailModal from "../components/pos/PosSuspendedDetailModal";
import PosRestoreConflictModal from "../components/pos/PosRestoreConflictModal";
import PosRefundModal from "../components/pos/PosRefundModal";
import PosRefundNotifications from "../components/pos/PosRefundNotifications";
import PosApprovalWaitingModal, { approvalIls } from "../components/pos/PosApprovalWaitingModal";
import PosAdvanceRequestModal from "../components/pos/PosAdvanceRequestModal";
import { getAuthHeaders, getUser, removeToken } from "../utils/auth";
import { requiresShiftForPos } from "../utils/roles";
import ShiftStart from "../components/ShiftStart";
import ShiftEnd from "../components/ShiftEnd";
import { printReceipt } from "../utils/printReceipt";
import { estimateCartTotals, buildCartLineDiscounts } from "../utils/posTotals";
import { checkoutReducer, checkoutInitialState } from "../utils/checkoutCartReducer";
import {
  formatShortcutHint,
  mergePosShortcutsFromSettings,
} from "../config/posShortcuts";
import { matchesShortcut, shouldHandlePosShortcut } from "../utils/posKeyboard";
import { focusBarcodeInput } from "../utils/focusBarcodeInput";
import { playCheckoutDone, playScanSuccess, unlockPosAudio, warmPosSounds } from "../utils/posSounds";
import {
  cartItemsToSuspendPayload,
  suspendedItemsToCartItems,
} from "../utils/suspendedCart";
import "../components/ShiftModal.css";
import "./pos-theme.css";
import "./Checkout.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

function newIdempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

function extractApiError(e, fallback) {
  const body = e?.response?.data;
  if (body && typeof body === "object" && body.error) return String(body.error);
  if (e?.message && !/^Request failed with status code \d+$/.test(e.message)) {
    return e.message;
  }
  return fallback;
}

export default function Checkout() {
  const navigate = useNavigate();
  const user = getUser();
  const [state, dispatch] = useReducer(checkoutReducer, checkoutInitialState);
  const { cartItems, lastScannedCartKey, error, blockedScan, receiptData } = state;

  const [appSettings, setAppSettings] = useState(null);
  const [activePromos, setActivePromos] = useState([]);
  const [selectedPayment, setSelectedPayment] = useState(null);
  const [customerId, setCustomerId] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [clearCartOpen, setClearCartOpen] = useState(false);
  const [shiftLoading, setShiftLoading] = useState(true);
  const [activeShift, setActiveShift] = useState(null);
  const [shiftTxCount, setShiftTxCount] = useState(0);
  const [suspendedCount, setSuspendedCount] = useState(0);
  const [suspendedSales, setSuspendedSales] = useState([]);
  const [endShiftOpen, setEndShiftOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [onAccountWaitingId, setOnAccountWaitingId] = useState(null);
  const [holdLoading, setHoldLoading] = useState(false);
  const [posActionError, setPosActionError] = useState("");
  const [suspendedModalOpen, setSuspendedModalOpen] = useState(false);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [suspendedDetail, setSuspendedDetail] = useState(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [restoreConflictOpen, setRestoreConflictOpen] = useState(false);
  const [pendingRestoreId, setPendingRestoreId] = useState(null);
  const [activeSuspendedSaleId, setActiveSuspendedSaleId] = useState(null);

  const posActionErrorTimerRef = useRef(null);

  const showPosActionError = useCallback((message) => {
    if (posActionErrorTimerRef.current) {
      window.clearTimeout(posActionErrorTimerRef.current);
    }
    setPosActionError(message);
    posActionErrorTimerRef.current = window.setTimeout(() => {
      setPosActionError("");
      posActionErrorTimerRef.current = null;
    }, 5000);
  }, []);

  useEffect(
    () => () => {
      if (posActionErrorTimerRef.current) {
        window.clearTimeout(posActionErrorTimerRef.current);
      }
    },
    []
  );

  const posNeedsShift = requiresShiftForPos(user?.role);
  const shiftReady = !posNeedsShift || (!!activeShift && !shiftLoading);

  const shortcuts = useMemo(
    () => mergePosShortcutsFromSettings(appSettings),
    [appSettings]
  );

  const idempotencyKeyRef = useRef(null);
  useEffect(() => {
    idempotencyKeyRef.current = null;
  }, [cartItems]);

  const loadActivePromos = useCallback(() => {
    api
      .get("/api/marketing/active", { headers: getAuthHeaders() })
      .then(({ data }) => setActivePromos(Array.isArray(data) ? data : []))
      .catch(() => setActivePromos([]));
  }, []);

  useEffect(() => {
    warmPosSounds();
    api
      .get("/api/settings", { headers: getAuthHeaders() })
      .then(({ data }) => setAppSettings(data))
      .catch(() => setAppSettings(null));
    loadActivePromos();
  }, [loadActivePromos]);

  useEffect(() => {
    loadActivePromos();
  }, [cartItems, loadActivePromos]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") loadActivePromos();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [loadActivePromos]);

  const loadSuspendedList = useCallback(async () => {
    if (!shiftReady) {
      setSuspendedCount(0);
      setSuspendedSales([]);
      return;
    }
    try {
      const { data } = await api.get("/api/suspended-sales", { headers: getAuthHeaders() });
      setSuspendedCount(Number(data.count) || 0);
      setSuspendedSales(data.sales || []);
    } catch {
      setSuspendedCount(0);
      setSuspendedSales([]);
    }
  }, [shiftReady]);

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
      setSuspendedCount(Number(data.suspended_sales_count) || 0);
    } catch {
      setActiveShift(null);
      setShiftTxCount(0);
      setSuspendedCount(0);
    } finally {
      setShiftLoading(false);
    }
  }, [posNeedsShift]);

  useEffect(() => {
    loadShift();
  }, [loadShift]);

  useEffect(() => {
    if (shiftReady) loadSuspendedList();
  }, [shiftReady, loadSuspendedList]);

  const estimated = useMemo(
    () => estimateCartTotals(cartItems, appSettings, activePromos),
    [cartItems, appSettings, activePromos]
  );

  const lineDiscounts = useMemo(
    () => buildCartLineDiscounts(cartItems, activePromos),
    [cartItems, activePromos]
  );

  const { subtotal, tax, discount, total } = estimated;

  const addToCart = useCallback((product) => {
    dispatch({ type: "ADD_PRODUCT", product });
    playScanSuccess();
  }, []);

  const removeFromCart = useCallback((cartKey) => {
    dispatch({ type: "REMOVE_ITEM", cartKey });
    focusBarcodeInput();
  }, []);

  const changeQuantity = useCallback((cartKey, newQty) => {
    if (newQty < 1) return;
    dispatch({ type: "CHANGE_QTY", cartKey, newQty });
    focusBarcodeInput();
  }, []);

  const changeUnit = useCallback((cartKey, unitId) => {
    dispatch({ type: "CHANGE_UNIT", cartKey, unitId });
    focusBarcodeInput();
  }, []);

  const resetInvoiceState = useCallback(() => {
    dispatch({ type: "CLEAR_CART" });
    setSelectedPayment(null);
    setCustomerId(null);
    setPayModalOpen(false);
    setActiveSuspendedSaleId(null);
    focusBarcodeInput();
  }, []);

  const requestClearCart = useCallback(() => {
    if (!cartItems.length) return;
    setClearCartOpen(true);
  }, [cartItems.length]);

  const undoLastScan = useCallback(() => {
    if (!state.scanHistory?.length) return;
    dispatch({ type: "UNDO_LAST_SCAN" });
    focusBarcodeInput();
  }, [state.scanHistory?.length]);

  const suspendCartItems = useCallback(async (items, note) => {
    const { data } = await api.post(
      "/api/suspended-sales",
      { note: note?.trim() || null, items: cartItemsToSuspendPayload(items) },
      { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
    );
    return data;
  }, []);

  const fetchSuspendedDetail = useCallback(async (id) => {
    const { data } = await api.get(`/api/suspended-sales/${id}`, {
      headers: getAuthHeaders(),
    });
    return data;
  }, []);

  const applyRestoreFromDetail = useCallback(
    (detail, mode) => {
      const cartRows = suspendedItemsToCartItems(detail.items);
      if (mode === "merge") {
        dispatch({ type: "MERGE_CART", cartItems: cartRows });
      } else {
        dispatch({ type: "LOAD_CART", cartItems: cartRows });
      }
      setActiveSuspendedSaleId(detail.id);
      setSuspendedModalOpen(false);
      setRestoreConflictOpen(false);
      setPendingRestoreId(null);
      setDetailModalOpen(false);
      focusBarcodeInput();
    },
    []
  );

  const restoreSuspendedSale = useCallback(
    async (id, mode = "load") => {
      const detail = await fetchSuspendedDetail(id);
      applyRestoreFromDetail(detail, mode);
      await loadSuspendedList();
      await loadShift();
    },
    [applyRestoreFromDetail, fetchSuspendedDetail, loadShift, loadSuspendedList]
  );

  const requestRestore = useCallback(
    (id) => {
      if (cartItems.length > 0) {
        setPendingRestoreId(id);
        setRestoreConflictOpen(true);
        return;
      }
      restoreSuspendedSale(id, "load").catch((e) => {
        showPosActionError(extractApiError(e, "فشل استرجاع الفاتورة"));
      });
    },
    [cartItems.length, restoreSuspendedSale, showPosActionError]
  );

  const syncSuspendedCart = useCallback(
    async (saleId, items) => {
      await api.put(
        `/api/suspended-sales/${saleId}`,
        { items: cartItemsToSuspendPayload(items) },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
    },
    []
  );

  const completeSale = useCallback(
    async (paymentPayload = null) => {
      const pay = paymentPayload || { payment_method: selectedPayment };
      if (!cartItems.length || !pay.payment_method || isLoading) return;
      if (pay.payment_method === "on_account" && !customerId) {
        dispatch({
          type: "CHECKOUT_ERROR",
          fallback: "اختر عميلاً للبيع على الذمة",
        });
        return;
      }
      dispatch({ type: "CLEAR_SALE_ERR" });
      setIsLoading(true);
      unlockPosAudio();
      if (!idempotencyKeyRef.current) {
        idempotencyKeyRef.current = newIdempotencyKey();
      }
      let receiptToPrint = null;
      try {
        const items = cartItems.map((c) => ({
          product_id: c.id,
          unit_id: c.unitId,
          quantity: c.quantity,
          price: c.price,
          ...(c.scanned_barcode ? { scanned_barcode: c.scanned_barcode } : {}),
        }));
        const body = {
          items,
          idempotency_key: idempotencyKeyRef.current,
          ...pay,
        };
        if (customerId) body.customer_id = customerId;
        if (activeSuspendedSaleId) {
          await syncSuspendedCart(activeSuspendedSaleId, cartItems);
          body.suspended_sale_id = activeSuspendedSaleId;
        }

        const { data } = await api.post("/api/checkout", body, {
          headers: {
            ...getAuthHeaders(),
            "Content-Type": "application/json",
          },
        });
        const payload = data?.data ?? data;
        if (payload?.pending_approval && payload?.request_id) {
          setOnAccountWaitingId(payload.request_id);
          setPayModalOpen(false);
          return;
        }
        dispatch({ type: "CHECKOUT_SUCCESS", data: payload });
        playCheckoutDone();
        receiptToPrint = payload?.receipt_html || payload?.receipt_text ? payload : null;
        idempotencyKeyRef.current = null;
        setSelectedPayment(null);
        setCustomerId(null);
        setPayModalOpen(false);
        setActiveSuspendedSaleId(null);
        loadShift();
        loadSuspendedList();
        focusBarcodeInput();
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
    },
    [
      cartItems,
      customerId,
      isLoading,
      loadShift,
      loadSuspendedList,
      selectedPayment,
      activeSuspendedSaleId,
      syncSuspendedCart,
    ]
  );

  const finalizeApprovedOnAccountSale = useCallback(
    (detail) => {
      const checkout = detail?.checkout;
      if (!checkout) return;
      dispatch({ type: "CHECKOUT_SUCCESS", data: checkout });
      playCheckoutDone();
      idempotencyKeyRef.current = null;
      setSelectedPayment(null);
      setCustomerId(null);
      setOnAccountWaitingId(null);
      setActiveSuspendedSaleId(null);
      loadShift();
      loadSuspendedList();
      focusBarcodeInput();
      if (checkout.receipt_html || checkout.receipt_text) {
        printReceipt(checkout);
      }
    },
    [loadShift, loadSuspendedList]
  );

  function handleOnAccountWaitingClose() {
    setOnAccountWaitingId(null);
    focusBarcodeInput();
  }

  function doPrintLocal() {
    if (receiptData?.receipt_html || receiptData?.receipt_text) printReceipt(receiptData);
  }

  function handleCompleteClick() {
    if (!cartItems.length || !shiftReady || isLoading) return;
    dispatch({ type: "CLEAR_SALE_ERR" });
    setSelectedPayment(null);
    setCustomerId(null);
    setPayModalOpen(true);
  }

  async function holdCartNow() {
    if (!cartItems.length || !shiftReady || holdLoading) return;
    setHoldLoading(true);
    try {
      await suspendCartItems(cartItems, null);
      dispatch({ type: "CLEAR_CART" });
      setActiveSuspendedSaleId(null);
      await loadSuspendedList();
      await loadShift();
      focusBarcodeInput();
    } catch (e) {
      const status = e?.response?.status;
      const msg =
        status === 404
          ? "خدمة تعليق الفاتورة غير متوفرة — أعد تشغيل الخادم أو حدّث Docker"
          : extractApiError(e, "فشل تعليق الفاتورة");
      showPosActionError(msg);
    } finally {
      setHoldLoading(false);
    }
  }

  async function openSuspendedList() {
    await loadSuspendedList();
    setSuspendedModalOpen(true);
    setDeleteConfirmId(null);
  }

  async function viewSuspendedDetails(id) {
    try {
      const detail = await fetchSuspendedDetail(id);
      setSuspendedDetail(detail);
      setDetailModalOpen(true);
    } catch (e) {
      showPosActionError(extractApiError(e, "تعذّر تحميل التفاصيل"));
    }
  }

  async function confirmDeleteSuspended(id) {
    try {
      await api.delete(`/api/suspended-sales/${id}`, { headers: getAuthHeaders() });
      setDeleteConfirmId(null);
      if (activeSuspendedSaleId === id) setActiveSuspendedSaleId(null);
      await loadSuspendedList();
      await loadShift();
      focusBarcodeInput();
    } catch (e) {
      showPosActionError(extractApiError(e, "فشل حذف الفاتورة المعلقة"));
    }
  }

  async function handleHoldAndRestore() {
    if (!pendingRestoreId) return;
    setHoldLoading(true);
    try {
      if (cartItems.length) {
        await suspendCartItems(cartItems, null);
      }
      await restoreSuspendedSale(pendingRestoreId, "load");
    } catch (e) {
      showPosActionError(extractApiError(e, "فشل استرجاع الفاتورة"));
    } finally {
      setHoldLoading(false);
    }
  }

  function handleMergeRestore() {
    if (!pendingRestoreId) return;
    restoreSuspendedSale(pendingRestoreId, "merge").catch((e) => {
      showPosActionError(extractApiError(e, "فشل دمج الفاتورة"));
    });
  }

  const handleCompleteClickRef = useRef(handleCompleteClick);
  handleCompleteClickRef.current = handleCompleteClick;

  const undoLastScanRef = useRef(undoLastScan);
  undoLastScanRef.current = undoLastScan;

  const requestClearCartRef = useRef(requestClearCart);
  requestClearCartRef.current = requestClearCart;

  const holdCartNowRef = useRef(holdCartNow);
  holdCartNowRef.current = holdCartNow;

  const openSuspendedListRef = useRef(openSuspendedList);
  openSuspendedListRef.current = openSuspendedList;

  const shortcutsBlocked =
    payModalOpen ||
    endShiftOpen ||
    refundOpen ||
    clearCartOpen ||
    suspendedModalOpen ||
    detailModalOpen ||
    restoreConflictOpen;

  useEffect(() => {
    function onKeyDown(ev) {
      if (shortcutsBlocked) return;
      if (!shouldHandlePosShortcut(ev)) return;

      if (matchesShortcut(ev, shortcuts.undoLastScan.key)) {
        if (!cartItems.length || isLoading) return;
        ev.preventDefault();
        undoLastScanRef.current();
        return;
      }

      if (matchesShortcut(ev, shortcuts.newInvoice.key)) {
        ev.preventDefault();
        requestClearCartRef.current();
        return;
      }

      if (shortcuts.holdCart.key && matchesShortcut(ev, shortcuts.holdCart.key)) {
        ev.preventDefault();
        holdCartNowRef.current();
        return;
      }

      if (
        shortcuts.suspendedCarts.key &&
        matchesShortcut(ev, shortcuts.suspendedCarts.key)
      ) {
        ev.preventDefault();
        openSuspendedListRef.current();
        return;
      }

      if (matchesShortcut(ev, shortcuts.completeSale.key)) {
        if (!cartItems.length || !shiftReady || isLoading) return;
        ev.preventDefault();
        handleCompleteClickRef.current();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cartItems.length, shiftReady, isLoading, shortcutsBlocked, shortcuts]);

  useEffect(() => {
    function onKeyDown(ev) {
      if (ev.key !== "Enter") return;
      if (shortcutsBlocked) return;
      const active = document.activeElement;
      if (!active || active.tagName !== "BUTTON") return;
      if (!active.closest(".pos-cart-panel")) return;
      ev.preventDefault();
      ev.stopPropagation();
      focusBarcodeInput();
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [shortcutsBlocked]);

  function handlePayModalClose() {
    if (isLoading) return;
    setPayModalOpen(false);
    setSelectedPayment(null);
    setCustomerId(null);
    focusBarcodeInput();
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

      {suspendedCount > 0 ? (
        <div className="pos-suspended-banner" role="status">
          يوجد فواتير معلقة ({suspendedCount})
        </div>
      ) : null}

      {posActionError ? <div className="pos-action-error">{posActionError}</div> : null}

      {blockedScan ? (
        <div className="pos-blocked">
          آخر مسح: {blockedScan.name} — {ils(blockedScan.price)} (متوفر: {blockedScan.stock})
        </div>
      ) : null}

      <div className="pos-main">
        <PosCartTable
          cartItems={cartItems}
          scrollToCartKey={lastScannedCartKey}
          lineDiscounts={lineDiscounts}
          activePromos={activePromos}
          onQuantityChange={changeQuantity}
          onRemoveItem={removeFromCart}
          onUnitChange={changeUnit}
        />
        <PosQuickGrid onProductFound={addToCart} />
      </div>

      <footer className="pos-footer">
        <div className="pos-toolbar">
          <button type="button" className="pos-toolbar-btn" onClick={requestClearCart}>
            مسح السلة
          </button>
          <button
            type="button"
            className="pos-toolbar-btn"
            onClick={holdCartNow}
            disabled={holdLoading || !shiftReady}
          >
            {holdLoading ? "جاري التعليق…" : "تعليق الفاتورة"}
          </button>
          <button
            type="button"
            className="pos-toolbar-btn pos-toolbar-btn--badge"
            onClick={openSuspendedList}
          >
            الفواتير المعلقة
            {suspendedCount > 0 ? (
              <span className="pos-toolbar-badge">({suspendedCount})</span>
            ) : null}
          </button>
          <button type="button" className="pos-toolbar-btn" onClick={() => setRefundOpen(true)}>
            استرجاع
          </button>
          <button type="button" className="pos-toolbar-btn" onClick={() => setAdvanceOpen(true)}>
            سلف
          </button>
        </div>
        <div className="pos-shortcut-hints">
          <span>{formatShortcutHint(shortcuts.undoLastScan)}</span>
          <span>{formatShortcutHint(shortcuts.newInvoice)}</span>
          {shortcuts.holdCart.key ? (
            <span>{formatShortcutHint(shortcuts.holdCart)}</span>
          ) : null}
          {shortcuts.suspendedCarts.key ? (
            <span>{formatShortcutHint(shortcuts.suspendedCarts)}</span>
          ) : null}
        </div>
        <PosPaymentPanel
          subtotal={subtotal}
          tax={tax}
          discount={discount}
          total={total}
          error={error}
          isLoading={isLoading}
          canComplete={canComplete}
          onComplete={handleCompleteClick}
          receiptData={receiptData}
          onPrintLocal={doPrintLocal}
        />
      </footer>

      <PosClearCartModal
        open={clearCartOpen}
        onClose={() => {
          setClearCartOpen(false);
          focusBarcodeInput();
        }}
        onConfirm={() => {
          setClearCartOpen(false);
          resetInvoiceState();
        }}
      />

      <PosSuspendedSalesModal
        open={suspendedModalOpen}
        sales={suspendedSales}
        onClose={() => {
          setSuspendedModalOpen(false);
          setDeleteConfirmId(null);
          focusBarcodeInput();
        }}
        onRestore={requestRestore}
        onDelete={(id) => setDeleteConfirmId(id)}
        onViewDetails={viewSuspendedDetails}
        deleteConfirmId={deleteConfirmId}
        onConfirmDelete={confirmDeleteSuspended}
        onCancelDelete={() => setDeleteConfirmId(null)}
      />

      <PosSuspendedDetailModal
        open={detailModalOpen}
        detail={suspendedDetail}
        onClose={() => {
          setDetailModalOpen(false);
          focusBarcodeInput();
        }}
      />

      <PosRestoreConflictModal
        open={restoreConflictOpen}
        onHoldAndRestore={handleHoldAndRestore}
        onMerge={handleMergeRestore}
        onCancel={() => {
          setRestoreConflictOpen(false);
          setPendingRestoreId(null);
          focusBarcodeInput();
        }}
      />

      <PosAdvanceRequestModal open={advanceOpen} onClose={() => setAdvanceOpen(false)} />

      <PosApprovalWaitingModal
        open={!!onAccountWaitingId}
        requestId={onAccountWaitingId}
        apiPath="/api/on-account-requests"
        titlePrefix="طلب ذمة"
        statusLabels={{
          pending: "بانتظار موافقة المدير على البيع بالذمة…",
          approved: "تمت الموافقة — اكتمل البيع",
          rejected: "تم رفض البيع على الذمة",
          expired: "انتهت صلاحية الطلب",
        }}
        detailLine={(d) => {
          if (!d) return null;
          const parts = [];
          if (d.customer_name) parts.push(`العميل: ${d.customer_name}`);
          if (d.on_account_amount != null) parts.push(`الذمة: ${approvalIls(d.on_account_amount)}`);
          return parts.length ? parts.join(" — ") : null;
        }}
        onClose={handleOnAccountWaitingClose}
        onTerminal={(detail) => {
          if (detail.status === "approved") {
            finalizeApprovedOnAccountSale(detail);
          }
        }}
      />

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
          suspendedCount={suspendedCount}
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

export { checkoutReducer, checkoutInitialState };
