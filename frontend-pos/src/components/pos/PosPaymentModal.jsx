import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "../../apiClient";
import { POS_SHORTCUTS } from "../../config/posShortcuts";
import { matchesShortcut } from "../../utils/posKeyboard";
import QtyStepper from "../QtyStepper";
import { handleEnterNavKeyDown } from "../../utils/focusNavigation";
import SearchableSelect from "../ui/SearchableSelect";
import { getAuthHeaders } from "../../utils/auth";
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

function defaultMixedPair(currencyId) {
  return [
    { method: "visa", currencyId, amount: "" },
    { method: "cash", currencyId, amount: "" },
  ];
}

function complementMethod(method) {
  return method === "visa" ? "cash" : "visa";
}

function lineRate(currencyId, getCurrency) {
  const cur = getCurrency(currencyId);
  const rate = cur ? Number(cur.exchange_rate_to_nis) : 1;
  return rate > 0 ? rate : null;
}

function toNis(amount, currencyId, getCurrency) {
  const rate = lineRate(currencyId, getCurrency);
  if (rate == null) return null;
  return round2(amount * rate);
}

function formatInCurrency(nis, currencyId, getCurrency) {
  const rate = lineRate(currencyId, getCurrency);
  if (rate == null) return "";
  return round2(nis / rate).toFixed(2);
}

/** Empty is not an error. Negative values and amounts above the payable total are rejected as typed. */
function mixedAmountProblem(raw, currencyId, total, getCurrency) {
  if (raw === "" || raw == null) return "";
  const n = Number(String(raw).replace(",", "."));
  if (!Number.isFinite(n)) return "أدخل مبلغاً صالحاً";
  if (n < 0) return "لا يمكن إدخال مبلغ سالب";
  const nis = toNis(round2(n), currencyId, getCurrency);
  if (nis == null) return "أدخل مبلغاً صالحاً";
  if (nis > round2(total) + TOLERANCE) return "المبلغ أكبر من إجمالي الفاتورة";
  return "";
}

function withOppositeRemainder(lines, editedIdx, total, getCurrency) {
  if (lines.length !== 2 || (editedIdx !== 0 && editedIdx !== 1)) return lines;
  const edited = lines[editedIdx];
  if (mixedAmountProblem(edited.amount, edited.currencyId, total, getCurrency)) return lines;
  const entered =
    edited.amount === "" || edited.amount == null ? 0 : parseAmount(edited.amount);
  if (entered == null || entered < 0) return lines;
  const nis = toNis(entered, edited.currencyId, getCurrency);
  if (nis == null || nis > round2(total) + TOLERANCE) return lines;
  const otherIdx = editedIdx === 0 ? 1 : 0;
  const formatted = formatInCurrency(round2(total - nis), lines[otherIdx].currencyId, getCurrency);
  if (lines[otherIdx].amount === formatted) return lines;
  return lines.map((l, i) => (i === otherIdx ? { ...l, amount: formatted } : l));
}

