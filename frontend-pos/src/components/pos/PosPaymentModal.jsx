import { useCallback, useEffect, useRef, useState } from "react";
import api from "../../apiClient";
import "../ShiftModal.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

export default function PosPaymentModal({
  open,
  total,
  selectedPayment,
  onSelectPayment,
  customerId,
  onSelectCustomer,
  error,
  isLoading,
  onTarhil,
  onClose,
}) {
  const [amountTendered, setAmountTendered] = useState("");
  const [cashErr, setCashErr] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState([]);
  const [selectedCustomerName, setSelectedCustomerName] = useState("");

  const searchCustomers = useCallback(async (q) => {
    if (!q || q.length < 2) {
      setCustomerResults([]);
      return;
    }
    try {
      const { data } = await api.get(`/api/customers?q=${encodeURIComponent(q)}`);
      setCustomerResults(Array.isArray(data) ? data.slice(0, 8) : []);
    } catch {
      setCustomerResults([]);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setAmountTendered("");
    setCashErr("");
    setCustomerQuery("");
    setCustomerResults([]);
    setSelectedCustomerName("");
  }, [open]);

  useEffect(() => {
    if (selectedPayment !== "on_account") {
      setCustomerQuery("");
      setCustomerResults([]);
      onSelectCustomer(null);
      setSelectedCustomerName("");
    }
  }, [selectedPayment, onSelectCustomer]);

  useEffect(() => {
    if (selectedPayment !== "on_account") return;
    const t = setTimeout(() => searchCustomers(customerQuery), 300);
    return () => clearTimeout(t);
  }, [customerQuery, selectedPayment, searchCustomers]);

  const tenderedNum = Number(String(amountTendered).replace(",", "."));
  const changeDue =
    amountTendered !== "" && !Number.isNaN(tenderedNum)
      ? Math.max(0, round2(tenderedNum - total))
      : null;

  const cashValid =
    selectedPayment !== "cash" ||
    (amountTendered !== "" && !Number.isNaN(tenderedNum) && tenderedNum >= total);

  const canTarhil =
    !!selectedPayment &&
    !isLoading &&
    cashValid &&
    (selectedPayment !== "on_account" || !!customerId);

  function pickCustomer(c) {
    onSelectCustomer(c.id);
    setSelectedCustomerName(c.name);
    setCustomerQuery(c.name);
    setCustomerResults([]);
  }

  const handleTarhil = useCallback(() => {
    if (!canTarhil) {
      if (selectedPayment === "cash" && !cashValid) {
        setCashErr("المبلغ المستلم يجب أن يكون أكبر من أو يساوي الإجمالي");
      }
      return;
    }
    setCashErr("");
    onTarhil();
  }, [canTarhil, cashValid, onTarhil, selectedPayment]);

  const handleTarhilRef = useRef(handleTarhil);
  handleTarhilRef.current = handleTarhil;

  useEffect(() => {
    if (!open) return;

    function onKeyDown(ev) {
      if (ev.key !== "F9") return;
      ev.preventDefault();
      handleTarhilRef.current();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;

  return (
    <div className="shift-modal-overlay" role="dialog" aria-modal="true" dir="rtl" lang="ar">
      <div className="shift-modal-backdrop" onClick={onClose} aria-hidden />
      <div className="shift-modal-panel pos-payment-modal">
        <h2 className="shift-modal-title">إتمام البيع</h2>
        <p className="shift-modal-meta">الإجمالي: {ils(total)}</p>

        <div className="pos-pay-methods pos-payment-modal-methods">
          {[
            ["cash", "نقد"],
            ["visa", "بطاقة"],
            ["on_account", "ذمة"],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={
                selectedPayment === key ? "pos-pay-method active" : "pos-pay-method"
              }
              onClick={() => onSelectPayment(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {selectedPayment === "cash" ? (
          <div className="pos-cash-extra">
            <label>
              المستلم
              <input
                type="number"
                min="0"
                step="0.01"
                value={amountTendered}
                onChange={(e) => {
                  setAmountTendered(e.target.value);
                  setCashErr("");
                }}
                placeholder="0.00"
                autoFocus
              />
            </label>
            <label>
              الباقي
              <input
                type="text"
                readOnly
                tabIndex={-1}
                value={changeDue != null ? ils(changeDue) : "—"}
              />
            </label>
          </div>
        ) : null}

        {selectedPayment === "on_account" ? (
          <div className="pos-customer-pick">
            <input
              type="text"
              placeholder="ابحث عن عميل…"
              value={customerQuery}
              onChange={(e) => {
                setCustomerQuery(e.target.value);
                if (!e.target.value) {
                  onSelectCustomer(null);
                  setSelectedCustomerName("");
                }
              }}
            />
            {selectedCustomerName ? (
              <span className="pos-pill">العميل: {selectedCustomerName}</span>
            ) : null}
            {customerResults.length > 0 && (
              <ul className="pos-customer-results">
                {customerResults.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => pickCustomer(c)}>
                      {c.name}
                      {c.phone ? ` — ${c.phone}` : ""}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {cashErr ? <div className="shift-modal-err">{cashErr}</div> : null}
        {error ? <p className="pos-err">{error}</p> : null}

        <div className="shift-modal-actions">
          <button
            type="button"
            className="shift-modal-secondary"
            onClick={onClose}
            disabled={isLoading}
          >
            إلغاء
          </button>
          <button
            type="button"
            className="shift-modal-primary pos-payment-modal-tarhil"
            disabled={!canTarhil}
            onClick={handleTarhil}
          >
            {isLoading ? "جاري المعالجة…" : "ترحيل"}
          </button>
        </div>
        <p className="pos-tarhil-hint">F9 — ترحيل بعد تسليم الباقي للزبون</p>
      </div>
    </div>
  );
}
