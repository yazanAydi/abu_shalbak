import api from "../apiClient";
import { getAuthHeaders } from "./auth";
import { printReceipt, saleSavedPrintFailedMessage } from "./printReceipt";
import { playCheckoutDone, unlockPosAudio } from "./posSounds";
import { writeWaitingRequestId } from "./posWaitingRequests";
import { focusBarcodeInput } from "./focusBarcodeInput";

export const MISSING_ON_ACCOUNT_CUSTOMER = "اختر عميلاً للبيع على الذمة";
export const IDEMPOTENCY_REUSE_AR =
  "تعارض في مفتاح التكرار: محتوى السلة يختلف عن الطلب السابق. لا تُعد الإرسال تلقائياً.";
export const SUSPENDED_ALREADY_COMPLETED_AR =
  "الفاتورة المعلقة مكتملة مسبقاً. لا تُعد إدخال البيع.";
export const PASSWORD_CHANGE_REQUIRED_AR = "يجب تغيير كلمة المرور قبل المتابعة.";

export function newIdempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

export function isOnAccountMissingCustomer(pay, customerId) {
  return pay?.payment_method === "on_account" && !customerId;
}

export function checkoutAttemptSignature(body) {
  return JSON.stringify({
    items: body?.items || [],
    payments: body?.payments || null,
    payment_method: body?.payment_method || null,
    customer_id: body?.customer_id || null,
    suspended_sale_id: body?.suspended_sale_id || null,
  });
}

export function buildCheckoutBody({ cartItems, pay, customerId, activeSuspendedSaleId, key }) {
  const items = cartItems.map((c) => ({
    product_id: c.id,
    unit_id: c.unitId,
    quantity: c.quantity,
    price: c.price,
    ...(c.scanned_barcode ? { scanned_barcode: c.scanned_barcode } : {}),
  }));
  const body = {
    items,
    idempotency_key: key,
    ...pay,
  };
  if (customerId) body.customer_id = customerId;
  if (activeSuspendedSaleId) body.suspended_sale_id = activeSuspendedSaleId;
  return body;
}

export function checkoutErrorCode(err) {
  const body = err?.response?.data;
  return body?.code || body?.data?.code || null;
}

function conflictFallback(code, err) {
  if (code === "IDEMPOTENCY_KEY_REUSE") return IDEMPOTENCY_REUSE_AR;
  if (code === "SUSPENDED_ALREADY_COMPLETED") return SUSPENDED_ALREADY_COMPLETED_AR;
  if (code === "PASSWORD_CHANGE_REQUIRED") return PASSWORD_CHANGE_REQUIRED_AR;
  return err?.message || "فشل إتمام البيع";
}

function shouldKeepOutstanding(code, err) {
  if (
    code === "IDEMPOTENCY_KEY_REUSE" ||
    code === "SUSPENDED_ALREADY_COMPLETED" ||
    code === "PASSWORD_CHANGE_REQUIRED"
  ) {
    return true;
  }
  const status = err?.response?.status;
  if (status == null) return true;
  if (status >= 500) return true;
  return false;
}

/**
 * POS checkout submit. Validation failures must never set the submit lock or loading.
 * Every path that sets the lock must hit finally.
 */
export async function submitCompleteSale({
  paymentPayload = null,
  selectedPayment,
  cartItems,
  customerId,
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
  setActiveSuspendedSaleId,
  loadShift,
  loadSuspendedList,
  syncSuspendedCart,
}) {
  const pay = paymentPayload || { payment_method: selectedPayment };
  if (!cartItems.length || !pay.payment_method || isLoading || isSubmittingRef.current) {
    return { status: "skipped" };
  }
  if (isOnAccountMissingCustomer(pay, customerId)) {
    dispatch({
      type: "CHECKOUT_ERROR",
      fallback: MISSING_ON_ACCOUNT_CUSTOMER,
    });
    return { status: "validation" };
  }

  isSubmittingRef.current = true;
  dispatch({ type: "CLEAR_SALE_ERR" });
  setIsLoading(true);
  unlockPosAudio();

  const draft = buildCheckoutBody({
    cartItems,
    pay,
    customerId,
    activeSuspendedSaleId,
    key: idempotencyKeyRef.current || "pending",
  });
  const draftSig = checkoutAttemptSignature(draft);
  const outstanding = submittedPayloadRef?.current;
  if (idempotencyKeyRef.current && outstanding) {
    if (checkoutAttemptSignature(outstanding) !== draftSig) {
      idempotencyKeyRef.current = newIdempotencyKey();
    }
  } else if (!idempotencyKeyRef.current) {
    idempotencyKeyRef.current = newIdempotencyKey();
  }

  const sameAsOutstanding =
    outstanding && checkoutAttemptSignature(outstanding) === draftSig && outstanding.idempotency_key;
  const body = sameAsOutstanding
    ? outstanding
    : buildCheckoutBody({
        cartItems,
        pay,
        customerId,
        activeSuspendedSaleId,
        key: idempotencyKeyRef.current,
      });
  if (submittedPayloadRef) submittedPayloadRef.current = body;

  let receiptToPrint = null;
  let result = { status: "ok" };
  try {
    if (activeSuspendedSaleId) {
      await syncSuspendedCart(activeSuspendedSaleId, cartItems);
    }

    const { data } = await api.post("/api/checkout", body, {
      headers: {
        ...getAuthHeaders(),
        "Content-Type": "application/json",
      },
    });
    const payload = data?.data ?? data;
    if (payload?.pending_approval && payload?.request_id) {
      writeWaitingRequestId("onAccount", payload.request_id);
      setOnAccountWaitingId(payload.request_id);
      setPayModalOpen(false);
      idempotencyKeyRef.current = null;
      if (submittedPayloadRef) submittedPayloadRef.current = null;
      return { status: "pending" };
    }
    dispatch({ type: "CHECKOUT_SUCCESS", data: payload });
    playCheckoutDone();
    receiptToPrint = payload?.receipt_html || payload?.receipt_text ? payload : null;
    idempotencyKeyRef.current = null;
    if (submittedPayloadRef) submittedPayloadRef.current = null;
    setSelectedPayment(null);
    setCustomerId(null);
    setPayModalOpen(false);
    setActiveSuspendedSaleId(null);
    loadShift();
    loadSuspendedList();
    focusBarcodeInput();
    result = { status: "ok", payload };
  } catch (e) {
    const code = checkoutErrorCode(e);
    dispatch({
      type: "CHECKOUT_ERROR",
      payload: e.response?.data,
      fallback: conflictFallback(code, e),
    });
    if (!shouldKeepOutstanding(code, e)) {
      idempotencyKeyRef.current = null;
      if (submittedPayloadRef) submittedPayloadRef.current = null;
    }
    result = { status: "error", error: e, code, keepOutstanding: shouldKeepOutstanding(code, e) };
  } finally {
    setIsLoading(false);
    isSubmittingRef.current = false;
  }
  if (receiptToPrint) {
    const printed = await printReceipt(receiptToPrint, { alert: false });
    if (!printed?.ok) {
      dispatch({
        type: "CHECKOUT_PRINT_WARNING",
        message: saleSavedPrintFailedMessage(receiptToPrint.receipt_number),
      });
    }
  }
  return result;
}
