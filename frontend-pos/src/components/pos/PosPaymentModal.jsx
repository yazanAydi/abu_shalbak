import { useCallback, useEffect, useRef, useState } from "react";
import api from "../../apiClient";
import { POS_SHORTCUTS } from "../../config/posShortcuts";
import { matchesShortcut } from "../../utils/posKeyboard";
import "../ShiftModal.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;
const TOLERANCE = 0.005;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function getMixedErrorMessage(cashInput, visaInput, mixedPaid, total) {
  if (cashInput == null || visaInput == null) {
    return "أدخل مبالغ النقد والفيزا";
  }
  if (visaInput > total + TOLERANCE) {
    return "مبلغ الفيزا أكبر من إجمالي الفاتورة";
  }
  if (mixedPaid < total - TOLERANCE) {
    return "المبلغ المدفوع أقل من إجمالي الفاتورة";
  }
  if (visaInput > TOLERANCE && Math.abs(mixedPaid - total) > TOLERANCE) {
    return "مجموع النقد والفيزا يجب أن يساوي إجمالي الفاتورة";
  }
  return "تحقق من مبالغ النقد والفيزا — يجب أن يغطي المجموع الفاتورة";
}

function parseAmount(raw) {
  if (raw === "" || raw == null) return null;
  const n = Number(String(raw).replace(",", "."));
  return Number.isFinite(n) ? round2(n) : null;
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
  const [cashAmount, setCashAmount] = useState("");
  const [visaAmount, setVisaAmount] = useState("");
  const [cashErr, setCashErr] = useState("");
  const [mixedErr, setMixedErr] = useState("");
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
    setCashAmount("");
    setVisaAmount("");
    setCashErr("");
    setMixedErr("");
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

  const tenderedNum = parseAmount(amountTendered);
  const cashInput = parseAmount(cashAmount);
  const visaInput = parseAmount(visaAmount);

  const changeDue =
    selectedPayment === "cash" && tenderedNum != null
      ? Math.max(0, round2(tenderedNum - total))
      : null;

  const mixedPaid =
    cashInput != null || visaInput != null
      ? round2((cashInput ?? 0) + (visaInput ?? 0))
      : null;
  const mixedRemaining =
    mixedPaid != null ? Math.max(0, round2(total - mixedPaid)) : null;
  const mixedCashApplied =
    cashInput != null && visaInput != null
      ? round2(Math.min(cashInput, Math.max(0, total - visaInput)))
      : null;
  const mixedChange =
    mixedCashApplied != null && cashInput != null
      ? Math.max(0, round2(cashInput - mixedCashApplied))
      : null;
  const mixedMatched =
    mixedPaid != null &&
    visaInput != null &&
    visaInput > TOLERANCE &&
    Math.abs(mixedPaid - total) <= TOLERANCE;

  const cashValid =
    selectedPayment !== "cash" ||
    (tenderedNum != null && tenderedNum >= total);

  const mixedValid =
    selectedPayment !== "mixed" ||
    (cashInput != null &&
      visaInput != null &&
      cashInput >= 0 &&
      visaInput >= 0 &&
      visaInput <= total + TOLERANCE &&
      mixedPaid >= total - TOLERANCE &&
      (visaInput <= TOLERANCE || Math.abs(mixedPaid - total) <= TOLERANCE));

  function handleCashAmountChange(raw) {
    setCashAmount(raw);
    setMixedErr("");
    const cash = parseAmount(raw);
    if (cash == null) {
      setVisaAmount("");
      return;
    }
    setVisaAmount(String(round2(Math.max(0, total - cash))));
  }

  function handleVisaAmountChange(raw) {
    setVisaAmount(raw);
    setMixedErr("");
    const visa = parseAmount(raw);
    if (visa == null) {
      setCashAmount("");
      return;
    }
    setCashAmount(String(round2(Math.max(0, total - visa))));
  }

  const canTarhil =
    !!selectedPayment &&
    !isLoading &&
    cashValid &&
    mixedValid &&
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
      if (selectedPayment === "mixed" && !mixedValid) {
        setMixedErr(getMixedErrorMessage(cashInput, visaInput, mixedPaid, total));
      }
      return;
    }
    setCashErr("");
    setMixedErr("");

    if (selectedPayment === "mixed") {
      const cashApplied = round2(Math.max(0, total - visaInput));
      onTarhil({
        payments: [
          { method: "cash", amount: cashApplied },
          { method: "visa", amount: visaInput },
        ],
        payment_method: "mixed",
        cash_tendered: cashInput,
      });
      return;
    }

    if (selectedPayment === "cash") {
      onTarhil({
        payment_method: "cash",
        cash_tendered: tenderedNum,
      });
      return;
    }

    onTarhil({ payment_method: selectedPayment });
  }, [
    canTarhil,
    cashInput,
    cashValid,
    mixedPaid,
    mixedValid,
    onTarhil,
    selectedPayment,
    tenderedNum,
    total,
    visaInput,
  ]);

  const handleTarhilRef = useRef(handleTarhil);
  handleTarhilRef.current = handleTarhil;

  useEffect(() => {
    if (!open) return;

    function onKeyDown(ev) {
      if (!matchesShortcut(ev, POS_SHORTCUTS.submitPayment.key)) return;
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
            ["cash", "نقدي"],
            ["visa", "فيزا"],
            ["mixed", "مختلط / دفع متعدد"],
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

        {selectedPayment === "mixed" ? (
          <div className="pos-mixed-pay">
            <div className="pos-mixed-summary">
              <span>الإجمالي: {ils(total)}</span>
            </div>
            <label>
              نقدي
              <input
                type="number"
                min="0"
                step="0.01"
                value={cashAmount}
                onChange={(e) => handleCashAmountChange(e.target.value)}
                placeholder="0.00"
                autoFocus
              />
            </label>
            <label>
              فيزا
              <input
                type="number"
                min="0"
                step="0.01"
                value={visaAmount}
                onChange={(e) => handleVisaAmountChange(e.target.value)}
                placeholder="0.00"
              />
            </label>
            <div
              className={
                mixedMatched ? "pos-mixed-totals pos-mixed-totals--matched" : "pos-mixed-totals"
              }
            >
              <span>المدفوع: {mixedPaid != null ? ils(mixedPaid) : "—"}</span>
              <span>المتبقي: {mixedRemaining != null ? ils(mixedRemaining) : "—"}</span>
              {mixedChange != null && mixedChange > 0 ? (
                <span>الباقي (نقد): {ils(mixedChange)}</span>
              ) : null}
            </div>
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
        {mixedErr ? <div className="shift-modal-err">{mixedErr}</div> : null}
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
        <p className="pos-tarhil-hint">
          {POS_SHORTCUTS.submitPayment.key} — ترحيل بعد تسليم الباقي للزبون
        </p>
      </div>
    </div>
  );
}
