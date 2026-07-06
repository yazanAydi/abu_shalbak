import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "../../apiClient";
import { POS_SHORTCUTS } from "../../config/posShortcuts";
import { matchesShortcut } from "../../utils/posKeyboard";
import QtyStepper from "../QtyStepper";
import "../ShiftModal.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;
const TOLERANCE = 0.005;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function parseAmount(raw) {
  if (raw === "" || raw == null) return null;
  const n = Number(String(raw).replace(",", "."));
  return Number.isFinite(n) ? round2(n) : null;
}

function fmtCurrency(symbol, amount) {
  return `${symbol || "\u20AA"}${Number(amount || 0).toFixed(2)}`;
}

function computeMixedPaidNis(lines, getCurrency, excludeLast = false) {
  const end = excludeLast && lines.length > 1 ? lines.length - 1 : lines.length;
  let paidNis = 0;
  for (let i = 0; i < end; i++) {
    const line = lines[i];
    const amt = parseAmount(line.amount);
    if (amt == null || amt <= 0) continue;
    const cur = getCurrency(line.currencyId);
    const rate = cur ? Number(cur.exchange_rate_to_nis) : 1;
    paidNis = round2(paidNis + round2(amt * rate));
  }
  return paidNis;
}

function remainderAmountForLine(remainingNis, currencyId, getCurrency) {
  const cur = getCurrency(currencyId);
  const rate = cur ? Number(cur.exchange_rate_to_nis) : 1;
  if (rate <= 0) return "";
  const amount = round2(Math.max(0, remainingNis) / rate);
  return remainingNis > TOLERANCE ? String(amount) : "";
}

