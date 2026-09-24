import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import api from "../apiClient";
import PosHeader from "../components/pos/PosHeader";
import PosCartTable from "../components/pos/PosCartTable";
import PosQuickGrid from "../components/pos/PosQuickGrid";
import PosPaymentPanel from "../components/pos/PosPaymentPanel";
import PosPaymentModal from "../components/pos/PosPaymentModal";
import PosRefundNotifications from "../components/pos/PosRefundNotifications";
import PosPrintQueue from "../components/pos/PosPrintQueue";
import { getAuthHeaders, getUser, removeToken } from "../utils/auth";
import { requiresShiftForPos } from "../utils/roles";
import ShiftStart from "../components/ShiftStart";
import { openReceiptForPrinting, printReceipt } from "../utils/printReceipt";
import { RECEIPT_PRINT_TAB_NAME } from "../utils/printDocument";
import { submitCompleteSale } from "../utils/completeSaleSubmit";
import { estimateCartTotals, buildCartLineDiscounts } from "../utils/posTotals";
import { checkoutReducer, checkoutInitialState } from "../utils/checkoutCartReducer";
import {
  formatShortcutHint,
  mergePosShortcutsFromSettings,
} from "../config/posShortcuts";
import { matchesShortcut, shouldHandlePosShortcut } from "../utils/posKeyboard";
import { resolveF9CheckoutAction } from "../utils/f9Checkout";
import { focusBarcodeInput } from "../utils/focusBarcodeInput";
import { readWaitingRequestId, writeWaitingRequestId } from "../utils/posWaitingRequests";
import { playScanSuccess, warmPosSounds } from "../utils/posSounds";
import {
  cartItemsToSuspendPayload,
  suspendedItemsToCartItems,
} from "../utils/suspendedCart";
import "../components/ShiftModal.css";
import "./pos-theme.css";
import "./Checkout.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

