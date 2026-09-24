import { useCallback, useEffect, useRef, useState } from "react";
import api from "../../apiClient";
import { getAuthHeaders } from "../../utils/auth";
import { newIdempotencyKey } from "../../utils/completeSaleSubmit";
import SearchableSelect from "../ui/SearchableSelect";
import { handleEnterNavKeyDown } from "../../utils/focusNavigation";
import "../ShiftModal.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

function sanitizeAmount(value) {
  const next = String(value ?? "").replace(",", ".");
  if (next === "" || /^\d*\.?\d*$/.test(next)) return next;
  return null;
}

function payloadSignature(partyId, amount, notes) {
  return JSON.stringify({
    party_id: String(partyId || ""),
    amount: String(amount || ""),
    notes: String(notes || "").trim(),
  });
}

function useStableSubmitKey() {
  const keyRef = useRef(null);
  const lastSentSigRef = useRef(null);
  const reset = useCallback(() => {
    keyRef.current = newIdempotencyKey();
    lastSentSigRef.current = null;
  }, []);
  const keyFor = useCallback((sig) => {
    if (lastSentSigRef.current && lastSentSigRef.current !== sig) {
      keyRef.current = newIdempotencyKey();
    }
    if (!keyRef.current) keyRef.current = newIdempotencyKey();
    lastSentSigRef.current = sig;
    return keyRef.current;
  }, []);
  return { reset, keyFor };
}

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {() => void} [props.onPaid]
 * @param {(requestId: number) => void} [props.onCashDebtWaiting]
 * @param {(requestId: number) => void} [props.onSupplierWaiting]
 */