function withSyncedMixedRemainder(lines, total, getCurrency) {
  if (lines.length <= 1) return lines;
  const paidExceptLast = computeMixedPaidNis(lines, getCurrency, true);
  const remainingNis = Math.max(0, round2(total - paidExceptLast));
  const lastIdx = lines.length - 1;
  const last = lines[lastIdx];
  const amountStr = remainderAmountForLine(remainingNis, last.currencyId, getCurrency);
  if (last.amount === amountStr) return lines;
  return lines.map((l, i) => (i === lastIdx ? { ...l, amount: amountStr } : l));
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
  const [currencies, setCurrencies] = useState([]);
  const [cashCurrencyId, setCashCurrencyId] = useState(null);
  const [amountTendered, setAmountTendered] = useState("");
  const [mixedLines, setMixedLines] = useState([]);
  const [cashErr, setCashErr] = useState("");
  const [mixedErr, setMixedErr] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState([]);
  const [selectedCustomerName, setSelectedCustomerName] = useState("");

  const baseCurrency = useMemo(
    () => currencies.find((c) => c.is_base) || currencies[0] || null,
    [currencies]
  );

  const getCurrency = useCallback(
    (id) => currencies.find((c) => Number(c.id) === Number(id)) || baseCurrency,
    [currencies, baseCurrency]
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .get("/api/currencies")
      .then(({ data }) => {
        if (cancelled) return;
        const list = Array.isArray(data?.currencies) ? data.currencies : [];
        setCurrencies(list);
        const base = list.find((c) => c.is_base) || list[0] || null;
        setCashCurrencyId(base ? base.id : null);
        setMixedLines([
          { method: "cash", currencyId: base ? base.id : null, amount: "" },
        ]);
      })
      .catch(() => {
        if (!cancelled) setCurrencies([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

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

  // ----- Cash (single, currency-aware) -----
  const cashCurrency = getCurrency(cashCurrencyId);
  const cashRate = cashCurrency ? Number(cashCurrency.exchange_rate_to_nis) : 1;
  const receivedNum = parseAmount(amountTendered);
  const cashEquivalentNis = receivedNum != null ? round2(receivedNum * cashRate) : null;
  const cashChangeDue =
    cashEquivalentNis != null ? Math.max(0, round2(cashEquivalentNis - total)) : null;
  const cashValid =
    selectedPayment !== "cash" ||
    (cashEquivalentNis != null && cashEquivalentNis >= total - TOLERANCE);

  // ----- Mixed (fully flexible multi-line) -----
  const mixedComputed = useMemo(() => {
    let paidNis = 0;
    let cashNis = 0;
    let nonCashNis = 0;
    for (const line of mixedLines) {
      const amt = parseAmount(line.amount);
      if (amt == null || amt <= 0) continue;
      const cur = getCurrency(line.currencyId);
      const rate = cur ? Number(cur.exchange_rate_to_nis) : 1;
      const nis = round2(amt * rate);
      paidNis = round2(paidNis + nis);
      if (line.method === "cash") cashNis = round2(cashNis + nis);
      else nonCashNis = round2(nonCashNis + nis);
    }
    const remaining = Math.max(0, round2(total - paidNis));
    const excess = round2(paidNis - total);
    const change = excess > TOLERANCE ? excess : 0;
    const changeValid = change <= cashNis + TOLERANCE;
    const valid =
      paidNis >= total - TOLERANCE && changeValid && nonCashNis <= total + TOLERANCE;
    return { paidNis, cashNis, nonCashNis, remaining, change, valid };
  }, [mixedLines, getCurrency, total]);

  const mixedValid = selectedPayment !== "mixed" || mixedComputed.valid;

  function updateMixedLine(idx, key, value) {
    setMixedErr("");
    setMixedLines((prev) => {
      const next = prev.map((l, i) => (i === idx ? { ...l, [key]: value } : l));
      const isLast = idx === prev.length - 1;
      const shouldSync = prev.length > 1 && (!isLast || key === "currencyId");
      return shouldSync ? withSyncedMixedRemainder(next, total, getCurrency) : next;
    });
  }

  function addMixedLine() {
    setMixedLines((prev) => {
      const next = [
        ...prev,
        {
          method: "cash",
          currencyId: baseCurrency ? baseCurrency.id : null,
          amount: "",
        },
      ];
      return withSyncedMixedRemainder(next, total, getCurrency);
    });
  }

  function removeMixedLine(idx) {
    setMixedLines((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((_, i) => i !== idx);
      return withSyncedMixedRemainder(next, total, getCurrency);
    });
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
        setCashErr("المبلغ المستلم (بالمعادل بالشيكل) يجب أن يغطي الإجمالي");
      }
      if (selectedPayment === "mixed" && !mixedValid) {
        setMixedErr("تحقق من المبالغ — يجب أن يغطي المجموع الفاتورة والفائض من النقد فقط");
      }
      return;
    }
    setCashErr("");
    setMixedErr("");

    if (selectedPayment === "mixed") {
      const payments = mixedLines
        .map((l) => ({
          method: l.method,
          currency_id: l.currencyId,
          original_amount: parseAmount(l.amount),
        }))
        .filter((p) => p.original_amount != null && p.original_amount > 0);
      onTarhil({ payments, payment_method: "mixed" });
      return;
    }

    if (selectedPayment === "cash") {
      onTarhil({
        payments: [
          { method: "cash", currency_id: cashCurrencyId, original_amount: receivedNum },
        ],
        payment_method: "cash",
      });
      return;
    }

    // visa / on_account settle exactly in the base (accounting) currency.
    onTarhil({ payment_method: selectedPayment });
  }, [
    canTarhil,
    cashCurrencyId,
    cashValid,
    mixedLines,
    mixedValid,
    onTarhil,
    receivedNum,
    selectedPayment,
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

  const currencyOptions = currencies.map((c) => (
    <option key={c.id} value={c.id}>
      {c.symbol} {c.code}
    </option>
  ));

  return (
    <div className="shift-modal-overlay" role="dialog" aria-modal="true" dir="rtl" lang="ar">
      <div className="shift-modal-backdrop" onClick={onClose} aria-hidden />
      <div className="shift-modal-panel pos-payment-modal">
        <div className="pos-payment-modal-head">
          <h2 className="shift-modal-title">إتمام البيع</h2>
          <div className="pos-payment-modal-total">
            <span className="pos-payment-modal-total-label">الإجمالي</span>
            <span className="pos-payment-modal-total-amount">{ils(total)}</span>
          </div>
        </div>

        <div className="pos-pay-methods pos-payment-modal-methods">
          {[
            ["cash", "نقدي"],
            ["visa", "فيزا"],
            ["mixed", "مختلط"],
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
              العملة
              <select
                value={cashCurrencyId ?? ""}
                onChange={(e) => {
                  setCashCurrencyId(Number(e.target.value));
                  setCashErr("");
                }}
              >
                {currencyOptions}
              </select>
            </label>
            <label>
              المستلم ({cashCurrency?.code || ""})
              <QtyStepper
                min={0}
                precision={2}
                value={amountTendered}
                onChange={(e) => {
                  setAmountTendered(e.target.value);
                  setCashErr("");
                }}
                placeholder="0.00"
                autoFocus
              />
            </label>
            <div className="pos-cash-breakdown">
              <span>
                المستلم:{" "}
                {receivedNum != null ? fmtCurrency(cashCurrency?.symbol, receivedNum) : "—"}
              </span>
              {cashCurrency && !cashCurrency.is_base ? (
                <span>
                  المعادل: {cashEquivalentNis != null ? ils(cashEquivalentNis) : "—"}
                  {"  "}(1 {cashCurrency.code} = {ils(cashRate)})
                </span>
              ) : null}
              <span>الفاتورة: {ils(total)}</span>
              <span>الباقي: {cashChangeDue != null ? ils(cashChangeDue) : "—"}</span>
            </div>
          </div>
        ) : null}

        {selectedPayment === "mixed" ? (
          <div className="pos-mixed-pay">
            <div className="pos-mixed-summary">
              <span>الإجمالي: {ils(total)}</span>
            </div>
            {mixedLines.map((line, idx) => {
              const cur = getCurrency(line.currencyId);
              const amt = parseAmount(line.amount);
              const nis =
                amt != null && cur ? round2(amt * Number(cur.exchange_rate_to_nis)) : null;
              const isAutoRemainder =
                mixedLines.length > 1 && idx === mixedLines.length - 1;
              return (
                <div className="pos-mixed-line" key={idx}>
                  <select
                    value={line.method}
                    onChange={(e) => updateMixedLine(idx, "method", e.target.value)}
                  >
                    <option value="cash">نقدي</option>
                    <option value="visa">فيزا</option>
                  </select>
                  <select
                    value={line.currencyId ?? ""}
                    onChange={(e) =>
                      updateMixedLine(idx, "currencyId", Number(e.target.value))
                    }
                  >
                    {currencyOptions}
                  </select>
                  <QtyStepper
                    min={0}
                    precision={2}
                    value={line.amount}
                    onChange={(e) => updateMixedLine(idx, "amount", e.target.value)}
                    placeholder="0.00"
                    readOnly={isAutoRemainder}
                    title={isAutoRemainder ? "يُحسب تلقائياً من المتبقي" : undefined}
                    className={isAutoRemainder ? "pos-mixed-line-amount--auto" : undefined}
                  />
                  <span className="pos-mixed-line-nis">
                    {nis != null && cur && !cur.is_base ? ils(nis) : ""}
                  </span>
                  <button
                    type="button"
                    className="pos-mixed-line-remove"
                    onClick={() => removeMixedLine(idx)}
                    disabled={mixedLines.length <= 1}
                    aria-label="حذف"
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <button type="button" className="pos-mixed-add" onClick={addMixedLine}>
              + إضافة طريقة دفع
            </button>
            <div
              className={
                mixedComputed.valid
                  ? "pos-mixed-totals pos-mixed-totals--matched"
                  : "pos-mixed-totals"
              }
            >
              <span>المدفوع: {ils(mixedComputed.paidNis)}</span>
              <span>المتبقي: {ils(mixedComputed.remaining)}</span>
              {mixedComputed.change > 0 ? (
                <span>الباقي: {ils(mixedComputed.change)}</span>
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
