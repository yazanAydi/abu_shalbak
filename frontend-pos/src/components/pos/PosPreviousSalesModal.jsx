import { useCallback, useEffect, useRef, useState } from "react";
import api from "../../apiClient";
import { getAuthHeaders } from "../../utils/auth";
import { dateTime, ils, qty, ymdToDmy } from "../../utils/format";
import { printReceipt } from "../../utils/printReceipt";
import "../ShiftModal.css";

const PAYMENT_LABELS = {
  cash: "نقدي",
  visa: "فيزا",
  on_account: "ذمة",
  mixed: "مختلط",
  check: "شيك",
};

function payLabel(code) {
  if (!code) return "—";
  return PAYMENT_LABELS[code] || code;
}

function errorText(err, fallback) {
  const body = err?.response?.data;
  if (body && typeof body === "object" && body.error) return String(body.error);
  return fallback;
}

function SaleDetail({ detail, onBack }) {
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState("");
  const printingRef = useRef(false);

  async function reprint() {
    if (printingRef.current) return;
    printingRef.current = true;
    setPrinting(true);
    setPrintError("");
    try {
      const result = await printReceipt(
        { transaction_id: detail.transaction_id },
        { alert: false, reprint: true }
      );
      if (!result?.ok && !result?.skipped) {
        setPrintError(result?.error || "تعذّرت طباعة الإيصال. أعد المحاولة.");
      }
    } finally {
      printingRef.current = false;
      setPrinting(false);
    }
  }
  const showDiscount = Number(detail.discount) > 0 || (detail.lines || []).some((line) => Number(line.discount) > 0);
  const showRounding = Number(detail.rounding_adjustment) !== 0;
  const showBeforeRounding =
    showRounding && detail.amount_before_rounding != null;
  const showTax = Number(detail.tax) !== 0;
  return (
    <div>
      <h2 className="shift-modal-title">فاتورة {detail.receipt_number || `#${detail.transaction_id}`}</h2>
      <p className="shift-modal-meta">
        {dateTime(detail.created_at)}
        {detail.business_day ? ` — اليوم التجاري ${ymdToDmy(detail.business_day)}` : ""}
      </p>
      <p className="pos-history-state" data-sale-state={detail.sale_state}>
        الحالة: {detail.sale_state_label}
      </p>
      {detail.customer_name ? <p className="shift-modal-meta">العميل: {detail.customer_name}</p> : null}
      {detail.notes ? <p className="shift-modal-meta">ملاحظة: {detail.notes}</p> : null}
      <table className="pos-suspended-detail-table">
        <thead>
          <tr>
            <th>الصنف</th>
            <th>الوحدة</th>
            <th>الكمية</th>
            <th>سعر الوحدة</th>
            {showDiscount ? <th>الخصم</th> : null}
            <th>الإجمالي</th>
          </tr>
        </thead>
        <tbody>
          {(detail.lines || []).map((line) => (
            <tr key={line.id}>
              <td>{line.name}</td>
              <td>{line.unit_name || "—"}</td>
              <td>{qty(line.quantity)}</td>
              <td>{ils(line.unit_price)}</td>
              {showDiscount ? <td>{Number(line.discount) ? ils(line.discount) : "—"}</td> : null}
              <td>{ils(line.line_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pos-history-totals">
        <div>المجموع: {ils(detail.subtotal)}</div>
        {showDiscount ? <div>الخصم: {ils(detail.discount)}</div> : null}
        {showTax ? <div>الضريبة: {ils(detail.tax)}</div> : null}
        {showBeforeRounding ? (
          <div>قبل التقريب: {ils(detail.amount_before_rounding)}</div>
        ) : null}
        {showRounding ? <div>التقريب: {ils(detail.rounding_adjustment)}</div> : null}
        <div>
          <strong>الإجمالي: {ils(detail.total)}</strong>
        </div>
        {Number(detail.change_amount) > 0 ? <div>الباقي: {ils(detail.change_amount)}</div> : null}
      </div>
      <h3 className="pos-history-subtitle">الدفع</h3>
      <ul className="pos-history-payments">
        {(detail.payments || []).length ? (
          detail.payments.map((pay, index) => (
            <li key={`${pay.method}-${index}`}>
              {payLabel(pay.method)}: {ils(pay.amount)}
              {pay.currency_code && pay.currency_code !== "NIS" && Number(pay.original_amount) !== Number(pay.amount)
                ? ` (${pay.original_amount} ${pay.currency_code})`
                : ""}
            </li>
          ))
        ) : (
          <li>{payLabel(detail.payment_method)}: {ils(detail.total)}</li>
        )}
      </ul>
      {(detail.returns || []).length ? (
        <>
          <h3 className="pos-history-subtitle">المرتجعات</h3>
          <ul className="pos-history-returns">
            {detail.returns.map((row) => (
              <li key={`${row.kind}-${row.id}`}>
                {row.status === "pending" ? "طلب استرجاع قيد المراجعة" : "مرتجع"} #{row.id} — {ils(row.total)} —{" "}
                {payLabel(row.payment_method)} — {dateTime(row.created_at)}
                {(row.lines || []).length ? (
                  <span>
                    {" "}
                    (
                    {row.lines
                      .map((line) => `${line.name || "صنف"} ×${qty(line.quantity)}`)
                      .join("، ")}
                    )
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="shift-modal-meta">عرض فقط. لا يمكن تعديل الفاتورة أو حذفها أو إعادة ترحيلها من هنا.</p>
      {printError ? (
        <div className="shift-modal-err">
          <p>{printError}</p>
          <button type="button" className="shift-modal-secondary" onClick={reprint} disabled={printing}>
            إعادة المحاولة
          </button>
        </div>
      ) : null}
      <div className="shift-modal-actions">
        <button type="button" className="shift-modal-primary" onClick={reprint} disabled={printing}>
          {printing ? "جاري الطباعة…" : "إعادة طباعة"}
        </button>
        <button type="button" className="shift-modal-secondary" onClick={onBack} disabled={printing}>
          رجوع
        </button>
      </div>
    </div>
  );
}

export default function PosPreviousSalesModal({ open, onClose }) {
  const [qInput, setQInput] = useState("");
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const [filters, setFilters] = useState({ q: "", from: "", to: "" });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  const loadPage = useCallback(async (nextPage, nextFilters) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      params.set("page", String(nextPage));
      params.set("limit", "20");
      if (nextFilters.q) params.set("q", nextFilters.q);
      if (nextFilters.from) params.set("from", nextFilters.from);
      if (nextFilters.to) params.set("to", nextFilters.to);
      const { data } = await api.get(`/api/pos/my-sales?${params.toString()}`, {
        headers: getAuthHeaders(),
      });
      setResult(data);
    } catch (err) {
      setResult(null);
      setError(errorText(err, "تعذّر تحميل الفواتير"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    setDetail(null);
    setDetailError("");
    setPage(1);
    const initial = { q: "", from: "", to: "" };
    setQInput("");
    setFromInput("");
    setToInput("");
    setFilters(initial);
    let cancelled = false;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ page: "1", limit: "20" });
    api
      .get(`/api/pos/my-sales?${params.toString()}`, { headers: getAuthHeaders() })
      .then(({ data }) => {
        if (!cancelled) setResult(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setResult(null);
          setError(errorText(err, "تعذّر تحميل الفواتير"));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function openDetail(id) {
    setDetailLoading(true);
    setDetailError("");
    try {
      const { data } = await api.get(`/api/pos/my-sales/${id}`, { headers: getAuthHeaders() });
      setDetail(data);
    } catch (err) {
      setDetailError(errorText(err, "تعذّر تحميل تفاصيل الفاتورة"));
    } finally {
      setDetailLoading(false);
    }
  }

  function applyFilters(event) {
    event.preventDefault();
    const next = {
      q: qInput.trim(),
      from: fromInput,
      to: toInput,
    };
    setFilters(next);
    setPage(1);
    setDetail(null);
    loadPage(1, next);
  }

  function goToPage(nextPage) {
    setPage(nextPage);
    setDetail(null);
    loadPage(nextPage, filters);
  }

  if (!open) return null;
  const sales = result?.sales || [];
  const pageCount = Number(result?.page_count) || 0;

  return (
    <div className="shift-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="pos-history-title" dir="rtl" lang="ar">
      <div className="shift-modal-backdrop" onClick={onClose} aria-hidden />
      <div className="shift-modal-panel pos-modal-panel--history">
        <h2 id="pos-history-title" className="shift-modal-title">
          الفواتير السابقة
        </h2>
        {detail ? (
          <SaleDetail
            detail={detail}
            onBack={() => {
              setDetail(null);
              setDetailError("");
            }}
          />
        ) : (
          <>
            <p className="shift-modal-meta">فواتير البيع المكتملة لهذا الكاشير، بما فيها الورديات السابقة. العرض فقط.</p>
            <form className="pos-history-filters" onSubmit={applyFilters}>
              <label className="shift-modal-label">
                رقم الفاتورة
                <input
                  className="shift-modal-input"
                  value={qInput}
                  onChange={(e) => setQInput(e.target.value)}
                  placeholder="ابحث برقم الفاتورة"
                  aria-label="بحث برقم الفاتورة"
                />
              </label>
              <div className="pos-history-dates">
                <label className="shift-modal-label">
                  اليوم التجاري من
                  <input
                    className="shift-modal-input"
                    type="date"
                    value={fromInput}
                    onChange={(e) => setFromInput(e.target.value)}
                    aria-label="اليوم التجاري من"
                  />
                </label>
                <label className="shift-modal-label">
                  إلى
                  <input
                    className="shift-modal-input"
                    type="date"
                    value={toInput}
                    onChange={(e) => setToInput(e.target.value)}
                    aria-label="اليوم التجاري إلى"
                  />
                </label>
              </div>
              <button type="submit" className="shift-modal-primary">
                بحث
              </button>
            </form>
            {loading || (!result && !error) ? <p className="shift-modal-meta">جاري تحميل الفواتير…</p> : null}
            {error ? (
              <div className="shift-modal-err">
                <p>{error}</p>
                <button type="button" className="shift-modal-secondary" onClick={() => loadPage(page, filters)}>
                  إعادة المحاولة
                </button>
              </div>
            ) : null}
            {detailError ? <p className="shift-modal-err">{detailError}</p> : null}
            {detailLoading ? <p className="shift-modal-meta">جاري تحميل التفاصيل…</p> : null}
            {!loading && !error && result && sales.length === 0 ? (
              <p className="shift-modal-meta">لا توجد فواتير سابقة</p>
            ) : null}
            {sales.length > 0 ? (
              <table className="pos-suspended-detail-table">
                <thead>
                  <tr>
                    <th>رقم الفاتورة</th>
                    <th>التاريخ والوقت</th>
                    <th>الإجمالي</th>
                    <th>طريقة الدفع</th>
                    <th>الحالة</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sales.map((sale) => (
                    <tr key={sale.transaction_id}>
                      <td>{sale.receipt_number || `#${sale.transaction_id}`}</td>
                      <td>{dateTime(sale.created_at)}</td>
                      <td>{ils(sale.total)}</td>
                      <td>{payLabel(sale.payment_method)}</td>
                      <td>{sale.sale_state_label}</td>
                      <td>
                        <button type="button" className="shift-modal-secondary" onClick={() => openDetail(sale.transaction_id)}>
                          عرض التفاصيل
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {pageCount > 1 ? (
              <div className="pos-history-pager">
                <button type="button" className="shift-modal-secondary" disabled={page <= 1 || loading} onClick={() => goToPage(page - 1)}>
                  السابق
                </button>
                <span>
                  صفحة {page} من {pageCount}
                </span>
                <button
                  type="button"
                  className="shift-modal-secondary"
                  disabled={page >= pageCount || loading}
                  onClick={() => goToPage(page + 1)}
                >
                  التالي
                </button>
              </div>
            ) : null}
          </>
        )}
        <div className="shift-modal-actions">
          <button type="button" className="shift-modal-secondary" onClick={onClose}>
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
}