export default function PosPaymentModal({
  open,
  total,
  roundingAdjustment = 0,
  selectedPayment,
  onSelectPayment,
  customerId,
  onSelectCustomer,
  employeeId,
  onSelectEmployee,
  error,
  isLoading,
  onTarhil,
  onClose,
}) {
  const [currencies, setCurrencies] = useState([]);
  const [cashCurrencyId, setCashCurrencyId] = useState(null);
  const [changeCurrencyId, setChangeCurrencyId] = useState(null);
  const [amountTendered, setAmountTendered] = useState("");
  const [mixedLines, setMixedLines] = useState(() => defaultMixedPair(null));
  const [cashErr, setCashErr] = useState("");
  const [mixedErr, setMixedErr] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState([]);
  const [selectedCustomerName, setSelectedCustomerName] = useState("");
  const [partyType, setPartyType] = useState("customer");
  const [employees, setEmployees] = useState([]);
  const [employeesLoading, setEmployeesLoading] = useState(false);
  const [employeesError, setEmployeesError] = useState("");
  const [onAccountNotes, setOnAccountNotes] = useState("");
  const [notesErr, setNotesErr] = useState("");

  const baseCurrency = useMemo(
    () => currencies.find((c) => c.is_base) || currencies[0] || null,
    [currencies]
  );
  const [seenOpen, setSeenOpen] = useState(open);
  if (open !== seenOpen) {
    setSeenOpen(open);
    if (open) {
      setMixedLines(defaultMixedPair(baseCurrency?.id ?? null));
      setMixedErr("");
    }
  }

  const getCurrency = useCallback(
    (id) => currencies.find((c) => Number(c.id) === Number(id)) || baseCurrency,
    [currencies, baseCurrency]
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setMixedLines(() => defaultMixedPair(baseCurrency?.id ?? null));
    api
      .get("/api/currencies")
      .then(({ data }) => {
        if (cancelled) return;
        const list = Array.isArray(data?.currencies) ? data.currencies : [];
        setCurrencies(list);
        const base = list.find((c) => c.is_base) || list[0] || null;
        setCashCurrencyId(base ? base.id : null);
        setChangeCurrencyId(base ? base.id : null);
        setMixedLines((prev) => {
          const rows = prev.length >= 2 ? prev : defaultMixedPair(base ? base.id : null);
          if (!base) return rows;
          return rows.map((line) =>
            line.currencyId == null ? { ...line, currencyId: base.id } : line
          );
        });
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
    if (!open) {
      setOnAccountNotes("");
      setNotesErr("");
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setAmountTendered("0");
    setCashErr("");
    setMixedErr("");
    setCustomerQuery("");
    setCustomerResults([]);
    setSelectedCustomerName("");
  }, [open, total]);

  useEffect(() => {
    if (!open) return;
    setPartyType("customer");
    setEmployeesError("");
  }, [open]);

  useEffect(() => {
    if (selectedPayment !== "on_account") {
      setCustomerQuery("");
      setCustomerResults([]);
      onSelectCustomer(null);
      setSelectedCustomerName("");
      if (typeof onSelectEmployee === "function") onSelectEmployee(null);
      setPartyType("customer");
    }
  }, [selectedPayment, onSelectCustomer, onSelectEmployee]);

  useEffect(() => {
    if (selectedPayment !== "on_account" || partyType !== "customer") return;
    const t = setTimeout(() => searchCustomers(customerQuery), 300);
    return () => clearTimeout(t);
  }, [customerQuery, selectedPayment, partyType, searchCustomers]);

  useEffect(() => {
    if (!open || selectedPayment !== "on_account" || partyType !== "employee") return;
    let cancelled = false;
    setEmployeesLoading(true);
    setEmployeesError("");
    api
      .get("/api/pos/employees", { headers: getAuthHeaders() })
      .then(({ data }) => {
        if (cancelled) return;
        setEmployees(Array.isArray(data) ? data : []);
        if (!Array.isArray(data) || data.length === 0) {
          setEmployeesError("لا يوجد موظفون مسجلون. أضف الموظفين من الموظفون والرواتب.");
        }
      })
      .catch((err) => {
        if (!cancelled) setEmployeesError(err.response?.data?.error || err.message || "فشل تحميل الموظفين");
      })
      .finally(() => {
        if (!cancelled) setEmployeesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedPayment, partyType]);

  // ----- Cash (single, currency-aware) -----
  const cashCurrency = getCurrency(cashCurrencyId);
  const cashRate = cashCurrency ? Number(cashCurrency.exchange_rate_to_nis) : 1;
  const receivedNum = parseAmount(amountTendered);
  const cashEquivalentNis = receivedNum != null ? round2(receivedNum * cashRate) : null;
  const cashChangeDue =
    cashEquivalentNis != null ? Math.max(0, round2(cashEquivalentNis - total)) : null;
  const changeCurrency = getCurrency(changeCurrencyId) || baseCurrency;
  const changeRate = changeCurrency ? Number(changeCurrency.exchange_rate_to_nis) || 1 : 1;
  const cashChangeOriginal =
    cashChangeDue != null && cashChangeDue > 0
      ? changeCurrency && !changeCurrency.is_base && changeRate > 0
        ? round2(cashChangeDue / changeRate)
        : cashChangeDue
      : null;
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

  const mixedChangeOriginal =
    mixedComputed.change > 0
      ? changeCurrency && !changeCurrency.is_base && changeRate > 0
        ? round2(mixedComputed.change / changeRate)
        : mixedComputed.change
      : null;

  const mixedInputError = useMemo(() => {
    if (selectedPayment !== "mixed") return "";
    for (const line of mixedLines) {
      const problem = mixedAmountProblem(line.amount, line.currencyId, total, getCurrency);
      if (problem) return problem;
    }
    return "";
  }, [selectedPayment, mixedLines, total, getCurrency]);

  const mixedValid =
    selectedPayment !== "mixed" || (mixedComputed.valid && !mixedInputError);

  function updateMixedLine(idx, key, value) {
    setMixedErr("");
    setMixedLines((prev) => {
      const next = prev.map((l, i) => (i === idx ? { ...l, [key]: value } : l));
      if (key === "method" && (idx === 0 || idx === 1) && next.length >= 2) {
        const other = idx === 0 ? 1 : 0;
        next[other] = { ...next[other], method: complementMethod(value) };
        return next;
      }
      const pair = prev.length === 2 && (idx === 0 || idx === 1);
      if (key === "amount" && pair) return withOppositeRemainder(next, idx, total, getCurrency);
      if (key === "currencyId" && pair && String(next[idx].amount ?? "") !== "") {
        return withOppositeRemainder(next, idx, total, getCurrency);
      }
      return next;
    });
  }

  function addMixedLine() {
    setMixedLines((prev) => [
      ...prev,
      {
        method: "cash",
        currencyId: baseCurrency ? baseCurrency.id : null,
        amount: "",
      },
    ]);
  }

  function removeMixedLine(idx) {
    setMixedLines((prev) => (prev.length <= 2 ? prev : prev.filter((_, i) => i !== idx)));
  }

  const canTarhil =
    !!selectedPayment &&
    !isLoading &&
    cashValid &&
    mixedValid &&
    (selectedPayment !== "on_account" ||
      (partyType === "employee" ? !!employeeId : !!customerId));

  function pickCustomer(c) {
    onSelectCustomer(c.id);
    if (typeof onSelectEmployee === "function") onSelectEmployee(null);
    setSelectedCustomerName(c.name);
    setCustomerQuery(c.name);
    setCustomerResults([]);
  }

  function chooseParty(next) {
    setPartyType(next);
    if (next === "customer") {
      if (typeof onSelectEmployee === "function") onSelectEmployee(null);
    } else {
      onSelectCustomer(null);
      setSelectedCustomerName("");
      setCustomerQuery("");
      setCustomerResults([]);
    }
  }

  const submittingRef = useRef(false);
  const handleTarhil = useCallback(() => {
    if (submittingRef.current || isLoading) return;
    if (!canTarhil) {
      if (selectedPayment === "cash" && !cashValid) {
        setCashErr("المبلغ المستلم (بالمعادل بالشيكل) يجب أن يغطي الإجمالي");
      }
      if (selectedPayment === "mixed" && !mixedValid) {
        setMixedErr("تحقق من المبالغ — يجب أن يغطي المجموع الفاتورة والفائض من النقد فقط");
      }
      return;
    }
    const zimmaNotes = selectedPayment === "on_account" ? onAccountNotes.trim() : "";
    if (zimmaNotes.length > 500) {
      setNotesErr("الملاحظات يجب ألا تتجاوز 500 حرف");
      return;
    }
    setCashErr("");
    setMixedErr("");
    setNotesErr("");
    submittingRef.current = true;

    if (selectedPayment === "mixed") {
      const payments = mixedLines
        .map((l) => ({
          method: l.method,
          currency_id: l.currencyId,
          original_amount: parseAmount(l.amount),
        }))
        .filter((p) => p.original_amount != null && p.original_amount > 0);
      onTarhil({
        payments,
        payment_method: "mixed",
        ...(mixedComputed.change > 0 && changeCurrencyId
          ? { change_currency_id: changeCurrencyId }
          : {}),
      });
      return;
    }

    if (selectedPayment === "cash") {
      onTarhil({
        payments: [
          {
            method: "cash",
            currency_id: cashCurrencyId,
            original_amount: receivedNum,
          },
        ],
        payment_method: "cash",
        cash_tendered: cashEquivalentNis,
        ...(cashChangeDue > 0 && changeCurrencyId ? { change_currency_id: changeCurrencyId } : {}),
      });
      return;
    }

    // visa / on_account settle exactly in the base (accounting) currency.
    if (selectedPayment === "on_account") {
      onTarhil({
        payment_method: "on_account",
        ...(zimmaNotes ? { notes: zimmaNotes } : {}),
      });
      return;
    }
    onTarhil({ payment_method: selectedPayment });
  }, [
    canTarhil,
    cashCurrencyId,
    cashEquivalentNis,
    cashChangeDue,
    changeCurrencyId,
    receivedNum,
    cashValid,
    mixedComputed.change,
    mixedLines,
    mixedValid,
    onAccountNotes,
    onTarhil,
    selectedPayment,
    total,
    isLoading,
  ]);

  const handleTarhilRef = useRef(handleTarhil);
  handleTarhilRef.current = handleTarhil;

  const wasLoadingRef = useRef(false);
  useEffect(() => {
    if (!open) {
      submittingRef.current = false;
      wasLoadingRef.current = false;
      return;
    }
    if (isLoading) {
      wasLoadingRef.current = true;
    } else if (wasLoadingRef.current) {
      submittingRef.current = false;
      wasLoadingRef.current = false;
    }
  }, [open, isLoading]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(ev) {
      if (!matchesShortcut(ev, POS_SHORTCUTS.submitPayment.key)) return;
      ev.preventDefault();
      if (ev.repeat) return;
      handleTarhilRef.current();
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
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
      <div className="shift-modal-panel pos-payment-modal" data-enter-nav="" onKeyDown={handleEnterNavKeyDown}>
        <div className="pos-payment-modal-head">
          <h2 className="shift-modal-title">إتمام البيع</h2>
          <div className="pos-payment-modal-total">
            <span className="pos-payment-modal-total-label">الإجمالي</span>
            <span className="pos-payment-modal-total-amount">{ils(total)}</span>
            {Number(roundingAdjustment) ? (
              <span className="pos-payment-modal-total-label">
                تقريب {Number(roundingAdjustment) > 0 ? "+" : ""}
                {Number(roundingAdjustment).toFixed(2)}
              </span>
            ) : null}
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
              <span>
                الباقي:{" "}
                {cashChangeOriginal != null
                  ? fmtCurrency(changeCurrency?.symbol, cashChangeOriginal)
                  : "—"}
                {cashChangeDue != null && changeCurrency && !changeCurrency.is_base
                  ? ` (${ils(cashChangeDue)})`
                  : ""}
              </span>
            </div>
            {cashChangeDue > 0 ? (
              <label>
                عملة الباقي
                <select
                  value={changeCurrencyId ?? ""}
                  onChange={(e) => setChangeCurrencyId(Number(e.target.value))}
                >
                  {currencyOptions}
                </select>
              </label>
            ) : null}
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
              return (
                <div className="pos-mixed-line" key={idx}>
                  <select
                    aria-label={`طريقة الدفع ${idx + 1}`}
                    value={line.method}
                    onChange={(e) => updateMixedLine(idx, "method", e.target.value)}
                  >
                    <option value="cash">نقدي</option>
                    <option value="visa">فيزا</option>
                  </select>
                  <select
                    aria-label={`عملة الدفع ${idx + 1}`}
                    value={line.currencyId ?? ""}
                    onChange={(e) =>
                      updateMixedLine(idx, "currencyId", Number(e.target.value))
                    }
                  >
                    {currencyOptions}
                  </select>
                  <QtyStepper
                    precision={2}
                    value={line.amount}
                    onChange={(e) => updateMixedLine(idx, "amount", e.target.value)}
                    placeholder="0.00"
                    aria-label={`مبلغ الدفع ${idx + 1}`}
                  />
                  <span className="pos-mixed-line-nis">
                    {nis != null && cur && !cur.is_base ? ils(nis) : ""}
                  </span>
                  <button
                    type="button"
                    className="pos-mixed-line-remove"
                    onClick={() => removeMixedLine(idx)}
                    disabled={mixedLines.length <= 2}
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
                <span>
                  الباقي:{" "}
                  {mixedChangeOriginal != null
                    ? fmtCurrency(changeCurrency?.symbol, mixedChangeOriginal)
                    : ils(mixedComputed.change)}
                  {changeCurrency && !changeCurrency.is_base ? ` (${ils(mixedComputed.change)})` : ""}
                </span>
              ) : null}
            </div>
            {mixedComputed.change > 0 ? (
              <label>
                عملة الباقي
                <select
                  value={changeCurrencyId ?? ""}
                  onChange={(e) => setChangeCurrencyId(Number(e.target.value))}
                >
                  {currencyOptions}
                </select>
              </label>
            ) : null}
          </div>
        ) : null}

        {selectedPayment === "on_account" ? (
          <div className="pos-customer-pick">
            <div className="pos-zimma-party" role="tablist" aria-label="طرف الذمة">
              <button
                type="button"
                role="tab"
                aria-selected={partyType === "customer"}
                className={partyType === "customer" ? "pos-zimma-party-btn active" : "pos-zimma-party-btn"}
                onClick={() => chooseParty("customer")}
              >
                عميل
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={partyType === "employee"}
                className={partyType === "employee" ? "pos-zimma-party-btn active" : "pos-zimma-party-btn"}
                onClick={() => chooseParty("employee")}
              >
                موظف
              </button>
            </div>
            {partyType === "customer" ? (
              <>
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
              </>
            ) : (
              <label className="shift-modal-label">
                الموظف
                <SearchableSelect
                  className="shift-modal-input"
                  value={employeeId || ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (typeof onSelectEmployee === "function") {
                      onSelectEmployee(v ? Number(v) : null);
                    }
                    onSelectCustomer(null);
                  }}
                  placeholder="ابحث عن موظف…"
                  disabled={employeesLoading || employees.length === 0}
                >
                  <option value="">اختر الموظف</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.display_name || emp.name}
                    </option>
                  ))}
                </SearchableSelect>
              </label>
            )}
            {partyType === "employee" && employeesError ? (
              <div className="shift-modal-err">{employeesError}</div>
            ) : null}
            <label className="shift-modal-label pos-zimma-notes">
              ملاحظات (اختياري)
              <textarea
                className="shift-modal-textarea"
                value={onAccountNotes}
                maxLength={500}
                rows={2}
                placeholder="اكتب ملاحظة عن عملية الذمة…"
                aria-label="ملاحظات عملية الذمة"
                onChange={(e) => {
                  setOnAccountNotes(e.target.value);
                  setNotesErr("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.stopPropagation();
                }}
              />
            </label>
          </div>
        ) : null}

        {cashErr ? <div className="shift-modal-err">{cashErr}</div> : null}
        {mixedInputError || mixedErr ? (
          <div className="shift-modal-err">{mixedInputError || mixedErr}</div>
        ) : null}
        {notesErr ? <div className="shift-modal-err">{notesErr}</div> : null}
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
