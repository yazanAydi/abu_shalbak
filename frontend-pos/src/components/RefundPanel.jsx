import { useCallback, useEffect, useRef, useState } from "react";
import { dateOnly, dateTime, todayISO } from "../utils/format";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import PosRefundWaitingModal from "./pos/PosRefundWaitingModal";
import QtyStepper from "./QtyStepper";
import { DateField } from "./ui";
import "./RefundPanel.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

const PM_AR = { cash: "نقد", visa: "بطاقة", on_account: "ذمة" };

const SALES_PAGE_SIZE = 50;

function formatSaleTime(createdAt) {
  const full = dateTime(createdAt);
  if (!full || full === "—") return "";
  return full.slice(-5);
}

function saleLabel(sale) {
  return sale.receipt_number || `#${sale.transaction_id}`;
}

function todayIsoDate() {
  return todayISO();
}

function lineKey(line) {
  if (line?.transaction_item_id) return `item:${line.transaction_item_id}`;
  return `${line.product_id}:${line.unit_id || 0}`;
}

function newIdempotencyKey() {
  return `ret-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function SaleResultsList({ sales, loading, onSelect, loadingLookup }) {
  if (loading) {
    return <p className="rf-muted">جاري التحميل…</p>;
  }
  if (sales.length === 0) {
    return <p className="rf-muted">لا توجد نتائج</p>;
  }
  return (
    <ul className="rf-sale-list">
      {sales.map((sale) => {
        const fullyRefunded = !sale.returnable;
        return (
          <li key={sale.transaction_id}>
            <button
              type="button"
              className={`rf-sale-row${fullyRefunded ? " rf-sale-row--disabled" : ""}`}
              disabled={loadingLookup}
              onClick={() => onSelect(sale.transaction_id)}
            >
              <div className="rf-sale-row-top">
                <span className="rf-sale-receipt">{saleLabel(sale)}</span>
                <span className="rf-sale-total">{ils(sale.total)}</span>
              </div>
              <div className="rf-sale-row-meta">
                <span>{PM_AR[sale.payment_method] || sale.payment_method}</span>
                {sale.item_count > 0 ? <span>{sale.item_count} صنف</span> : null}
              </div>
              {sale.items_preview ? <p className="rf-sale-preview">{sale.items_preview}</p> : null}
              {fullyRefunded ? <span className="rf-sale-badge">مسترجع بالكامل</span> : null}
              <span className="rf-sale-time">{formatSaleTime(sale.created_at)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export default function RefundPanel({ shiftReady = true, shiftId = null, onRefundSuccess }) {
  const [view, setView] = useState("list");
  const [sales, setSales] = useState([]);
  const [salesTotal, setSalesTotal] = useState(0);
  const [salesLoading, setSalesLoading] = useState(false);
  const [tid, setTid] = useState("");
  const [lookup, setLookup] = useState(null);
  const [qtyByPid, setQtyByPid] = useState({});
  const [reason, setReason] = useState("");
  const [pm, setPm] = useState("cash");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [waitingRequestId, setWaitingRequestId] = useState(null);
  const [searchDateFrom, setSearchDateFrom] = useState(() => todayIsoDate());
  const [searchDateTo, setSearchDateTo] = useState(() => todayIsoDate());
  const [searchMinAmount, setSearchMinAmount] = useState("");
  const [searchMaxAmount, setSearchMaxAmount] = useState("");
  const [searchProduct, setSearchProduct] = useState("");
  const [searchReceipt, setSearchReceipt] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [quote, setQuote] = useState(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const retryRef = useRef({ key: "", body: "" });

  const loadSales = useCallback(async () => {
    if (!shiftReady || !shiftId) {
      setSales([]);
      return;
    }
    setSalesLoading(true);
    setErr("");
    try {
      const { data } = await api.get("/api/shifts/current/sales", {
        params: { limit: SALES_PAGE_SIZE },
        headers: getAuthHeaders(),
      });
      setSales(Array.isArray(data?.sales) ? data.sales : []);
      setSalesTotal(Number(data?.total) || 0);
    } catch (e) {
      setSales([]);
      setSalesTotal(0);
      setErr(e.response?.data?.error || e.message || "تعذّر تحميل المبيعات");
    } finally {
      setSalesLoading(false);
    }
  }, [shiftReady, shiftId]);

  useEffect(() => {
    setView("list");
    setLookup(null);
    setTid("");
    setReason("");
    loadSales();
  }, [loadSales]);

  const loadLookup = useCallback(async (transactionId) => {
    const key = String(transactionId ?? "").trim();
    if (!key) {
      setErr("رقم الفاتورة غير صالح");
      return;
    }
    if (!shiftReady) {
      setErr("افتح وردية أولاً لتسجيل الاسترجاع");
      return;
    }
    setErr("");
    setLoading(true);
    try {
      const { data } = await api.get(`/api/refunds/lookup/${encodeURIComponent(key)}`, {
        headers: getAuthHeaders(),
      });
      const payload = data?.data ?? data;
      setLookup(payload);
      const q = {};
      for (const L of payload.lines || []) {
        q[lineKey(L)] = 0;
      }
      setQtyByPid(q);
      setQuote(null);
      retryRef.current = { key: "", body: "" };
      setPm(payload.has_on_account ? "on_account" : "cash");
      setView("detail");
    } catch (e) {
      setLookup(null);
      setErr(e.response?.data?.error || e.message || "لم يُعثر على الفاتورة");
    } finally {
      setLoading(false);
    }
  }, [shiftReady]);

  async function submitRefund() {
    if (!shiftReady) {
      setErr("افتح وردية أولاً");
      return;
    }
    if (!lookup) return;
    const lines = [];
    for (const L of lookup.lines) {
      const q = Number(qtyByPid[lineKey(L)]) || 0;
      if (q > 0) {
        lines.push({
          product_id: L.product_id,
          quantity: q,
          unit_id: L.unit_id || undefined,
          transaction_item_id: L.transaction_item_id || undefined,
        });
      }
    }
    if (lines.length === 0) {
      setErr("حدد كمية للإرجاع");
      return;
    }
    const bodyObj = {
      original_transaction_id: lookup.transaction_id,
      lines,
      reason: reason || null,
      payment_method: pm,
    };
    const bodyText = JSON.stringify(bodyObj);
    if (retryRef.current.body !== bodyText) {
      retryRef.current = { key: newIdempotencyKey(), body: bodyText };
    }
    setErr("");
    setLoading(true);
    try {
      const { data } = await api.post(
        "/api/refund-requests",
        { ...bodyObj, idempotency_key: retryRef.current.key },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      const payload = data?.data ?? data;
      const requestId = payload.request_id ?? payload.request?.id;
      setLookup(null);
      setTid("");
      setReason("");
      setView("list");
      setWaitingRequestId(requestId);
      retryRef.current = { key: "", body: "" };
      loadSales();
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "فشل");
    } finally {
      setLoading(false);
    }
  }

  function closeWaiting() {
    setWaitingRequestId(null);
  }

  function onWaitingTerminal() {
    onRefundSuccess?.();
  }

  function backToList() {
    setLookup(null);
    setErr("");
    setView("list");
  }

  async function runPastSaleSearch(e) {
    e?.preventDefault();
    if (!shiftReady) {
      setErr("افتح وردية أولاً");
      return;
    }
    setErr("");
    setSearchLoading(true);
    try {
      const params = new URLSearchParams();
      const receipt = String(searchReceipt).trim();
      if (receipt) {
        params.set("receipt", receipt);
      } else {
        if (searchDateFrom) params.set("date_from", searchDateFrom);
        if (searchDateTo) params.set("date_to", searchDateTo);
      }
      if (String(searchMinAmount).trim() !== "") params.set("min_amount", String(searchMinAmount).trim());
      if (String(searchMaxAmount).trim() !== "") params.set("max_amount", String(searchMaxAmount).trim());
      if (String(searchProduct).trim() !== "") params.set("product", String(searchProduct).trim());
      const { data } = await api.get(`/api/refunds/search?${params.toString()}`, {
        headers: getAuthHeaders(),
      });
      const payload = data?.data ?? data;
      setSearchResults(Array.isArray(payload?.sales) ? payload.sales : []);
    } catch (err2) {
      setSearchResults([]);
      setErr(err2.response?.data?.error || err2.message || "فشل البحث");
    } finally {
      setSearchLoading(false);
    }
  }

  useEffect(() => {
    if (view !== "detail" || !lookup) {
      setQuote(null);
      return undefined;
    }
    const lines = [];
    for (const L of lookup.lines || []) {
      const q = Number(qtyByPid[lineKey(L)]) || 0;
      if (q > 0) {
        lines.push({
          product_id: L.product_id,
          quantity: q,
          unit_id: L.unit_id || undefined,
          transaction_item_id: L.transaction_item_id || undefined,
        });
      }
    }
    if (lines.length === 0) {
      setQuote(null);
      setQuoteLoading(false);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setQuoteLoading(true);
      try {
        const { data } = await api.post(
          "/api/refund-requests/preview",
          {
            original_transaction_id: lookup.transaction_id,
            lines,
            payment_method: pm,
          },
          { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
        );
        if (!cancelled) {
          setQuote(data?.data ?? data);
          setErr("");
        }
      } catch (e) {
        if (!cancelled) {
          setQuote(null);
          setErr(e.response?.data?.error || e.message || "تعذّر حساب مبلغ الاسترجاع");
        }
      } finally {
        if (!cancelled) setQuoteLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [view, lookup, qtyByPid, pm]);

  return (
    <>
      <div className={`rf-panel ${!shiftReady ? "rf-panel--disabled" : ""}`} dir="rtl">
        {!shiftReady ? (
          <>
            <h3 className="rf-title">استرجاع</h3>
            <p className="rf-muted">يجب بدء الوردية قبل استخدام الاسترجاع.</p>
          </>
        ) : view === "list" ? (
          <>
            <h3 className="rf-title">اختر إيصالاً من الوردية</h3>
            {salesLoading ? (
              <p className="rf-muted">جاري التحميل…</p>
            ) : sales.length === 0 ? (
              <p className="rf-muted">لا توجد مبيعات في هذه الوردية</p>
            ) : (
              <>
                <SaleResultsList
                  sales={sales}
                  loading={salesLoading}
                  onSelect={loadLookup}
                  loadingLookup={loading}
                />
                {salesTotal > sales.length ? (
                  <p className="rf-muted">
                    آخر {sales.length} من {salesTotal} إيصالاً — للأقدم استخدم
                    رقم الإيصال.
                  </p>
                ) : null}
              </>
            )}
            <button
              type="button"
              className="rf-manual-link"
              onClick={() => {
                setView("search");
                setErr("");
                setSearchResults([]);
              }}
            >
              بحث في مبيعات سابقة
            </button>
            <button
              type="button"
              className="rf-manual-link"
              onClick={() => {
                setView("manual");
                setErr("");
              }}
            >
              بحث برقم الفاتورة
            </button>
          </>
        ) : view === "search" ? (
          <>
            <h3 className="rf-title">بحث في مبيعات سابقة</h3>
            <form className="rf-search-form" onSubmit={runPastSaleSearch}>
              <div className="rf-row">
                <label>
                  من تاريخ
                  <DateField
                    className="rf-input"
                    value={searchDateFrom}
                    onChange={(e) => setSearchDateFrom(e.target.value)}
                  />
                </label>
                <label>
                  إلى تاريخ
                  <DateField
                    className="rf-input"
                    value={searchDateTo}
                    onChange={(e) => setSearchDateTo(e.target.value)}
                  />
                </label>
              </div>
              <div className="rf-row">
                <label>
                  الحد الأدنى للمبلغ
                  <input
                    className="rf-input"
                    type="number"
                    min="0"
                    step="0.01"
                    value={searchMinAmount}
                    onChange={(e) => setSearchMinAmount(e.target.value)}
                  />
                </label>
                <label>
                  الحد الأقصى للمبلغ
                  <input
                    className="rf-input"
                    type="number"
                    min="0"
                    step="0.01"
                    value={searchMaxAmount}
                    onChange={(e) => setSearchMaxAmount(e.target.value)}
                  />
                </label>
              </div>
              <label className="rf-reason">
                رقم الإيصال أو الفاتورة
                <input
                  value={searchReceipt}
                  onChange={(e) => setSearchReceipt(e.target.value)}
                  placeholder="INV-2026-000001 أو رقم العملية"
                />
              </label>
              <label className="rf-reason">
                اسم الصنف أو الباركود
                <input
                  value={searchProduct}
                  onChange={(e) => setSearchProduct(e.target.value)}
                  placeholder="مثال: حليب أو 729000..."
                />
              </label>
              <button type="submit" className="rf-btn rf-btn--primary" disabled={searchLoading}>
                {searchLoading ? "جاري البحث…" : "بحث"}
              </button>
            </form>
            <SaleResultsList
              sales={searchResults}
              loading={searchLoading}
              onSelect={loadLookup}
              loadingLookup={loading}
            />
            <button type="button" className="rf-back-btn" onClick={backToList}>
              رجوع إلى قائمة الوردية
            </button>
          </>
        ) : view === "manual" ? (
          <>
            <h3 className="rf-title">بحث برقم الفاتورة</h3>
            <div className="rf-row">
              <input
                className="rf-input"
                type="text"
                placeholder="INV-… أو رقم العملية"
                value={tid}
                onChange={(e) => setTid(e.target.value)}
              />
              <button
                type="button"
                className="rf-btn"
                onClick={() => loadLookup(tid)}
                disabled={loading}
              >
                عرض
              </button>
            </div>
            <button type="button" className="rf-back-btn" onClick={backToList}>
              رجوع إلى قائمة الوردية
            </button>
            <button
              type="button"
              className="rf-manual-link"
              onClick={() => {
                setView("search");
                setErr("");
                setSearchResults([]);
              }}
            >
              بحث في مبيعات سابقة
            </button>
          </>
        ) : (
          <>
            <button type="button" className="rf-back-btn" onClick={backToList}>
              رجوع
            </button>
            <div className="rf-detail">
              <p className="rf-meta">
                {lookup.receipt_number || `فاتورة #${lookup.transaction_id}`} — وقت البيع{" "}
                {dateTime(lookup.created_at)}
                {lookup.business_day ? ` — يوم العمل ${lookup.business_day}` : ""} — الوردية الأصلية #
                {lookup.shift_id || "—"} — الكاشير {lookup.cashier_username || "—"} — الدفع الأصلي:{" "}
                {PM_AR[lookup.payment_method] || lookup.payment_method} — {ils(lookup.total)}
                {Number(lookup.discount) > 0 ? ` — خصم الفاتورة ${ils(lookup.discount)}` : ""}
              </p>
              <table className="rf-table">
                <thead>
                  <tr>
                    <th>الصنف</th>
                    <th>السعر</th>
                    <th>مباع</th>
                    <th>مرجّع</th>
                    <th>متاح</th>
                    <th>إرجاع</th>
                  </tr>
                </thead>
                <tbody>
                  {(lookup.lines || []).map((L) => {
                    const key = lineKey(L);
                    const pricedApart =
                      L.list_price != null && Number(L.list_price) !== Number(L.price);
                    return (
                    <tr key={key}>
                      <td>
                        {L.name}
                        {L.unit_name ? ` (${L.unit_name})` : ""}
                        {Number(L.line_discount) > 0 ? (
                          <div className="rf-muted">خصم السطر {ils(L.line_discount)}</div>
                        ) : null}
                      </td>
                      <td>
                        {ils(L.price)}
                        {pricedApart ? <div className="rf-muted">قبل الخصم {ils(L.list_price)}</div> : null}
                      </td>
                      <td>{L.quantity_sold}</td>
                      <td>{L.quantity_already_refunded}</td>
                      <td>{L.quantity_returnable}</td>
                      <td>
                        <QtyStepper
                          min={0}
                          max={L.quantity_returnable}
                          value={qtyByPid[key] ?? 0}
                          onChange={(e) =>
                            setQtyByPid((p) => ({
                              ...p,
                              [key]: Math.min(
                                L.quantity_returnable,
                                Math.max(0, Number(e.target.value) || 0)
                              ),
                            }))
                          }
                          disabled={L.quantity_returnable <= 0}
                        />
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="rf-row">
                {lookup.has_on_account ? (
                  <p className="rf-meta">رد على حساب العميل</p>
                ) : (
                  <label>
                    طريقة الرد
                    <select value={pm} onChange={(e) => setPm(e.target.value)}>
                      <option value="cash">نقد</option>
                      <option value="visa">بطاقة</option>
                    </select>
                  </label>
                )}
              </div>
              <p className="rf-quote">
                {quoteLoading
                  ? "جاري حساب مبلغ الاسترجاع…"
                  : quote
                    ? `المبلغ المسترد: ${ils(quote.total)} بطريقة ${PM_AR[pm] || pm}`
                    : "المبلغ المسترد: ₪0.00"}
              </p>
              {Array.isArray(lookup.returns) && lookup.returns.length > 0 ? (
                <div className="rf-history">
                  <p className="rf-meta">سجل الاسترجاع</p>
                  <ul>
                    {lookup.returns.map((row) => (
                      <li key={`${row.kind}-${row.id}`}>
                        {row.kind === "pending" ? `طلب #${row.id} قيد المراجعة` : `استرجاع #${row.id}`}
                        {" — "}
                        {(row.lines || []).map((line) => `${line.name} ×${line.quantity}`).join("، ")}
                        {" — "}
                        {ils(row.amount)} — {PM_AR[row.refund_method] || row.refund_method}
                        {" — "}
                        {dateTime(row.created_at)} — {row.cashier_username || "—"} — وردية #
                        {row.shift_id || "—"}
                        {row.business_day ? ` — يوم العمل ${dateOnly(row.business_day)}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <label className="rf-reason">
                السبب (اختياري)
                <input value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <button
                type="button"
                className="rf-btn rf-btn--primary"
                onClick={submitRefund}
                disabled={loading}
              >
                {loading ? "جاري الإرسال…" : "إرسال طلب الاسترجاع"}
              </button>
            </div>
          </>
        )}
        {err ? <div className="rf-err">{err}</div> : null}
      </div>

      <PosRefundWaitingModal
        open={!!waitingRequestId}
        requestId={waitingRequestId}
        onClose={closeWaiting}
        onTerminal={onWaitingTerminal}
      />
    </>
  );
}
