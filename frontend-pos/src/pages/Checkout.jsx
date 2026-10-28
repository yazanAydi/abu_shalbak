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
import PosWindowCloseHost from "../components/pos/PosWindowCloseHost";
import { getAuthHeaders, getUser, removeToken } from "../utils/auth";
import { clearRecoverableCart, readRecoverableCart, writeRecoverableCart } from "../utils/recoverableCart";
import { requiresShiftForPos } from "../utils/roles";
import ShiftStart from "../components/ShiftStart";
import { openReceiptForPrinting, printReceipt } from "../utils/printReceipt";
import { RECEIPT_PRINT_TAB_NAME } from "../utils/printDocument";
import { submitCompleteSale } from "../utils/completeSaleSubmit";
import { estimateCartTotals, buildCartLineDiscounts } from "../utils/posTotals";
import { useVisiblePoll } from "../hooks/useVisiblePoll";
import { checkoutReducer, checkoutInitialState } from "../utils/checkoutCartReducer";
import {
  formatShortcutHint,
  mergePosShortcutsFromSettings,
} from "../config/posShortcuts";
import { matchesShortcut, shouldHandlePosShortcut } from "../utils/posKeyboard";
import { resolveF9CheckoutAction } from "../utils/f9Checkout";
import { focusBarcodeInput, isBarcodeFocusSurface } from "../utils/focusBarcodeInput";
import { readWaitingRequestId, writeWaitingRequestId } from "../utils/posWaitingRequests";
import { playScanSuccess, warmPosSounds } from "../utils/posSounds";
import { suspendedItemsToCartItems } from "../utils/suspendedCart";
import { heldCartMatches, heldQuoteFromDetail, resolveHeldDisplay } from "../utils/heldQuote";
import { fetchCheckoutQuote } from "../utils/checkoutQuote";
import {
  buildSuspendRequest,
  resolveSuspendAttempt,
  suspendPayloadSignature,
} from "../utils/suspendCartSubmit";
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
const PosPreviousSalesModal = lazy(() => import("../components/pos/PosPreviousSalesModal"));
const PosRestoreConflictModal = lazy(() => import("../components/pos/PosRestoreConflictModal"));
const PosHeldQuoteModal = lazy(() => import("../components/pos/PosHeldQuoteModal"));
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
  const [leaveChoiceOpen, setLeaveChoiceOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [supplierPayOpen, setSupplierPayOpen] = useState(false);
  const [shopExpenseOpen, setShopExpenseOpen] = useState(false);
  const [advanceWaitingId, setAdvanceWaitingId] = useState(() => readWaitingRequestId("advance"));
  const [advanceDelivery, setAdvanceDelivery] = useState(null);
  const [onAccountWaitingId, setOnAccountWaitingId] = useState(() =>
    readWaitingRequestId("onAccount")
  );
  const [onAccountDelivery, setOnAccountDelivery] = useState(null);
  const [cashDebtWaitingId, setCashDebtWaitingId] = useState(() =>
    readWaitingRequestId("cashDebt")
  );
  const [cashDebtDelivery, setCashDebtDelivery] = useState(null);
  const [supplierWaitingId, setSupplierWaitingId] = useState(() =>
    readWaitingRequestId("supplierPayment")
  );
  const [supplierTelegram, setSupplierTelegram] = useState(null);
  const [shopExpenseWaitingId, setShopExpenseWaitingId] = useState(() =>
    readWaitingRequestId("shopExpense")
  );
  const [shopExpenseTelegram, setShopExpenseTelegram] = useState(null);
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
  const [heldQuote, setHeldQuote] = useState(null);
  const [heldRepriceOpen, setHeldRepriceOpen] = useState(false);
  const [heldRepriceSaving, setHeldRepriceSaving] = useState(false);
  const [serverQuote, setServerQuote] = useState(null);
  const [quoteChanged, setQuoteChanged] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [previousSalesOpen, setPreviousSalesOpen] = useState(false);
  const activeSuspendedSaleIdRef = useRef(null);
  const suspendedVersionRef = useRef(null);
  const activeSuspendedNoteRef = useRef(null);
  const suspendIdempotencyRef = useRef(null);
  const suspendSignatureRef = useRef(null);
  const holdInFlightRef = useRef(false);

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
  const cartRestoredRef = useRef(false);
  const [cartRecoveryReady, setCartRecoveryReady] = useState(false);

  const [offerSyncLive, setOfferSyncLive] = useState(false);

  const applyActivePromos = useCallback((rows) => {
    if (!Array.isArray(rows)) return;
    setActivePromos((prev) => (JSON.stringify(prev) === JSON.stringify(rows) ? prev : rows));
  }, []);

  const loadActivePromos = useCallback(() => {
    api
      .get("/api/marketing/active", { headers: getAuthHeaders() })
      .then(({ data }) => applyActivePromos(data))
      .catch(() => {});
  }, [applyActivePromos]);

  useEffect(() => {
    warmPosSounds();
    api
      .get("/api/settings", { headers: getAuthHeaders() })
      .then(({ data }) => setAppSettings(data))
      .catch(() => setAppSettings(null));
    loadActivePromos();
  }, [loadActivePromos]);

  useVisiblePoll(loadActivePromos, 8000, { enabled: !offerSyncLive });

  const checkoutDialogOpen =
    payModalOpen ||
    clearCartOpen ||
    endShiftOpen ||
    leaveChoiceOpen ||
    refundOpen ||
    advanceOpen ||
    supplierPayOpen ||
    shopExpenseOpen ||
    suspendedModalOpen ||
    detailModalOpen ||
    restoreConflictOpen ||
    heldRepriceOpen ||
    !!advanceWaitingId ||
    !!onAccountWaitingId ||
    !!cashDebtWaitingId ||
    !!supplierWaitingId ||
    !!shopExpenseWaitingId;

  useEffect(() => {
    if (!shiftReady || checkoutDialogOpen) return;
    focusBarcodeInput();
  }, [shiftReady, checkoutDialogOpen]);

  useEffect(() => {
    const onWindowFocus = () => {
      if (document.visibilityState === "hidden") return;
      focusBarcodeInput();
    };
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, []);

  useEffect(() => {
    const root = document.querySelector(".pos-screen");
    if (!root) return undefined;
    let armed = false;
    const onPointerDown = (event) => {
      if (event.button != null && event.button !== 0) return;
      armed = isBarcodeFocusSurface(event.target);
    };
    const onPointerUp = (event) => {
      if (!armed) return;
      armed = false;
      if (event.button != null && event.button !== 0) return;
      if (!isBarcodeFocusSurface(event.target)) return;
      focusBarcodeInput({ releaseCartEdit: true });
    };
    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("pointerup", onPointerUp);
    return () => {
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

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
    if (shiftLoading || shiftLoadError || cartRestoredRef.current) return;
    cartRestoredRef.current = true;
    const saved = user?.id ? readRecoverableCart(user.id) : null;
    const shiftId = activeShift?.id ?? null;
    if (saved && shiftId && Number(saved.shiftId) === Number(shiftId)) {
      dispatch({ type: "LOAD_CART", cartItems: saved.cartItems });
      if (saved.idempotencyKey) idempotencyKeyRef.current = saved.idempotencyKey;
      if (saved.submittedPayload) submittedPayloadRef.current = saved.submittedPayload;
      if (saved.suspendedSaleId) {
        activeSuspendedSaleIdRef.current = saved.suspendedSaleId;
        setActiveSuspendedSaleId(saved.suspendedSaleId);
      }
    }
    setCartRecoveryReady(true);
  }, [shiftLoading, shiftLoadError, activeShift?.id, user?.id]);

  useEffect(() => {
    if (!cartRecoveryReady || !user?.id || shiftLoadError) return;
    writeRecoverableCart({
      userId: user.id,
      shiftId: activeShift?.id ?? null,
      cartItems,
      idempotencyKey: idempotencyKeyRef.current,
      submittedPayload: submittedPayloadRef.current,
      suspendedSaleId: activeSuspendedSaleId,
    });
  }, [cartRecoveryReady, cartItems, activeShift?.id, user?.id, activeSuspendedSaleId, shiftLoadError]);

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

  const { tax, discount, total, roundingAdjustment } = estimated;
  const heldMatch = Boolean(heldQuote && heldCartMatches(cartItems, heldQuote.items));
  const heldDisplay = heldMatch ? resolveHeldDisplay(heldQuote) : null;
  const discountShown = heldDisplay ? heldDisplay.discount : discount;
  const totalShown = heldDisplay ? heldDisplay.total : total;
  const roundingShown = heldDisplay ? heldDisplay.roundingAdjustment : roundingAdjustment;
  const promosForLines = heldDisplay && heldDisplay.discount !== discount ? [] : activePromos;

  const lineDiscounts = useMemo(
    () => buildCartLineDiscounts(cartItems, promosForLines),
    [cartItems, promosForLines]
  );

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

  const clearSuspendedIdentity = useCallback(() => {
    activeSuspendedSaleIdRef.current = null;
    suspendedVersionRef.current = null;
    activeSuspendedNoteRef.current = null;
    suspendIdempotencyRef.current = null;
    suspendSignatureRef.current = null;
    setActiveSuspendedSaleId(null);
    setHeldQuote(null);
    setHeldRepriceOpen(false);
  }, []);

  const rememberSuspendedSale = useCallback((detail) => {
    const id = detail?.id ?? null;
    activeSuspendedSaleIdRef.current = id;
    suspendedVersionRef.current = detail?.version ?? null;
    activeSuspendedNoteRef.current = detail?.note ?? null;
    suspendIdempotencyRef.current = null;
    suspendSignatureRef.current = null;
    setActiveSuspendedSaleId(id);
  }, []);

  const resetInvoiceState = useCallback(() => {
    dispatch({ type: "CLEAR_CART" });
    setSelectedPayment(null);
    setCustomerId(null);
    setEmployeeId(null);
    setPayModalOpen(false);
    clearSuspendedIdentity();
    focusBarcodeInput();
  }, [clearSuspendedIdentity]);

  const requestClearCart = useCallback(() => {
    if (!cartItems.length) return;
    setClearCartOpen(true);
  }, [cartItems.length]);

  const undoLastScan = useCallback(() => {
    if (!state.scanHistory?.length) return;
    dispatch({ type: "UNDO_LAST_SCAN" });
    focusBarcodeInput();
  }, [state.scanHistory?.length]);

  const persistSuspendedCart = useCallback(
    async (items) => {
      const saleId = activeSuspendedSaleIdRef.current;
      const signature = suspendPayloadSignature(items, {
        note: activeSuspendedNoteRef.current,
        customerId,
        employeeId,
      });
      const attempt = resolveSuspendAttempt({
        activeSaleId: saleId,
        outstandingKey: suspendIdempotencyRef.current,
        outstandingSignature: suspendSignatureRef.current,
        signature,
      });
      if (attempt.mode === "create") {
        suspendIdempotencyRef.current = attempt.idempotencyKey;
        suspendSignatureRef.current = signature;
      }
      const req = buildSuspendRequest({
        saleId: attempt.mode === "update" ? saleId : null,
        items,
        note: activeSuspendedNoteRef.current,
        version: suspendedVersionRef.current,
        customerId,
        employeeId,
        idempotencyKey: attempt.idempotencyKey,
      });
      const { data } = await api[req.method](req.url, req.body, {
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      });
      if (attempt.mode === "create") {
        suspendIdempotencyRef.current = null;
        suspendSignatureRef.current = null;
      }
      if (data?.version != null && saleId) {
        suspendedVersionRef.current = data.version;
      }
      return data;
    },
    [customerId, employeeId]
  );

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
      rememberSuspendedSale(detail);
      const quote = mode === "load" ? heldQuoteFromDetail(detail) : null;
      setHeldQuote(quote);
      setHeldRepriceOpen(Boolean(quote && !quote.quote_verified));
      if (mode === "load") {
        setCustomerId(detail.customer_id || null);
        setEmployeeId(detail.employee_id || null);
      } else if (detail.customer_id) {
        setCustomerId(detail.customer_id);
      }
      setSuspendedModalOpen(false);
      setRestoreConflictOpen(false);
      setPendingRestoreId(null);
      setDetailModalOpen(false);
      focusBarcodeInput();
    },
    [rememberSuspendedSale]
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

  const syncSuspendedCart = useCallback(async (saleId, items) => {
    const req = buildSuspendRequest({
      saleId,
      items,
      version: suspendedVersionRef.current,
      preserveParty: true,
    });
    const { data } = await api.put(req.url, req.body, {
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    });
    if (data?.version != null) suspendedVersionRef.current = data.version;
    return data;
  }, []);

  const confirmHeldReprice = useCallback(async () => {
    if (!activeSuspendedSaleId || !heldQuote || heldRepriceSaving) return;
    setHeldRepriceSaving(true);
    try {
      const saved = await syncSuspendedCart(activeSuspendedSaleId, cartItems);
      setHeldQuote({
        ...heldQuote,
        quote_verified: saved?.quote_verified !== false,
        saved_discount: Number(saved?.discount) || 0,
        saved_payable: Number(saved?.payable) || 0,
        saved_rounding: Number(saved?.rounding_adjustment) || 0,
        current_discount: Number(saved?.discount) || 0,
        current_payable: Number(saved?.payable) || 0,
        current_rounding: Number(saved?.rounding_adjustment) || 0,
      });
      setHeldRepriceOpen(false);
    } catch (e) {
      showPosActionError(extractApiError(e, "تعذّر تحديث مبلغ الفاتورة المعلقة"));
    } finally {
      setHeldRepriceSaving(false);
    }
  }, [activeSuspendedSaleId, cartItems, heldQuote, heldRepriceSaving, showPosActionError, syncSuspendedCart]);

  const completeSale = useCallback(
    async (paymentPayload = null) => {
      const result = await submitCompleteSale({
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
        syncBeforeCheckout: !(
          heldQuote &&
          heldQuote.quote_verified &&
          heldCartMatches(cartItems, heldQuote.items)
        ),
        confirmedQuote: serverQuote,
        dispatch,
        setIsLoading,
        setOnAccountWaitingId,
        setOnAccountDelivery,
        setPayModalOpen,
        setSelectedPayment,
        setCustomerId,
        setEmployeeId,
        setActiveSuspendedSaleId: clearSuspendedIdentity,
        loadShift,
        loadSuspendedList,
        syncSuspendedCart,
        onPersistAttempt: ({ idempotencyKey, submittedPayload }) => {
          writeRecoverableCart({
            userId: user?.id,
            shiftId: activeShift?.id ?? null,
            cartItems,
            idempotencyKey,
            submittedPayload,
            suspendedSaleId: activeSuspendedSaleId,
          });
        },
      });
      if (result?.status === "quote_changed" && result.quote) {
        setServerQuote({
          subtotal: result.quote.subtotal,
          tax: result.quote.tax,
          discount: result.quote.discount,
          total: result.quote.total,
          amount_before_rounding: result.quote.amount_before_rounding,
          rounding_adjustment: result.quote.rounding_adjustment,
        });
        setQuoteChanged(true);
      }
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
      heldQuote,
      serverQuote,
      syncSuspendedCart,
      clearSuspendedIdentity,
      user?.id,
      activeShift?.id,
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
      clearSuspendedIdentity();
      loadShift();
      loadSuspendedList();
      focusBarcodeInput();
      /* Approved ذمة prints once from the cashier print queue, not from this callback. */
    },
    [clearSuspendedIdentity, loadShift, loadSuspendedList]
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

  async function handleCompleteClick() {
    if (isLoading || quoteLoading) return;
    if (heldDisplay?.needsConfirmation) {
      setHeldRepriceOpen(true);
      return;
    }
    if (!shiftReady) {
      const message = "افتح الوردية قبل إتمام البيع";
      dispatch({ type: "CHECKOUT_ERROR", fallback: message });
      showPosActionError(message);
      return;
    }
    if (!cartItems.length) {
      const message = "أضف صنفاً قبل إتمام البيع";
      dispatch({ type: "CHECKOUT_ERROR", fallback: message });
      showPosActionError(message);
      return;
    }
    if (cartItems.some((it) => !(Number(it.quantity) > 0))) {
      const message = "أدخل الوزن بالكيلو قبل إتمام البيع";
      dispatch({ type: "CHECKOUT_ERROR", fallback: message });
      showPosActionError(message);
      return;
    }
    dispatch({ type: "CLEAR_SALE_ERR" });
    setQuoteLoading(true);
    try {
      const quote = await fetchCheckoutQuote({
        cartItems,
        suspendedSaleId: activeSuspendedSaleId,
      });
      setServerQuote(quote);
      setQuoteChanged(false);
      setSelectedPayment("cash");
      setCustomerId(null);
      setEmployeeId(null);
      setPayModalOpen(true);
    } catch (e) {
      const message = e?.response?.data?.error || "تعذّر تأكيد السعر من الخادم. أعد المحاولة.";
      dispatch({ type: "CHECKOUT_ERROR", fallback: message });
      showPosActionError(message);
    } finally {
      setQuoteLoading(false);
    }
  }

  async function holdCartNow() {
    if (!cartItems.length || !shiftReady || holdLoading || holdInFlightRef.current) return;
    if (cartItems.some((it) => !(Number(it.quantity) > 0))) {
      dispatch({ type: "CHECKOUT_ERROR", fallback: "أدخل الوزن بالكيلو قبل تعليق الفاتورة" });
      return;
    }
    holdInFlightRef.current = true;
    setHoldLoading(true);
    try {
      await persistSuspendedCart(cartItems);
      resetInvoiceState();
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
      holdInFlightRef.current = false;
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
      if (activeSuspendedSaleId === id) clearSuspendedIdentity();
      await loadSuspendedList();
      await loadShift();
      focusBarcodeInput();
    } catch (e) {
      showPosActionError(extractApiError(e, "فشل حذف الفاتورة المعلقة"));
    }
  }

  async function handleHoldAndRestore() {
    if (!pendingRestoreId || holdInFlightRef.current) return;
    holdInFlightRef.current = true;
    setHoldLoading(true);
    try {
      if (cartItems.length) {
        const saved = await persistSuspendedCart(cartItems);
        if (!activeSuspendedSaleIdRef.current && saved?.id) {
          rememberSuspendedSale(saved);
        }
      }
      await restoreSuspendedSale(pendingRestoreId, "load");
    } catch (e) {
      showPosActionError(extractApiError(e, "فشل استرجاع الفاتورة"));
    } finally {
      holdInFlightRef.current = false;
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
    leaveChoiceOpen ||
    refundOpen ||
    clearCartOpen ||
    suspendedModalOpen ||
    detailModalOpen ||
    restoreConflictOpen ||
    heldRepriceOpen ||
    previousSalesOpen ||
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
        if (decision.action === "ignore-repeat" || decision.action === "defer-to-modal") {
          if (decision.action === "ignore-repeat") ev.preventDefault();
          return;
        }
        if (decision.action === "ignore" && (isLoading || isSubmittingRef.current)) return;
        ev.preventDefault();
        handleCompleteClickRef.current();
      }
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
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
    setServerQuote(null);
    setQuoteChanged(false);
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

  const openLeaveChoice = useCallback(() => setLeaveChoiceOpen(true), []);
  const closeLeaveChoice = useCallback(() => setLeaveChoiceOpen(false), []);

  useEffect(() => {
    if (!activeShift?.id) setLeaveChoiceOpen(false);
  }, [activeShift?.id]);

  function handleLogout() {
    if (activeShift?.id) {
      setLeaveChoiceOpen(true);
      return;
    }
    if (cartItems.length > 0) {
      const ok = window.confirm(
        "يوجد أصناف في السلة. تسجيل الخروج لا يغلق الوردية، وستعود الفاتورة عند دخول نفس الكاشير."
      );
      if (!ok) return;
    }
    goToLogin();
  }

  function chooseLeaveLogout() {
    setLeaveChoiceOpen(false);
    goToLogin();
  }

  function chooseLeaveEndShift() {
    setLeaveChoiceOpen(false);
    setEndShiftOpen(true);
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
          supplier: supplierWaitingId,
          shop: shopExpenseWaitingId,
        }}
        onApprovedOnAccount={finalizeApprovedOnAccountSale}
        onSyncChange={setOfferSyncLive}
        onPromotions={applyActivePromos}
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
          activePromos={promosForLines}
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
          discount={discountShown}
          roundingAdjustment={roundingShown}
          total={totalShown}
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
            <button type="button" className="pos-toolbar-btn" onClick={() => setPreviousSalesOpen(true)}>
              الفواتير السابقة
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

        {previousSalesOpen ? (
          <PosPreviousSalesModal
            open
            onClose={() => {
              setPreviousSalesOpen(false);
              focusBarcodeInput();
            }}
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

        {heldRepriceOpen && heldDisplay ? (
          <PosHeldQuoteModal
            open
            savedDiscount={heldDisplay.savedDiscount}
            savedPayable={heldDisplay.savedPayable}
            currentDiscount={heldDisplay.discount}
            currentPayable={heldDisplay.total}
            confirming={heldRepriceSaving}
            onConfirm={confirmHeldReprice}
            onDismiss={() => setHeldRepriceOpen(false)}
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
            onWaiting={(id, meta) => {
              writeWaitingRequestId("advance", id);
              setAdvanceWaitingId(id);
              setAdvanceDelivery(meta?.telegram_delivery ?? (meta?.telegram ? "sent" : null));
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
            onWaiting={(id, meta) => {
              writeWaitingRequestId("shopExpense", id);
              setShopExpenseWaitingId(id);
              setShopExpenseTelegram(meta?.telegram_delivery ?? (meta?.telegram ? "sent" : null));
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
            onSupplierWaiting={(id, meta) => {
              writeWaitingRequestId("supplierPayment", id);
              setSupplierWaitingId(id);
              setSupplierTelegram(meta?.telegram_delivery ?? (meta?.telegram ? "sent" : null));
              setSupplierPayOpen(false);
            }}
            onCashDebtWaiting={(id, meta) => {
              writeWaitingRequestId("cashDebt", id);
              setCashDebtWaitingId(id);
              setCashDebtDelivery(meta?.telegram_delivery ?? (meta?.telegram ? "sent" : null));
              setSupplierPayOpen(false);
            }}
          />
        ) : null}

        {advanceWaitingId ? (
          <PosApprovalWaitingModal
            open
            requestId={advanceWaitingId}
            initialTelegram={advanceDelivery}
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
            initialTelegram={shopExpenseTelegram}
            apiPath="/api/shop-consumption-requests"
            titlePrefix="مصاريف محل"
            statusLabels={{
              pending: "بانتظار الموافقة — لم يُخصم المخزون",
              approved: "تمت الموافقة — خُصم المخزون وسُجّل المصروف بسعر البيع",
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
            initialTelegram={supplierTelegram}
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
            initialTelegram={cashDebtDelivery}
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
            initialTelegram={onAccountDelivery}
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
            suspendedCount={suspendedCount}
            open={endShiftOpen}
            onClose={() => setEndShiftOpen(false)}
            onSuccess={() => {
              clearRecoverableCart(user?.id);
              goToLogin();
            }}
          />
        ) : null}
      </Suspense>

      <PosWindowCloseHost
        shiftId={activeShift?.id ?? null}
        suspendedCount={suspendedCount}
        cartDirty={cartItems.length > 0}
        open={leaveChoiceOpen}
        onOpen={openLeaveChoice}
        onCancel={closeLeaveChoice}
        onLogout={chooseLeaveLogout}
        onEndShift={chooseLeaveEndShift}
      />

      <PosPaymentModal
        open={payModalOpen}
        total={serverQuote ? serverQuote.total : totalShown}
        discount={serverQuote ? serverQuote.discount : discountShown}
        priceNotice={quoteChanged ? "تغير السعر بعد فتح الدفع. راجع الإجمالي والخصم والباقي، ثم أكّد البيع." : ""}
        roundingAdjustment={serverQuote ? serverQuote.rounding_adjustment : roundingShown}
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