export default function PosSupplierPaymentModal({ open, onClose, onPaid, onCashDebtWaiting, onSupplierWaiting }) {
  const [tab, setTab] = useState("supplier");
  const [supplierId, setSupplierId] = useState("");
  const [suppliers, setSuppliers] = useState([]);
  const [supplierListLoading, setSupplierListLoading] = useState(false);
  const [supplierAmount, setSupplierAmount] = useState("");
  const [supplierNotes, setSupplierNotes] = useState("");
  const [supplierLoading, setSupplierLoading] = useState(false);
  const [supplierError, setSupplierError] = useState("");
  const [supplierSuccess, setSupplierSuccess] = useState(null);
  const supplierKey = useStableSubmitKey();

  const [customerId, setCustomerId] = useState("");
  const [customers, setCustomers] = useState([]);
  const [customerListLoading, setCustomerListLoading] = useState(false);
  const [outstanding, setOutstanding] = useState(null);
  const [customerAmount, setCustomerAmount] = useState("");
  const [customerNotes, setCustomerNotes] = useState("");
  const [customerLoading, setCustomerLoading] = useState(false);
  const [customerError, setCustomerError] = useState("");
  const [customerSuccess, setCustomerSuccess] = useState(null);
  const customerKey = useStableSubmitKey();
  const pending = supplierLoading || customerLoading;

  useEffect(() => {
    if (!open) return undefined;
    setTab("supplier");
    supplierKey.reset();
    customerKey.reset();
    setSupplierId("");
    setSupplierAmount("");
    setSupplierNotes("");
    setSupplierError("");
    setSupplierSuccess(null);
    setCustomerId("");
    setOutstanding(null);
    setCustomerAmount("");
    setCustomerNotes("");
    setCustomerError("");
    setCustomerSuccess(null);
    let cancelled = false;
    setSupplierListLoading(true);
    setCustomerListLoading(true);
    api
      .get("/api/pos/suppliers", { headers: getAuthHeaders() })
      .then(({ data }) => {
        if (!cancelled) setSuppliers(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        if (!cancelled) setSupplierError(err.response?.data?.error || err.message || "فشل تحميل الموردين");
      })
      .finally(() => {
        if (!cancelled) setSupplierListLoading(false);
      });
    api
      .get("/api/pos/customers", { headers: getAuthHeaders() })
      .then(({ data }) => {
        if (!cancelled) setCustomers(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        if (!cancelled) setCustomerError(err.response?.data?.error || err.message || "فشل تحميل العملاء");
      })
      .finally(() => {
        if (!cancelled) setCustomerListLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, supplierKey.reset, customerKey.reset]);

  useEffect(() => {
    if (!open || !customerId) {
      setOutstanding(null);
      return undefined;
    }
    let cancelled = false;
    setOutstanding(null);
    api
      .get(`/api/pos/customers/${customerId}`, { headers: getAuthHeaders() })
      .then(({ data }) => {
        if (!cancelled) setOutstanding(data?.outstanding ?? null);
      })
      .catch((err) => {
        if (!cancelled) {
          setOutstanding(null);
          setCustomerError(err.response?.data?.error || err.message || "تعذّر قراءة الذمة");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, customerId]);

  function handleClose() {
    onClose();
  }

  function switchTab(next) {
    if (pending || next === tab) return;
    setTab(next);
  }

  async function handleSupplierSubmit(e) {
    e.preventDefault();
    if (supplierLoading || supplierSuccess) return;
    setSupplierError("");
    const sid = Number(supplierId);
    if (!sid) {
      setSupplierError("اختر المورد");
      return;
    }
    const raw = String(supplierAmount).trim();
    const amt = Number(raw.replace(",", "."));
    if (raw === "" || !Number.isFinite(amt) || amt <= 0) {
      setSupplierError("أدخل مبلغاً صالحاً");
      return;
    }
    const sig = payloadSignature(sid, raw, supplierNotes);
    const idempotencyKey = supplierKey.keyFor(sig);
    setSupplierLoading(true);
    try {
      const { data } = await api.post(
        "/api/pos/supplier-payments",
        {
          supplier_id: sid,
          amount: amt,
          notes: supplierNotes.trim() || null,
          idempotency_key: idempotencyKey,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      const payload = data?.data ?? data;
      if (payload?.pending_approval && payload?.request_id) {
        onSupplierWaiting?.(payload.request_id);
        return;
      }
      setSupplierSuccess(data);
      onPaid?.(data);
    } catch (err) {
      setSupplierError(err.response?.data?.error || err.message || "فشل تسجيل الدفع");
    } finally {
      setSupplierLoading(false);
    }
  }

  async function handleCustomerSubmit(e) {
    e.preventDefault();
    if (customerLoading || customerSuccess) return;
    setCustomerError("");
    const cid = Number(customerId);
    if (!cid) {
      setCustomerError("اختر العميل");
      return;
    }
    const raw = String(customerAmount).trim();
    const amt = Number(raw.replace(",", "."));
    if (raw === "" || !Number.isFinite(amt) || amt <= 0) {
      setCustomerError("أدخل مبلغاً صالحاً");
      return;
    }
    const sig = payloadSignature(cid, raw, customerNotes);
    const idempotencyKey = customerKey.keyFor(sig);
    setCustomerLoading(true);
    try {
      const { data } = await api.post(
        "/api/customer-cash-debt-requests",
        {
          customer_id: cid,
          amount: amt,
          notes: customerNotes.trim() || null,
          idempotency_key: idempotencyKey,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      const payload = data?.data ?? data;
      const requestId = payload?.request_id ?? payload?.id;
      if (requestId && onCashDebtWaiting) {
        onCashDebtWaiting(requestId);
        return;
      }
      setCustomerSuccess(payload);
    } catch (err) {
      setCustomerError(err.response?.data?.error || err.message || "فشل تسجيل القبض");
    } finally {
      setCustomerLoading(false);
    }
  }

  if (!open) return null;

  return (
    <div className="shift-modal-overlay" role="dialog" aria-modal="true" dir="rtl" lang="ar">
      <div className="shift-modal-backdrop" onClick={pending ? undefined : handleClose} aria-hidden />
      <div className="shift-modal-panel shift-modal-panel--form">
        <h2 className="shift-modal-title">موردين/ذمم</h2>
        <div className="shift-modal-tabs" role="tablist" aria-label="موردين وذمم">
          <button
            type="button"
            role="tab"
            id="pos-tab-supplier"
            aria-selected={tab === "supplier"}
            aria-controls="pos-panel-supplier"
            className={tab === "supplier" ? "shift-modal-tab is-active" : "shift-modal-tab"}
            disabled={pending}
            onClick={() => switchTab("supplier")}
          >
            دفع لمورد
          </button>
          <button
            type="button"
            role="tab"
            id="pos-tab-customer"
            aria-selected={tab === "customer"}
            aria-controls="pos-panel-customer"
            className={tab === "customer" ? "shift-modal-tab is-active" : "shift-modal-tab"}
            disabled={pending}
            onClick={() => switchTab("customer")}
          >
            ذمم عملاء نقدي
          </button>
        </div>

        {tab === "supplier" ? (
          <form
            id="pos-panel-supplier"
            role="tabpanel"
            aria-labelledby="pos-tab-supplier"
            data-enter-nav=""
            onKeyDown={handleEnterNavKeyDown}
            onSubmit={handleSupplierSubmit}
          >
            {supplierSuccess ? (
              <>
                <p className="shift-modal-lead">
                  تم تسجيل الدفع للمورد {supplierSuccess.supplier_name} بمبلغ {ils(supplierSuccess.amount)}
                  {supplierSuccess.voucher_no != null ? ` — سند صرف #${supplierSuccess.voucher_no}` : ""}.
                </p>
                <div className="shift-modal-actions">
                  <button type="button" className="shift-modal-primary" onClick={handleClose}>
                    إغلاق
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="shift-modal-lead">سيتم خصم المبلغ من نقد الوردية وتسجيل سند صرف للمورد</p>
                <label className="shift-modal-label">
                  المورد
                  <SearchableSelect
                    className="shift-modal-input"
                    value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value)}
                    placeholder="ابحث عن المورد"
                    disabled={supplierListLoading || pending}
                    required
                  >
                    <option value="">اختر المورد</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </SearchableSelect>
                </label>
                <label className="shift-modal-label">
                  المبلغ (₪)
                  <input
                    className="shift-modal-input"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={supplierAmount}
                    onChange={(e) => {
                      const next = sanitizeAmount(e.target.value);
                      if (next != null) setSupplierAmount(next);
                    }}
                    placeholder="0.00"
                  />
                </label>
                <label className="shift-modal-label">
                  ملاحظة (اختياري)
                  <input
                    className="shift-modal-input"
                    type="text"
                    value={supplierNotes}
                    onChange={(e) => setSupplierNotes(e.target.value)}
                    maxLength={500}
                  />
                </label>
                {supplierError ? <div className="shift-modal-err">{supplierError}</div> : null}
                <div className="shift-modal-actions">
                  <button type="button" className="shift-modal-secondary" onClick={handleClose} disabled={pending}>
                    إلغاء
                  </button>
                  <button type="submit" className="shift-modal-primary" disabled={pending || supplierListLoading}>
                    {supplierLoading ? "جاري التسجيل…" : "تأكيد الدفع"}
                  </button>
                </div>
              </>
            )}
          </form>
        ) : (
          <form
            id="pos-panel-customer"
            role="tabpanel"
            aria-labelledby="pos-tab-customer"
            data-enter-nav=""
            onKeyDown={handleEnterNavKeyDown}
            onSubmit={handleCustomerSubmit}
          >
            {customerSuccess ? (
              <>
                <p className="shift-modal-lead">بانتظار الموافقة — لا تسلّم المبلغ قبل الموافقة</p>
                <div className="shift-modal-actions">
                  <button type="button" className="shift-modal-primary" onClick={handleClose}>
                    إغلاق
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="shift-modal-lead">
                  طلب صرف نقد للعميل على الذمة. بعد الموافقة، يزداد رصيد ذمة العميل ويُخصم المبلغ من نقد الوردية
                </p>
                <label className="shift-modal-label">
                  العميل
                  <SearchableSelect
                    className="shift-modal-input"
                    value={customerId}
                    onChange={(e) => setCustomerId(e.target.value)}
                    placeholder="ابحث عن العميل"
                    disabled={customerListLoading || pending}
                    required
                  >
                    <option value="">اختر العميل</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </SearchableSelect>
                </label>
                {customerId && outstanding != null ? (
                  <p className="shift-modal-lead">الذمة الحالية: {ils(outstanding)}</p>
                ) : null}
                <label className="shift-modal-label">
                  المبلغ (₪)
                  <input
                    className="shift-modal-input"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={customerAmount}
                    onChange={(e) => {
                      const next = sanitizeAmount(e.target.value);
                      if (next != null) setCustomerAmount(next);
                    }}
                    placeholder="0.00"
                    required
                  />
                </label>
                <label className="shift-modal-label">
                  ملاحظة (اختياري)
                  <input
                    className="shift-modal-input"
                    type="text"
                    value={customerNotes}
                    onChange={(e) => setCustomerNotes(e.target.value)}
                    maxLength={500}
                  />
                </label>
                {customerError ? <div className="shift-modal-err">{customerError}</div> : null}
                <div className="shift-modal-actions">
                  <button type="button" className="shift-modal-secondary" onClick={handleClose} disabled={pending}>
                    إلغاء
                  </button>
                  <button type="submit" className="shift-modal-primary" disabled={pending || customerListLoading}>
                    {customerLoading ? "جاري الإرسال…" : "إرسال طلب الموافقة"}
                  </button>
                </div>
              </>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