// Modals that are only opened occasionally, so their code (and in PosRefundModal's
// case the whole RefundPanel) stays out of the chunk the till loads to start
// scanning. Each one already renders nothing while closed, so mounting them only
// when open is behaviour-neutral.
const PosClearCartModal = lazy(() => import("../components/pos/PosClearCartModal"));
const PosSuspendedSalesModal = lazy(() => import("../components/pos/PosSuspendedSalesModal"));
const PosSuspendedDetailModal = lazy(() => import("../components/pos/PosSuspendedDetailModal"));
const PosRestoreConflictModal = lazy(() => import("../components/pos/PosRestoreConflictModal"));
const PosRefundModal = lazy(() => import("../components/pos/PosRefundModal"));
const PosAdvanceRequestModal = lazy(() => import("../components/pos/PosAdvanceRequestModal"));
const PosSupplierPaymentModal = lazy(() => import("../components/pos/PosSupplierPaymentModal"));
const PosShopConsumptionModal = lazy(() => import("../components/pos/PosShopConsumptionModal"));
const PosApprovalWaitingModal = lazy(() => import("../components/pos/PosApprovalWaitingModal"));
const ShiftEnd = lazy(() => import("../components/ShiftEnd"));

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
  const { cartItems, lastScannedCartKey, error, blockedScan, receiptData, printWarning } = state;

  const [appSettings, setAppSettings] = useState(null);
  const [activePromos, setActivePromos] = useState([]);
  const [selectedPayment, setSelectedPayment] = useState(null);
  const [customerId, setCustomerId] = useState(null);
  const [employeeId, setEmployeeId] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [clearCartOpen, setClearCartOpen] = useState(false);
  const [shiftLoading, setShiftLoading] = useState(true);
  const [shiftLoadError, setShiftLoadError] = useState("");
  const [posRefreshing, setPosRefreshing] = useState(false);
  const [activeShift, setActiveShift] = useState(null);
  const [shiftTxCount, setShiftTxCount] = useState(0);
  const [suspendedCount, setSuspendedCount] = useState(0);
  const [suspendedSales, setSuspendedSales] = useState([]);
  const [endShiftOpen, setEndShiftOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [supplierPayOpen, setSupplierPayOpen] = useState(false);
  const [shopExpenseOpen, setShopExpenseOpen] = useState(false);
  const [advanceWaitingId, setAdvanceWaitingId] = useState(() => readWaitingRequestId("advance"));
  const [onAccountWaitingId, setOnAccountWaitingId] = useState(() =>
    readWaitingRequestId("onAccount")
  );
  const [cashDebtWaitingId, setCashDebtWaitingId] = useState(() =>
    readWaitingRequestId("cashDebt")
  );
  const [supplierWaitingId, setSupplierWaitingId] = useState(() =>
    readWaitingRequestId("supplierPayment")
  );
  const [shopExpenseWaitingId, setShopExpenseWaitingId] = useState(() =>
    readWaitingRequestId("shopExpense")
  );
  const finalizedOnAccountRef = useRef(new Set());
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
  const submittedPayloadRef = useRef(null);
  const isSubmittingRef = useRef(false);

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
      return null;
    }
    setShiftLoading(true);
    try {
      const { data } = await api.get("/api/shifts/current", {
        headers: getAuthHeaders(),
      });
      setActiveShift(data.shift);
      setShiftTxCount(Number(data.transactions_count) || 0);
      setSuspendedCount(Number(data.suspended_sales_count) || 0);
      setShiftLoadError("");
      return data.shift || null;
    } catch (e) {
      setActiveShift(null);
      setShiftTxCount(0);
      setSuspendedCount(0);
      setShiftLoadError(extractApiError(e, "تعذّر تحميل الوردية"));
      return null;
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

  const refreshPos = useCallback(async () => {
    if (isLoading) return;
    setPosRefreshing(true);
    try {
      const shift = await loadShift();
      loadActivePromos();
      try {
        const { data } = await api.get("/api/settings", { headers: getAuthHeaders() });
        setAppSettings(data);
      } catch {
        setAppSettings(null);
      }
      if (!posNeedsShift || shift) {
        try {
          const { data } = await api.get("/api/suspended-sales", { headers: getAuthHeaders() });
          setSuspendedCount(Number(data.count) || 0);
          setSuspendedSales(data.sales || []);
        } catch {
          setSuspendedCount(0);
          setSuspendedSales([]);
        }
      }
    } finally {
      setPosRefreshing(false);
    }
  }, [isLoading, loadShift, loadActivePromos, posNeedsShift]);

  const estimated = useMemo(
    () => estimateCartTotals(cartItems, appSettings, activePromos),
    [cartItems, appSettings, activePromos]
  );

  const lineDiscounts = useMemo(
    () => buildCartLineDiscounts(cartItems, activePromos),
    [cartItems, activePromos]
  );

  const { tax, discount, total, roundingAdjustment } = estimated;

  const addToCart = useCallback((product) => {
    if (isLoading) return;
    dispatch({ type: "ADD_PRODUCT", product });
    playScanSuccess();
  }, [isLoading]);

  const removeFromCart = useCallback((cartKey) => {
    dispatch({ type: "REMOVE_ITEM", cartKey });
    focusBarcodeInput();
  }, []);

  const changeQuantity = useCallback((cartKey, newQty) => {
    if (newQty === "" || newQty == null) {
      dispatch({ type: "CHANGE_QTY", cartKey, newQty: "" });
      return;
    }
    if (!(Number(newQty) > 0)) return;
    dispatch({ type: "CHANGE_QTY", cartKey, newQty });
  }, []);

  const changeUnit = useCallback((cartKey, unitId) => {
    dispatch({ type: "CHANGE_UNIT", cartKey, unitId });
    focusBarcodeInput();
  }, []);

  const resetInvoiceState = useCallback(() => {
    dispatch({ type: "CLEAR_CART" });
    setSelectedPayment(null);
    setCustomerId(null);
    setEmployeeId(null);
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
      await submitCompleteSale({
        paymentPayload,
        selectedPayment,
        cartItems,
        customerId,
        employeeId,
        isLoading,
        isSubmittingRef,
        idempotencyKeyRef,
        submittedPayloadRef,
        activeSuspendedSaleId,
        dispatch,
        setIsLoading,
        setOnAccountWaitingId,
        setPayModalOpen,
        setSelectedPayment,
        setCustomerId,
        setEmployeeId,
        setActiveSuspendedSaleId,
        loadShift,
        loadSuspendedList,
        syncSuspendedCart,
      });
    },
    [
      cartItems,
      customerId,
      employeeId,
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
      const requestId = detail.request_id ?? detail.id;
      if (requestId && finalizedOnAccountRef.current.has(Number(requestId))) return;
      if (requestId) finalizedOnAccountRef.current.add(Number(requestId));
      dispatch({ type: "CHECKOUT_SUCCESS", data: checkout });
      idempotencyKeyRef.current = null;
      submittedPayloadRef.current = null;
      setSelectedPayment(null);
      setCustomerId(null);
      setEmployeeId(null);
      writeWaitingRequestId("onAccount", null);
      setOnAccountWaitingId(null);
      setActiveSuspendedSaleId(null);
      loadShift();
      loadSuspendedList();
      focusBarcodeInput();
      /* Approved ذمة prints once from the cashier print queue, not from this callback. */
    },
    [loadShift, loadSuspendedList]
  );

  const ackDecision = useCallback(async (apiPath, requestId) => {
    if (!requestId) return;
    try {
      await api.post(`${apiPath}/${requestId}/acknowledge`, {}, { headers: getAuthHeaders() });
    } catch {
      /* unread notifications remain the fallback */
    }
  }, []);

  const handleOnAccountTerminal = useCallback(
    async (detail) => {
      const id = detail?.request_id ?? detail?.id ?? onAccountWaitingId;
      await ackDecision("/api/on-account-requests", id);
      if (detail?.status === "approved") {
        finalizeApprovedOnAccountSale(detail);
        return;
      }
      if (detail?.status === "rejected") {
        writeWaitingRequestId("onAccount", null);
      }
    },
    [ackDecision, finalizeApprovedOnAccountSale, onAccountWaitingId]
  );

  const handleCashDebtTerminal = useCallback(
    async (detail) => {
      const id = detail?.request_id ?? detail?.id ?? cashDebtWaitingId;
      await ackDecision("/api/customer-cash-debt-requests", id);
      if (detail?.status === "approved" || detail?.status === "rejected") {
        writeWaitingRequestId("cashDebt", null);
        loadShift();
      }
    },
    [ackDecision, cashDebtWaitingId, loadShift]
  );

  const handleAdvanceTerminal = useCallback(
    async (detail) => {
      const id = detail?.request_id ?? detail?.id ?? advanceWaitingId;
      await ackDecision("/api/advance-requests", id);
      if (detail?.status === "rejected" || detail?.status === "approved") {
        writeWaitingRequestId("advance", null);
      }
    },
    [ackDecision, advanceWaitingId]
  );

  function handleOnAccountWaitingClose() {
    writeWaitingRequestId("onAccount", null);
    setOnAccountWaitingId(null);
    focusBarcodeInput();
  }

  function handleAdvanceWaitingClose() {
    writeWaitingRequestId("advance", null);
    setAdvanceWaitingId(null);
    focusBarcodeInput();
  }

  function doPrintLocal() {
    if (receiptData?.transaction_id) {
      printReceipt(receiptData);
    }
  }

  function doOpenReceiptTab() {
    if (!receiptData?.transaction_id) return;
    const tab = typeof window.open === "function" ? window.open("about:blank", RECEIPT_PRINT_TAB_NAME) : null;
    openReceiptForPrinting(receiptData, { tab });
  }

  function handleCompleteClick() {
    if (!cartItems.length || !shiftReady || isLoading) return;
    if (cartItems.some((it) => !(Number(it.quantity) > 0))) {
      dispatch({ type: "CHECKOUT_ERROR", fallback: "أدخل الوزن بالكيلو قبل إتمام البيع" });
      return;
    }
    dispatch({ type: "CLEAR_SALE_ERR" });
    setSelectedPayment("cash");
    setCustomerId(null);
    setEmployeeId(null);
    setPayModalOpen(true);
  }

  async function holdCartNow() {
    if (!cartItems.length || !shiftReady || holdLoading) return;
    if (cartItems.some((it) => !(Number(it.quantity) > 0))) {
      dispatch({ type: "CHECKOUT_ERROR", fallback: "أدخل الوزن بالكيلو قبل تعليق الفاتورة" });
      return;
    }
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

  const completeSaleRef = useRef(completeSale);
  completeSaleRef.current = completeSale;

  const undoLastScanRef = useRef(undoLastScan);
  undoLastScanRef.current = undoLastScan;

  const requestClearCartRef = useRef(requestClearCart);
  requestClearCartRef.current = requestClearCart;

  const holdCartNowRef = useRef(holdCartNow);
  holdCartNowRef.current = holdCartNow;

  const openSuspendedListRef = useRef(openSuspendedList);
  openSuspendedListRef.current = openSuspendedList;

  const shortcutsBlocked =
    isLoading ||
    payModalOpen ||
    endShiftOpen ||
    refundOpen ||
    clearCartOpen ||
    suspendedModalOpen ||
    detailModalOpen ||
    restoreConflictOpen ||
    supplierPayOpen ||
    !!cashDebtWaitingId ||
    !!supplierWaitingId;

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
        const decision = resolveF9CheckoutAction({
          repeat: ev.repeat,
          cartCount: cartItems.length,
          shiftReady,
          isLoading,
          isSubmitting: isSubmittingRef.current,
          payModalOpen,
        });
        if (decision.action === "ignore-repeat") {
          ev.preventDefault();
          return;
        }
        if (decision.action !== "open-modal") return;
        ev.preventDefault();
        handleCompleteClickRef.current();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cartItems.length, shiftReady, isLoading, payModalOpen, shortcutsBlocked, shortcuts]);

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
    setEmployeeId(null);
    focusBarcodeInput();
  }

  const weightMissing = cartItems.some((it) => it.awaitingWeight || !(Number(it.quantity) > 0));
  const canComplete = cartItems.length > 0 && !weightMissing && !isLoading && shiftReady;

  const goToLogin = useCallback(() => {
    removeToken();
    navigate("/login", { replace: true });
  }, [navigate]);

  function handleLogout() {
    if (cartItems.length > 0) {
      const ok = window.confirm(
        "يوجد أصناف في السلة. هل تريد تسجيل الخروج؟ سيتم فقدان الفاتورة الحالية."
      );
      if (!ok) return;
    }
    goToLogin();
  }

  return (
    <div className="pos-screen" dir="rtl" lang="ar">
      <PosHeader
        user={user}
        posNeedsShift={posNeedsShift}
        activeShift={activeShift}
        shiftTxCount={shiftTxCount}
        onEndShift={() => setEndShiftOpen(true)}
        onLogout={handleLogout}
        onProductFound={addToCart}
        onRefresh={refreshPos}
        refreshing={posRefreshing}
        shopExpenseDisabled={!cartItems.length}
        onShopExpense={() => {
          if (cartItems.some((it) => !(Number(it.quantity) > 0))) {
            dispatch({ type: "CHECKOUT_ERROR", fallback: "أدخل الوزن بالكيلو قبل ترحيل المصاريف" });
            return;
          }
          setShopExpenseOpen(true);
        }}
      />

      <PosPrintQueue />

      <PosRefundNotifications
        suppressIds={{
          on_account: onAccountWaitingId,
          advance: advanceWaitingId,
          cash_debt: cashDebtWaitingId,
        }}
        onApprovedOnAccount={finalizeApprovedOnAccountSale}
      />

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
        <div id="pos-waiting-chip-slot" className="pos-waiting-chip-slot" />
        <div className="pos-shortcut-hints">
          <span>{formatShortcutHint(shortcuts.completeSale)}</span>
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
          tax={tax}
          discount={discount}
          roundingAdjustment={roundingAdjustment}
          total={total}
          error={error}
          printWarning={printWarning}
          isLoading={isLoading}
          canComplete={canComplete}
          onComplete={handleCompleteClick}
          receiptData={receiptData}
          onPrintLocal={doPrintLocal}
          onOpenReceiptTab={doOpenReceiptTab}
        >
          <div className="pos-toolbar">
            <button type="button" className="pos-toolbar-btn pos-toolbar-btn--danger" onClick={requestClearCart}>
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
            <button type="button" className="pos-toolbar-btn" onClick={() => setSupplierPayOpen(true)}>
              موردين/ذمم
            </button>
          </div>
        </PosPaymentPanel>
      </footer>

      <Suspense fallback={null}>
        {clearCartOpen ? (
          <PosClearCartModal
            open
            onClose={() => {
              setClearCartOpen(false);
              focusBarcodeInput();
            }}
            onConfirm={() => {
              setClearCartOpen(false);
              resetInvoiceState();
            }}
          />
        ) : null}

        {suspendedModalOpen ? (
          <PosSuspendedSalesModal
            open
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
        ) : null}

        {detailModalOpen ? (
          <PosSuspendedDetailModal
            open
            detail={suspendedDetail}
            onClose={() => {
              setDetailModalOpen(false);
              focusBarcodeInput();
            }}
          />
        ) : null}

        {restoreConflictOpen ? (
          <PosRestoreConflictModal
            open
            onHoldAndRestore={handleHoldAndRestore}
            onMerge={handleMergeRestore}
            onCancel={() => {
              setRestoreConflictOpen(false);
              setPendingRestoreId(null);
              focusBarcodeInput();
            }}
          />
        ) : null}

        {advanceOpen ? (
          <PosAdvanceRequestModal
            open
            onClose={() => setAdvanceOpen(false)}
            onWaiting={(id) => {
              writeWaitingRequestId("advance", id);
              setAdvanceWaitingId(id);
              setAdvanceOpen(false);
            }}
          />
        ) : null}

        {shopExpenseOpen ? (
          <PosShopConsumptionModal
            open
            cartItems={cartItems}
            onClose={() => {
              setShopExpenseOpen(false);
              focusBarcodeInput();
            }}
            onPosted={() => {
              setShopExpenseOpen(false);
              resetInvoiceState();
            }}
            onWaiting={(id) => {
              writeWaitingRequestId("shopExpense", id);
              setShopExpenseWaitingId(id);
              setShopExpenseOpen(false);
            }}
          />
        ) : null}

        {supplierPayOpen ? (
          <PosSupplierPaymentModal
            open
            onClose={() => setSupplierPayOpen(false)}
            onPaid={() => {
              loadShift();
            }}
            onSupplierWaiting={(id) => {
              writeWaitingRequestId("supplierPayment", id);
              setSupplierWaitingId(id);
              setSupplierPayOpen(false);
            }}
            onCashDebtWaiting={(id) => {
              writeWaitingRequestId("cashDebt", id);
              setCashDebtWaitingId(id);
              setSupplierPayOpen(false);
            }}
          />
        ) : null}

        {advanceWaitingId ? (
          <PosApprovalWaitingModal
            open
            requestId={advanceWaitingId}
            apiPath="/api/advance-requests"
            titlePrefix="طلب سلف"
            statusLabels={{
              pending: "بانتظار موافقة المدير…",
              approved: "تمت الموافقة على السلف",
              rejected: "تم رفض طلب السلف",
              expired: "انتهت صلاحية الطلب",
            }}
            detailLine={(d) =>
              d?.employee_name && d?.amount != null ? `${d.employee_name} — ${ils(d.amount)}` : null
            }
            onClose={handleAdvanceWaitingClose}
            onTerminal={handleAdvanceTerminal}
          />
        ) : null}

        {shopExpenseWaitingId ? (
          <PosApprovalWaitingModal
            open
            requestId={shopExpenseWaitingId}
            apiPath="/api/shop-consumption-requests"
            titlePrefix="مصاريف محل"
            statusLabels={{
              pending: "بانتظار الموافقة — لم يُخصم المخزون",
              approved: "تمت الموافقة — خُصم المخزون بالتكلفة",
              rejected: "تم رفض مصاريف المحل",
            }}
            onClose={() => {
              writeWaitingRequestId("shopExpense", null);
              setShopExpenseWaitingId(null);
            }}
            onTerminal={(detail) => {
              if (detail?.status === "approved") resetInvoiceState();
            }}
          />
        ) : null}

        {supplierWaitingId ? (
          <PosApprovalWaitingModal
            open
            requestId={supplierWaitingId}
            apiPath="/api/supplier-payment-requests"
            titlePrefix="طلب دفع لمورد"
            statusLabels={{
              pending: "بانتظار الموافقة — لا تسلّم النقد قبل الموافقة",
              approved: "تمت الموافقة — سُجّلت الدفعة",
              rejected: "تم رفض طلب الدفع للمورد",
            }}
            detailLine={(d) =>
              d?.supplier_name && d?.amount != null ? `${d.supplier_name} — ${ils(d.amount)}` : null
            }
            onClose={() => {
              writeWaitingRequestId("supplierPayment", null);
              setSupplierWaitingId(null);
            }}
            onTerminal={() => {
              loadShift();
            }}
          />
        ) : null}

        {cashDebtWaitingId ? (
          <PosApprovalWaitingModal
            open
            requestId={cashDebtWaitingId}
            apiPath="/api/customer-cash-debt-requests"
            titlePrefix="طلب ذمة نقدية"
            statusLabels={{
              pending: "بانتظار الموافقة — لا تسلّم المبلغ قبل الموافقة",
              approved: "تمت الموافقة — سلّم المبلغ للعميل",
              rejected: "تم رفض طلب الذمة النقدية",
              expired: "انتهت صلاحية الطلب",
            }}
            detailLine={(d) =>
              d?.customer_name && d?.amount != null ? `${d.customer_name} — ${ils(d.amount)}` : null
            }
            onClose={() => {
              writeWaitingRequestId("cashDebt", null);
              setCashDebtWaitingId(null);
            }}
            onTerminal={handleCashDebtTerminal}
          />
        ) : null}

        {onAccountWaitingId ? (
          <PosApprovalWaitingModal
            open
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
              if (d.employee_name) parts.push(`الموظف: ${d.employee_name}`);
              if (d.customer_name) parts.push(`العميل: ${d.customer_name}`);
              if (d.on_account_amount != null) parts.push(`الذمة: ${ils(d.on_account_amount)}`);
              if (d.notes) parts.push(d.notes);
              return parts.length ? parts.join(" — ") : null;
            }}
            onClose={handleOnAccountWaitingClose}
            onTerminal={handleOnAccountTerminal}
          />
        ) : null}

        {refundOpen ? (
          <PosRefundModal
            open
            onClose={() => setRefundOpen(false)}
            shiftReady={shiftReady}
            shiftId={activeShift?.id ?? null}
            onRefundSuccess={() => {
              setRefundOpen(false);
              loadShift();
            }}
          />
        ) : null}

        {endShiftOpen && activeShift?.id ? (
          <ShiftEnd
            shiftId={activeShift.id}
            txCount={shiftTxCount}
            suspendedCount={suspendedCount}
            open={endShiftOpen}
            onClose={() => setEndShiftOpen(false)}
            onSuccess={goToLogin}
          />
        ) : null}
      </Suspense>

      <PosPaymentModal
        open={payModalOpen}
        total={total}
        roundingAdjustment={roundingAdjustment}
        selectedPayment={selectedPayment}
        onSelectPayment={setSelectedPayment}
        customerId={customerId}
        onSelectCustomer={setCustomerId}
        employeeId={employeeId}
        onSelectEmployee={setEmployeeId}
        error={error}
        isLoading={isLoading}
        onTarhil={completeSale}
        onClose={handlePayModalClose}
      />

      {posNeedsShift && !shiftLoading && !activeShift ? (
        <div className="shift-gate-overlay" aria-live="polite">
          <div className="shift-gate-backdrop" />
          <div className="shift-gate-card-wrap">
            <ShiftStart
              onSuccess={loadShift}
              initialError={shiftLoadError}
              onLogout={goToLogin}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export { checkoutReducer, checkoutInitialState };
