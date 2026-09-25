import { apiErrorMessage } from "../utils/apiError";
import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils, dateOnly, dateTime, dateTimeSeconds } from "../utils/format";
import { SHIFT_VARIANCE_WARNING } from "../components/ShiftEnd";
import {
  PageHeader,
  Card,
  CardBody,
  DataTable,
  Modal,
  FormField,
  FormGrid,
  Input,
  Select,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
  SearchInput,
  ReportToolbar,
  useToast,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";
import { printReceipt } from "../utils/printReceipt";
import { printSummaryReport } from "../utils/printReport";
import { loadStoreSettings } from "../utils/loadStoreSettings";
import { buildShiftCountSummaryModel, visaAmountText } from "../utils/shiftVisa";
import CashCountFields, {
  buildCountCurrencyRows,
  countedCurrenciesPayload,
  countedNisTotal,
  expectedBreakdownText,
} from "../components/CashCountFields";
import CountSupplierPaymentSection from "../components/CountSupplierPaymentSection";
import CountAdvanceSection from "../components/CountAdvanceSection";
import CountPendingDecisions from "../components/CountPendingDecisions";
import ShiftCountTotals from "../components/ShiftCountTotals";
import { mapShiftDetailToCountTarget } from "../utils/shiftCountSupplierPayment";

const PM = { cash: "نقد", visa: "بطاقة", on_account: "ذمة", mixed: "مختلط" };

function savedAdjustmentText(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return null;
  return ils(n);
}

function ExpectedCashCell({ row }) {
  const breakdown = expectedBreakdownText(row.expected_by_currency);
  return (
    <span>
      {row.expected_cash != null ? ils(row.expected_cash) : "—"}
      {breakdown ? (
        <span style={{ display: "block", fontSize: "0.8em", color: "var(--office-text-muted)" }}>{breakdown}</span>
      ) : null}
    </span>
  );
}

function parseItems(itemsJson) {
  try {
    const arr = JSON.parse(itemsJson);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function ReceiptLineItems({ itemsJson }) {
  const items = parseItems(itemsJson);
  if (items.length === 0) {
    return (
      <p className="ui-text-muted" style={{ margin: "0.35rem 0" }}>لا توجد أصناف</p>
    );
  }
  return (
    <ul className="dashboard-stock-list ui-mt-sm">
      {items.map((it, idx) => {
        const qty = Number(it.quantity) || 0;
        const price = Number(it.price) || 0;
        const name = String(it.name || "").trim() || `صنف ${it.product_id || idx + 1}`;
        return (
          <li key={idx}>
            <span>
              {name} — {qty} × {ils(price)}
            </span>
            <span className="num">{ils(qty * price)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function ReceiptTotals({ record, showReceiptNumber = true }) {
  return (
    <div style={{ fontSize: "0.9rem", lineHeight: 1.65, marginBottom: "0.5rem" }}>
      {showReceiptNumber && record.receipt_number ? (
        <div>رقم الإيصال: {record.receipt_number}</div>
      ) : null}
      <div>
        المجموع الفرعي: <span className="num">{ils(record.subtotal ?? 0)}</span>
      </div>
      {Number(record.discount) > 0 ? (
        <div>
          الخصم: <span className="num">{ils(record.discount)}</span>
        </div>
      ) : null}
      <div>
        الضريبة: <span className="num">{ils(record.tax ?? 0)}</span>
      </div>
      {savedAdjustmentText(record.rounding_adjustment) ? (
        <div>
          تقريب: <span className="num">{savedAdjustmentText(record.rounding_adjustment)}</span>
        </div>
      ) : null}
      <div>
        <strong>
          الإجمالي: <span className="num">{ils(record.total ?? 0)}</span>
        </strong>
      </div>
      <div>الدفع: {PM[record.payment_method] || record.payment_method}</div>
      {record.notes ? (
        <div style={{ whiteSpace: "pre-wrap", marginTop: "0.25rem" }}>
          ملاحظات: {record.notes}
        </div>
      ) : null}
    </div>
  );
}

function movementLabel(t) {
  const ar = {
    opening: "افتتاح",
    payment: "بيع نقدي",
    refund: "استرجاع",
    adjustment: "تسوية",
    closing: "إغلاق",
    advance: "سلف",
    supplier_payment: "دفع لمورد",
    customer_collection: "قبض ذمم سابق — للمراجعة",
    customer_cash_debt: "ذمم نقدية للعملاء",
  };
  return ar[t] || t;
}

function shiftStatusBadge(status) {
  if (status === "open") {
    return <StatusBadge tone="green">مفتوحة</StatusBadge>;
  }
  if (status === "pending_count") {
    return <StatusBadge tone="orange">بانتظار العد</StatusBadge>;
  }
  return <StatusBadge tone="neutral">مغلقة</StatusBadge>;
}

function formatDt(v) {
  return dateTime(v);
}

function formatCashTime(v) {
  return dateTimeSeconds(v);
}

function matchesReceiptSearch(query, { receiptNumber, saleId, refundId, description }) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const digits = q.replace(/^#/, "");
  return [
    receiptNumber,
    saleId != null ? String(saleId) : "",
    saleId != null ? `#${saleId}` : "",
    refundId != null ? String(refundId) : "",
    refundId != null ? `#${refundId}` : "",
    description,
  ].some((v) => String(v || "").toLowerCase().includes(q) || String(v || "").includes(digits));
}

function buildShiftLookups(detail) {
  const txById = new Map();
  for (const t of detail?.transactions || []) {
    txById.set(t.id, t);
  }
  const refundById = new Map();
  for (const r of detail?.refunds || []) {
    const orig = r.original_transaction_id ? txById.get(r.original_transaction_id) : null;
    refundById.set(r.id, {
      ...r,
      original_receipt_number: orig?.receipt_number ?? null,
    });
  }
  return { txById, refundById };
}

function getMovementRefs(m, txById, refundById) {
  const saleId = m.transaction_id ?? null;
  const refundId = m.refund_id ?? null;
  let receiptNumber = null;
  if (saleId != null) {
    receiptNumber = txById.get(saleId)?.receipt_number ?? null;
  } else if (refundId != null) {
    receiptNumber = refundById.get(refundId)?.original_receipt_number ?? null;
  }
  return { receiptNumber, saleId, refundId };
}

function movementTone(type) {
  if (type === "payment" || type === "customer_collection") return "green";
  if (type === "refund" || type === "supplier_payment" || type === "advance") return "red";
  if (type === "adjustment") return "orange";
  return "neutral";
}

function SectionTitle({ title, filtered, total, searchActive }) {
  return (
    <h3 className="dashboard-subtitle dashboard-section-title--with-badge">
      {title}
      {searchActive ? (
        <span className="shift-section-count">
          {filtered} / {total}
        </span>
      ) : null}
    </h3>
  );
}

function shiftCountSource(shift, summary) {
  const visa = summary?.visa || shift || {};
  return {
    ...shift,
    ...visa,
    cash_sales: summary?.cash_sales ?? shift?.cash_sales,
    cash_only_sales: summary?.cash_only_sales ?? shift?.cash_only_sales,
    mixed_cash_sales: summary?.mixed_cash_sales ?? shift?.mixed_cash_sales,
    cash_refunds: summary?.cash_refunds ?? shift?.cash_refunds,
    cash_net: summary?.cash_net ?? shift?.cash_net,
    tender_total: summary?.tender_total ?? shift?.tender_total,
    cash_sales_incomplete: summary?.cash_sales_incomplete ?? shift?.cash_sales_incomplete,
    cash_sales_label: summary?.cash_sales_label || shift?.cash_sales_label,
    mixed_cash_label: summary?.mixed_cash_label || shift?.mixed_cash_label,
    mixed_cash_included_note: summary?.mixed_cash_included_note || shift?.mixed_cash_included_note,
    visa_amount_label: summary?.visa_amount_label || shift?.visa_amount_label,
    tender_total_label: summary?.tender_total_label || shift?.tender_total_label,
    cash_refunds_label: summary?.cash_refunds_label || shift?.cash_refunds_label,
    cash_net_label: summary?.cash_net_label || shift?.cash_net_label,
    cash_sales_incomplete_note:
      summary?.cash_sales_incomplete_note || shift?.cash_sales_incomplete_note,
    expected_cash: summary?.expected ?? shift?.expected_cash,
    expected_cash_label: summary?.expected_cash_label || shift?.expected_cash_label,
    expected_by_currency: shift?.expected_by_currency || summary?.expected_by_currency,
  };
}

function ShiftDetailSummary({ shift, summary, varianceWarn }) {
  if (!shift) return null;
  const status = shift.status;
  return (
    <div className="shift-detail-summary">
      <div className="shift-detail-chip">
        <span className="shift-detail-chip-k">الكاشير</span>
        <span className="shift-detail-chip-v">{shift.cashier_name || "—"}</span>
      </div>
      <div className="shift-detail-chip">
        <span className="shift-detail-chip-k">افتتاح</span>
        <span className="shift-detail-chip-v num">{ils(shift.opening_cash ?? 0)}</span>
      </div>
      <div className="shift-detail-chip">
        <span className="shift-detail-chip-k">الحالة</span>
        <span className="shift-detail-chip-v">{shiftStatusBadge(status)}</span>
      </div>
      {status === "closed" ? (
        <>
          <div className="shift-detail-chip">
            <span className="shift-detail-chip-k">إغلاق</span>
            <span className="shift-detail-chip-v num">{ils(shift.closing_cash ?? 0)}</span>
          </div>
          <div className="shift-detail-chip">
            <span className="shift-detail-chip-k">الفرق</span>
            <span className={`shift-detail-chip-v num ${varianceWarn(shift.variance) ? "negative" : ""}`}>
              {shift.variance != null ? `${shift.variance >= 0 ? "+" : ""}${ils(shift.variance)}` : "—"}
            </span>
          </div>
        </>
      ) : null}
      <div className="shift-detail-summary-totals">
        <ShiftCountTotals source={shiftCountSource(shift, summary)} />
      </div>
      <div className="shift-detail-chip">
        <span className="shift-detail-chip-k">دفعات الموردين</span>
        <span className="shift-detail-chip-v num">{ils(summary?.supplier_payments_total ?? 0)}</span>
      </div>
      <div className="shift-detail-chip">
        <span className="shift-detail-chip-k">ذمم نقدية للعملاء</span>
        <span className="shift-detail-chip-v num">{ils(summary?.customer_cash_debts_total ?? 0)}</span>
      </div>
      <div className="shift-detail-chip">
        <span className="shift-detail-chip-k">سلف</span>
        <span className="shift-detail-chip-v num">{ils(summary?.advances_total ?? 0)}</span>
      </div>
    </div>
  );
}

function CashMovementRow({ movement, txById, refundById }) {
  const { receiptNumber, saleId, refundId } = getMovementRefs(movement, txById, refundById);
  const amount = Number(movement.amount) || 0;
  const amtClass = amount >= 0 ? "shift-cash-amt--in" : "shift-cash-amt--out";

  return (
    <li className="shift-cash-row">
      <span className="shift-cash-time">{formatCashTime(movement.created_at)}</span>
      <span className="shift-cash-type">
        <StatusBadge tone={movementTone(movement.movement_type)} noDot>
          {movementLabel(movement.movement_type)}
        </StatusBadge>
      </span>
      <span className="shift-cash-refs">
        {saleId != null ? <span className="shift-ref-chip">#{saleId}</span> : null}
        {refundId != null ? <span className="shift-ref-chip">#{refundId}</span> : null}
        {receiptNumber ? <span className="shift-ref-chip shift-ref-chip--receipt">{receiptNumber}</span> : null}
        {movement.voucher_id != null ? <span className="shift-ref-chip">سند #{movement.voucher_id}</span> : null}
        {movement.description && !saleId && !refundId ? (
          <span className="shift-cash-desc">{movement.description}</span>
        ) : null}
      </span>
      <span className={`shift-cash-amt num ${amtClass}`}>
        {amount >= 0 ? "+" : ""}
        {ils(amount)}
      </span>
    </li>
  );
}

export default function ShiftAudit() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [pendingRows, setPendingRows] = useState([]);
  const [closedPending, setClosedPending] = useState([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [cashierId, setCashierId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reconcileTarget, setReconcileTarget] = useState(null);
  const [countedAmounts, setCountedAmounts] = useState({});
  const [countCurrencies, setCountCurrencies] = useState([]);
  const [reconcileNotes, setReconcileNotes] = useState("");
  const [reconcileLoading, setReconcileLoading] = useState(false);
  const [supplierSaving, setSupplierSaving] = useState(false);
  const [advanceSaving, setAdvanceSaving] = useState(false);
  const [expandedSaleId, setExpandedSaleId] = useState(null);
  const [expandedRefundId, setExpandedRefundId] = useState(null);
  const [printingSaleId, setPrintingSaleId] = useState(null);
  const [printingRefundId, setPrintingRefundId] = useState(null);
  const [receiptSearch, setReceiptSearch] = useState("");

  const loadPending = useCallback(async () => {
    setPendingLoading(true);
    try {
      const { data } = await api.get("/api/shifts/pending", { headers: getAuthHeaders() });
      setPendingRows(Array.isArray(data) ? data : []);
      const closed = await api.get("/api/shifts/closed-pending-requests", { headers: getAuthHeaders() });
      const closedRows = closed.data?.requests ?? closed.data;
      setClosedPending(Array.isArray(closedRows) ? closedRows : []);
    } catch (e) {
      toast.error(apiErrorMessage(e, "تعذّر تحميل الورديات المعلقة"));
      setPendingRows([]);
    } finally {
      setPendingLoading(false);
    }
  }, [toast]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (["open", "pending_count", "closed"].includes(status)) params.set("status", status);
      if (String(cashierId).trim() !== "") params.set("cashier_id", String(cashierId).trim());
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);
      const q = params.toString();
      const { data } = await api.get(`/api/shifts${q ? `?${q}` : ""}`, {
        headers: getAuthHeaders(),
      });
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(apiErrorMessage(e, "تعذّر التحميل"));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [status, cashierId, dateFrom, dateTo, toast]);

  useEffect(() => {
    loadPending();
    load();
  }, [loadPending, load]);

  useEffect(() => {
    if (!reconcileTarget) {
      setCountCurrencies([]);
      return undefined;
    }
    let cancelled = false;
    api
      .get("/api/currencies", { headers: getAuthHeaders() })
      .then(({ data }) => {
        if (!cancelled) setCountCurrencies(Array.isArray(data?.currencies) ? data.currencies : []);
      })
      .catch(() => {
        if (!cancelled) setCountCurrencies([]);
      });
    return () => {
      cancelled = true;
    };
  }, [reconcileTarget]);

  const countRows = useMemo(
    () => buildCountCurrencyRows(countCurrencies, reconcileTarget?.expected_by_currency),
    [countCurrencies, reconcileTarget]
  );

  async function openDetail(id) {
    setDetail(null);
    setExpandedSaleId(null);
    setExpandedRefundId(null);
    setReceiptSearch("");
    setDetailLoading(true);
    try {
      const { data } = await api.get(`/api/shifts/${id}`, { headers: getAuthHeaders() });
      setDetail(data);
    } catch (e) {
      toast.error(apiErrorMessage(e, "تعذّر فتح التفاصيل"));
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    setDetail(null);
    setExpandedSaleId(null);
    setExpandedRefundId(null);
    setReceiptSearch("");
  }

  function toggleSale(id) {
    setExpandedSaleId((prev) => (prev === id ? null : id));
  }

  function toggleRefund(id) {
    setExpandedRefundId((prev) => (prev === id ? null : id));
  }

  async function printSaleReceipt(transactionId) {
    setPrintingSaleId(transactionId);
    try {
      const { data } = await api.get(`/api/shifts/transactions/${transactionId}/receipt`, {
        headers: getAuthHeaders(),
      });
      if (data?.receipt_text) {
        printReceipt(data);
      } else {
        toast.error("لم يُرجَع نص الإيصال");
      }
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل طباعة الإيصال"));
    } finally {
      setPrintingSaleId(null);
    }
  }

  async function printRefundReceipt(refundId) {
    setPrintingRefundId(refundId);
    try {
      const res = await api.get(`/api/refunds/${refundId}/receipt`, {
        headers: getAuthHeaders(),
        responseType: "blob",
      });
      const url = URL.createObjectURL(res.data);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل طباعة إيصال الاسترجاع"));
    } finally {
      setPrintingRefundId(null);
    }
  }

  function applyCountTarget(data) {
    setReconcileTarget(mapShiftDetailToCountTarget(data));
  }

  async function refreshReconcileTarget(shiftId) {
    const { data } = await api.get(`/api/shifts/${shiftId}`, { headers: getAuthHeaders() });
    setReconcileTarget((prev) => {
      if (!prev || Number(prev.id) !== Number(shiftId)) return prev;
      return mapShiftDetailToCountTarget(data);
    });
    if (detail?.shift?.id === shiftId) {
      setDetail(data);
    }
    return data;
  }

  function openReconcile(row) {
    setSupplierSaving(false);
    setAdvanceSaving(false);
    setReconcileTarget({
      ...row,
      expected_cash: row.expected_cash ?? detail?.summary?.expected ?? row.expected_cash,
      expected_by_currency:
        row.expected_by_currency || detail?.summary?.expected_by_currency || [],
      supplier_payments: row.supplier_payments || detail?.supplier_payments || [],
      supplier_payments_total:
        row.supplier_payments_total ?? detail?.summary?.supplier_payments_total ?? 0,
      supplier_payment_requests:
        row.supplier_payment_requests || detail?.supplier_payment_requests || [],
      advances: row.advances || detail?.advances || [],
      advances_total: row.advances_total ?? detail?.summary?.advances_total ?? 0,
      cash_sales: row.cash_sales ?? detail?.summary?.cash_sales ?? 0,
      cash_only_sales: row.cash_only_sales ?? detail?.summary?.cash_only_sales ?? 0,
      mixed_cash_sales: row.mixed_cash_sales ?? detail?.summary?.mixed_cash_sales ?? 0,
      cash_refunds: row.cash_refunds ?? detail?.summary?.cash_refunds ?? 0,
      cash_net: row.cash_net ?? detail?.summary?.cash_net,
      tender_total: row.tender_total ?? detail?.summary?.tender_total,
      cash_sales_incomplete:
        row.cash_sales_incomplete ?? detail?.summary?.cash_sales_incomplete ?? false,
      cash_sales_label: row.cash_sales_label || detail?.summary?.cash_sales_label,
      mixed_cash_label: row.mixed_cash_label || detail?.summary?.mixed_cash_label,
      mixed_cash_included_note:
        row.mixed_cash_included_note || detail?.summary?.mixed_cash_included_note,
      visa_amount_label: row.visa_amount_label || detail?.summary?.visa_amount_label,
      tender_total_label: row.tender_total_label || detail?.summary?.tender_total_label,
      cash_refunds_label: row.cash_refunds_label || detail?.summary?.cash_refunds_label,
      cash_net_label: row.cash_net_label || detail?.summary?.cash_net_label,
      expected_cash_label: row.expected_cash_label || detail?.summary?.expected_cash_label,
    });
    setCountedAmounts({});
    setReconcileNotes("");
    api
      .get(`/api/shifts/${row.id}`, { headers: getAuthHeaders() })
      .then(({ data }) => {
        applyCountTarget(data);
        if (detail?.shift?.id === row.id) setDetail(data);
      })
      .catch((e) => {
        toast.error(apiErrorMessage(e, "تعذّر تحديث النقد المتوقع"));
      });
  }

  function closeReconcile() {
    setReconcileTarget(null);
    setCountedAmounts({});
    setReconcileNotes("");
    setSupplierSaving(false);
    setAdvanceSaving(false);
  }

  async function submitReconcile(e) {
    e.preventDefault();
    if (!reconcileTarget?.id) return;
    const payload = countedCurrenciesPayload(countRows, countedAmounts);
    setReconcileLoading(true);
    const shiftId = reconcileTarget.id;
    try {
      const { data } = await api.post(
        `/api/shifts/${shiftId}/reconcile`,
        { counted_currencies: payload, notes: reconcileNotes.trim() || null },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      if (data.requires_approval) {
        toast.info(data.warning || "تم الإغلاق — الفارق يتجاوز الحد");
      } else {
        toast.success("تم عد النقد وإغلاق الوردية");
      }
      closeReconcile();
      loadPending();
      load();
      if (detail?.shift?.id === shiftId) {
        openDetail(shiftId);
      }
    } catch (e2) {
      toast.error(e2.response?.data?.error || e2.message || "فشل التسوية");
    } finally {
      setReconcileLoading(false);
    }
  }

  async function printShiftReport() {
    if (!detail?.shift) return;
    const model = buildShiftCountSummaryModel(shiftCountSource(detail.shift, detail.summary));
    const store = await loadStoreSettings();
    printSummaryReport({
      title: `تقرير وردية #${detail.shift.id}`,
      subtitle: detail.shift.cashier_name || "",
      meta: model.meta,
      sections: [
        {
          heading: "ملخص الصندوق",
          items: [
            { label: model.cashSales.label, value: model.cashSales.value },
            ...(model.mixedIncluded
              ? [
                  { label: model.mixedIncluded.label, value: model.mixedIncluded.value },
                  { label: model.mixedIncludedNote, value: "" },
                ]
              : []),
            { label: model.visa.label, value: model.visa.value },
            { label: model.tenderTotal.label, value: model.tenderTotal.value },
            { label: model.cashRefunds.label, value: model.cashRefunds.value },
            { label: model.visaRefunds?.label, value: model.visaRefunds?.value },
            { label: model.cashNet.label, value: model.cashNet.value },
            { label: model.visaNet?.label, value: model.visaNet?.value },
            { label: model.expected.label, value: model.expected.value },
            {
              label: "دفعات الموردين",
              value: ils(detail.summary?.supplier_payments_total ?? 0),
            },
            {
              label: "ذمم نقدية للعملاء",
              value: ils(detail.summary?.customer_cash_debts_total ?? 0),
            },
            ...(Number(detail.summary?.customer_collections_total) > 0
              ? [
                  {
                    label: "قبض ذمم سابق — للمراجعة",
                    value: ils(detail.summary.customer_collections_total),
                  },
                ]
              : []),
            {
              label: "سلف",
              value: ils(detail.summary?.advances_total ?? 0),
            },
          ],
        },
        {
          heading: "ذمم نقدية للعملاء",
          items: (detail.customer_cash_debts || []).map((p) => ({
            label: `${p.customer_name || "عميل"} — ${p.cashier_name || ""}`,
            value: ils(p.amount),
          })),
        },
        ...((detail.customer_collections || []).length
          ? [
              {
                heading: "قبض ذمم سابق — للمراجعة",
                items: (detail.customer_collections || []).map((p) => ({
                  label: `${p.customer_name || "عميل"} — سند قبض #${p.voucher_no ?? "—"} — ${p.cashier_name || ""}`,
                  value: ils(p.amount),
                })),
              },
            ]
          : []),
        {
          heading: "دفعات الموردين",
          items: (detail.supplier_payments || []).map((p) => ({
            label: `${p.supplier_name || "مورد"} — سند #${p.voucher_no ?? "—"} — ${p.cashier_name || ""}`,
            value: ils(p.amount),
          })),
        },
        {
          heading: "سلف",
          items: (detail.advances || []).map((p) => ({
            label: `${p.employee_name || "موظف"} — طلب #${p.request_id ?? "—"} — ${p.recorded_by_name || ""}`,
            value: ils(p.amount),
          })),
        },
      ],
      store,
    });
  }

  async function downloadCsv(shiftId) {
    try {
      const res = await api.get(`/api/shifts/${shiftId}/export.csv`, {
        headers: getAuthHeaders(),
        responseType: "blob",
      });
      const blob = new Blob([res.data], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `shift-${shiftId}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل التصدير"));
    }
  }

  const varianceWarn = (v) =>
    v != null && !Number.isNaN(Number(v)) && Math.abs(Number(v)) > SHIFT_VARIANCE_WARNING;

  const shiftLookups = useMemo(() => buildShiftLookups(detail), [detail]);

  const filteredCashMovements = useMemo(() => {
    if (!detail) return [];
    const { txById, refundById } = shiftLookups;
    return (detail.cash_movements || []).filter((m) =>
      matchesReceiptSearch(receiptSearch, {
        ...getMovementRefs(m, txById, refundById),
        description: m.description,
      })
    );
  }, [detail, receiptSearch, shiftLookups]);

  const filteredTransactions = useMemo(() => {
    if (!detail) return [];
    return (detail.transactions || []).filter((t) =>
      matchesReceiptSearch(receiptSearch, {
        receiptNumber: t.receipt_number,
        saleId: t.id,
        refundId: null,
        description: null,
      })
    );
  }, [detail, receiptSearch]);

  const filteredRefunds = useMemo(() => {
    if (!detail) return [];
    const { txById } = shiftLookups;
    return (detail.refunds || []).filter((r) => {
      const orig = r.original_transaction_id ? txById.get(r.original_transaction_id) : null;
      return matchesReceiptSearch(receiptSearch, {
        receiptNumber: orig?.receipt_number ?? null,
        saleId: r.original_transaction_id ?? null,
        refundId: r.id,
        description: r.reason,
      });
    });
  }, [detail, receiptSearch, shiftLookups]);

  const receiptSearchActive = receiptSearch.trim() !== "";
  const cashMovementTotal = detail?.cash_movements?.length ?? 0;
  const transactionTotal = detail?.transactions?.length ?? 0;
  const refundTotal = detail?.refunds?.length ?? 0;

  const pendingColumns = [
    { key: "cashier", header: "الكاشير", value: (r) => r.cashier_name || r.cashier_id, render: (r) => r.cashier_name || r.cashier_id },
    { key: "start", header: "وقت الفتح", value: (r) => formatDt(r.start_time), render: (r) => formatDt(r.start_time) },
    { key: "business_day", header: "يوم العمل", value: (r) => dateOnly(r.business_day), render: (r) => dateOnly(r.business_day) },
    { key: "end", header: "نهاية الوردية", value: (r) => formatDt(r.end_time), render: (r) => formatDt(r.end_time) },
    {
      key: "expected",
      header: "النقد المتوقع",
      className: "num",
      value: (r) => (r.expected_cash != null ? ils(r.expected_cash) : "—"),
      render: (r) => <ExpectedCashCell row={r} />,
    },
    {
      key: "actions",
      header: "",
      render: (r) => (
        <>
          <PrimaryButton size="sm" type="button" onClick={() => openReconcile(r)} style={{ marginLeft: "0.35rem" }}>
            عد النقد
          </PrimaryButton>
          <SecondaryButton size="sm" type="button" onClick={() => openDetail(r.id)}>
            تفاصيل
          </SecondaryButton>
        </>
      ),
    },
  ];

  const columns = [
    { key: "cashier", header: "الكاشير", value: (r) => r.cashier_name || r.cashier_id, render: (r) => r.cashier_name || r.cashier_id },
    { key: "start", header: "وقت الفتح", value: (r) => formatDt(r.start_time), render: (r) => formatDt(r.start_time) },
    { key: "business_day", header: "يوم العمل", value: (r) => dateOnly(r.business_day), render: (r) => dateOnly(r.business_day) },
    { key: "end", header: "النهاية", value: (r) => formatDt(r.end_time), render: (r) => formatDt(r.end_time) },
    {
      key: "opening",
      header: "افتتاح",
      className: "num",
      value: (r) => ils(r.opening_cash ?? 0),
      render: (r) => ils(r.opening_cash ?? 0),
    },
    {
      key: "closing",
      header: "إغلاق",
      className: "num",
      value: (r) => (r.closing_cash != null ? ils(r.closing_cash) : "—"),
      render: (r) => (r.closing_cash != null ? ils(r.closing_cash) : "—"),
    },
    {
      key: "expected",
      header: "متوقع",
      className: "num",
      value: (r) => (r.expected_cash != null ? ils(r.expected_cash) : "—"),
      render: (r) => <ExpectedCashCell row={r} />,
    },
    {
      key: "variance",
      header: "الفرق",
      className: "num",
      value: (r) =>
        r.variance != null ? `${r.variance >= 0 ? "+" : ""}${ils(r.variance)}` : "—",
      render: (r) =>
        r.variance != null ? (
          <span className={varianceWarn(r.variance) ? "negative" : ""}>
            {r.variance >= 0 ? "+" : ""}
            {ils(r.variance)}
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "cash_sales",
      header: "مبيعات نقدية",
      className: "num",
      value: (r) => visaAmountText(r, "cash_sales"),
      render: (r) => visaAmountText(r, "cash_sales"),
    },
    {
      key: "visa_sales",
      header: "مبيعات فيزا",
      className: "num",
      value: (r) => visaAmountText(r, "visa_sales"),
      render: (r) => visaAmountText(r, "visa_sales"),
    },
    {
      key: "tender_total",
      header: "إجمالي المبيعات النقدية والفيزا",
      className: "num",
      value: (r) => visaAmountText(r, "tender_total"),
      render: (r) => visaAmountText(r, "tender_total"),
    },
    {
      key: "cash_refunds",
      header: "مرتجعات نقدية",
      className: "num",
      value: (r) => visaAmountText(r, "cash_refunds"),
      render: (r) => visaAmountText(r, "cash_refunds"),
    },
    {
      key: "visa_refunds",
      header: "مرتجعات الفيزا",
      className: "num",
      value: (r) => visaAmountText(r, "visa_refunds"),
      render: (r) => visaAmountText(r, "visa_refunds"),
    },
    {
      key: "cash_net",
      header: "صافي المبيعات النقدية",
      className: "num",
      value: (r) => visaAmountText(r, "cash_net"),
      render: (r) => visaAmountText(r, "cash_net"),
    },
    {
      key: "visa_net",
      header: "صافي المبيعات الفيزا",
      className: "num",
      value: (r) => visaAmountText(r, "visa_net"),
      render: (r) => visaAmountText(r, "visa_net"),
    },
    {
      key: "status",
      header: "الحالة",
      value: (r) => {
        if (r.status === "open") return "مفتوحة";
        if (r.status === "pending_count") return "بانتظار العد";
        return "مغلقة";
      },
      render: (r) => shiftStatusBadge(r.status),
    },
    {
      key: "view",
      header: "",
      render: (r) => (
        <SecondaryButton size="sm" type="button" onClick={() => openDetail(r.id)}>
          تفاصيل
        </SecondaryButton>
      ),
    },
  ];

  const countedTotal = countedNisTotal(countRows, countedAmounts);
  const hasCountedInput = Object.values(countedAmounts).some((v) => String(v || "").trim() !== "");
  const reconcilePreview =
    reconcileTarget?.expected_cash != null && hasCountedInput
      ? countedTotal - Number(reconcileTarget.expected_cash)
      : null;

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title="تدقيق الورديات"
        subtitle="مراجعة الورديات. أرقام الفيزا مدفوعات مسجّلة، وليست تسوية بنكية."
        icon="shifts"
        actions={
          <ReportToolbar
            title="تدقيق الورديات"
            subtitle="سجل الورديات"
            columns={pickExportColumns(columns)}
            rows={rows}
            filename="shift-audit"
            disabled={loading}
          />
        }
      />

      {closedPending.length > 0 ? (
        <Card>
          <CardBody>
            <h2 className="dashboard-subtitle">طلبات معلّقة على ورديات جُردت — تسوية يدوية</h2>
            <p className="ui-hint">
              هذه الطلبات بقيت معلّقة بعد حفظ الجرد. لا يُغيّر النظام الجرد المحفوظ تلقائياً.
            </p>
            <ul className="dashboard-stock-list">
              {closedPending.map((row) => (
                <li key={`${row.kind}:${row.request_id}`}>
                  {row.label} — وردية #{row.shift_id}
                  {row.cashier_name ? ` — ${row.cashier_name}` : ""} — {ils(row.amount)}
                  {row.business_day ? ` — ${row.business_day}` : ""}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardBody flush>
          <h2 className="dashboard-subtitle ui-toolbar--compact">
            ورديات بانتظار العد ({pendingRows.length})
          </h2>
          <DataTable
            columns={pendingColumns}
            rows={pendingRows}
            loading={pendingLoading}
            empty="لا توجد ورديات بانتظار العد"
            emptyIcon="shifts"
          />
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <FormGrid>
            <FormField label="الحالة">
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">الكل</option>
                <option value="open">مفتوحة</option>
                <option value="pending_count">بانتظار العد</option>
                <option value="closed">مغلقة</option>
              </Select>
            </FormField>
            <FormField label="رقم الكاشير">
              <Input
                type="number"
                min="1"
                placeholder="اختياري"
                value={cashierId}
                onChange={(e) => setCashierId(e.target.value)}
              />
            </FormField>
            <FormField label="من تاريخ">
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </FormField>
            <FormField label="إلى تاريخ">
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </FormField>
          </FormGrid>
          <PrimaryButton type="button" onClick={load} disabled={loading} className="ui-mt-md">
            بحث
          </PrimaryButton>
        </CardBody>
      </Card>

      <Card>
        <CardBody flush>
          <DataTable
            columns={columns}
            rows={rows}
            loading={loading}
            empty="لا توجد ورديات"
            emptyIcon="shifts"
          />
        </CardBody>
      </Card>

      <Modal
        open={!!reconcileTarget}
        onClose={closeReconcile}
        title={reconcileTarget ? `عد النقد — وردية #${reconcileTarget.id}` : ""}
        footer={
          <>
            <PrimaryButton
              type="submit"
              form="reconcile-form"
              disabled={
                reconcileLoading ||
                supplierSaving ||
                advanceSaving ||
                countRows.length === 0 ||
                !!reconcileTarget?.count_blocked
              }
            >
              {reconcileLoading ? "جاري الحفظ…" : "تأكيد وإغلاق"}
            </PrimaryButton>
            <SecondaryButton type="button" onClick={closeReconcile}>
              إلغاء
            </SecondaryButton>
          </>
        }
      >
        {reconcileTarget ? (
          <>
            <p style={{ color: "var(--office-text-muted)", lineHeight: 1.6 }}>
              {reconcileTarget.cashier_name}
              {reconcileTarget.id != null ? ` — وردية #${reconcileTarget.id}` : ""}
            </p>
            <ShiftCountTotals source={reconcileTarget} />
            <CountPendingDecisions
              pendingRequests={reconcileTarget.pending_requests || []}
              discrepancies={reconcileTarget.handover_discrepancies || []}
              balanced={reconcileTarget.balanced !== false}
              onChanged={() => refreshReconcileTarget(reconcileTarget.id)}
            />
            <CountSupplierPaymentSection
              shiftId={reconcileTarget.id}
              payments={reconcileTarget.supplier_payments}
              paymentsTotal={reconcileTarget.supplier_payments_total}
              pendingRequests={reconcileTarget.supplier_payment_requests}
              onBusyChange={setSupplierSaving}
              onPosted={async () => {
                try {
                  await refreshReconcileTarget(reconcileTarget.id);
                  loadPending();
                  load();
                } catch (e) {
                  toast.error(apiErrorMessage(e, "تعذّر تحديث النقد المتوقع"));
                }
              }}
            />
            <CountAdvanceSection
              shiftId={reconcileTarget.id}
              advances={reconcileTarget.advances}
              advancesTotal={reconcileTarget.advances_total}
              onBusyChange={setAdvanceSaving}
              onPosted={async () => {
                try {
                  await refreshReconcileTarget(reconcileTarget.id);
                  loadPending();
                  load();
                } catch (e) {
                  toast.error(apiErrorMessage(e, "تعذّر تحديث النقد المتوقع"));
                }
              }}
            />
            <form id="reconcile-form" onSubmit={submitReconcile}>
            <CashCountFields
              countRows={countRows}
              values={countedAmounts}
              onChange={(code, value) =>
                setCountedAmounts((prev) => ({ ...prev, [code]: value }))
              }
            />
            {hasCountedInput ? (
              <p style={{ marginBottom: "0.75rem" }}>
                المجموع بالشيكل: <span className="num">{ils(countedTotal)}</span>
              </p>
            ) : null}
            {reconcilePreview != null && !Number.isNaN(reconcilePreview) ? (
              <p style={{ marginBottom: "0.75rem" }}>
                الفارق (معاينة):{" "}
                <span className={varianceWarn(reconcilePreview) ? "negative" : ""}>
                  {reconcilePreview >= 0 ? "+" : ""}
                  {ils(reconcilePreview)}
                </span>
              </p>
            ) : null}
            <FormField label="ملاحظات (اختياري)">
              <Input value={reconcileNotes} onChange={(e) => setReconcileNotes(e.target.value)} />
            </FormField>
          </form>
          </>
        ) : null}
      </Modal>

      <Modal
        open={!!detail || detailLoading}
        onClose={closeDetail}
        title={detailLoading ? "جاري التحميل…" : `وردية #${detail?.shift?.id}`}
        size="lg"
        footer={
          <>
            {detail?.shift?.status === "pending_count" ? (
              <PrimaryButton type="button" onClick={() => openReconcile(detail.shift)}>
                عد النقد
              </PrimaryButton>
            ) : null}
            <PrimaryButton type="button" onClick={printShiftReport}>
              طباعة التقرير
            </PrimaryButton>
            <PrimaryButton type="button" onClick={() => downloadCsv(detail?.shift?.id)}>
              تصدير CSV
            </PrimaryButton>
            <SecondaryButton type="button" onClick={closeDetail}>
              إغلاق
            </SecondaryButton>
          </>
        }
      >
        {detailLoading ? (
          <p style={{ color: "var(--office-text-muted)" }}>جاري تحميل تفاصيل الوردية…</p>
        ) : detail ? (
          <>
            <ShiftDetailSummary
              shift={detail.shift}
              summary={detail.summary}
              varianceWarn={varianceWarn}
            />
            {detail.summary?.balanced === false ? (
              <p className="ui-hint" style={{ color: "var(--office-danger, #9b2c2c)" }}>
                الوردية غير متوازنة بسبب نقد أو بضاعة سُلّمت ولم تُعكس في القيود.
              </p>
            ) : null}
            {(detail.handover_discrepancies || []).length > 0 ? (
              <ul className="dashboard-stock-list">
                {detail.handover_discrepancies.map((row) => (
                  <li key={`${row.kind}:${row.request_id}`}>
                    {row.label}
                    {row.cash_amount != null ? ` — ${ils(row.cash_amount)}` : ""}
                    {row.disposition === "loss_accepted" ? " — عجز مقبول" : " — لم يُعد"}
                  </li>
                ))}
              </ul>
            ) : null}

            <SearchInput
              className="shift-detail-search"
              value={receiptSearch}
              onChange={(e) => setReceiptSearch(e.target.value)}
              placeholder="بحث برقم الإيصال أو رقم البيع…"
            />

            <SectionTitle
              title="حركة النقد (زمنياً)"
              filtered={filteredCashMovements.length}
              total={cashMovementTotal}
              searchActive={receiptSearchActive}
            />
            {filteredCashMovements.length === 0 ? (
              <p className="shift-section-empty">
                {receiptSearchActive
                  ? `لا توجد نتائج لـ "${receiptSearch.trim()}"`
                  : "لا توجد حركات نقدية"}
              </p>
            ) : (
              <div className="dashboard-stock-list-wrap">
                <ul className="shift-cash-timeline">
                  <li className="shift-cash-row shift-cash-row--head" aria-hidden="true">
                    <span className="shift-cash-time">الوقت</span>
                    <span className="shift-cash-type">النوع</span>
                    <span className="shift-cash-refs">المرجع</span>
                    <span className="shift-cash-amt">المبلغ</span>
                  </li>
                  {filteredCashMovements.map((m) => (
                    <CashMovementRow
                      key={m.id}
                      movement={m}
                      txById={shiftLookups.txById}
                      refundById={shiftLookups.refundById}
                    />
                  ))}
                </ul>
              </div>
            )}

            <h3 className="dashboard-subtitle dashboard-section-title--with-badge">ذمم نقدية للعملاء</h3>
            {(detail.customer_cash_debts || []).length === 0 ? (
              <p className="shift-section-empty">لا توجد ذمم نقدية في هذه الوردية</p>
            ) : (
              <ul className="dashboard-stock-list">
                {(detail.customer_cash_debts || []).map((p) => (
                  <li key={p.request_id || p.movement_id} className="shift-sale-row-btn" style={{ display: "block" }}>
                    <span className="shift-sale-row-main">
                      {p.customer_name || "عميل"} — {ils(p.amount)} — {p.cashier_name || "—"} — {formatDt(p.approved_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {(detail.customer_collections || []).length > 0 ? (
              <>
                <h3 className="dashboard-subtitle dashboard-section-title--with-badge">قبض ذمم سابق — للمراجعة</h3>
                <ul className="dashboard-stock-list">
                  {(detail.customer_collections || []).map((p) => (
                    <li key={p.voucher_id || p.movement_id} className="shift-sale-row-btn" style={{ display: "block" }}>
                      <span className="shift-sale-row-main">
                        {p.customer_name || "عميل"} — {ils(p.amount)} — سند قبض #{p.voucher_no ?? "—"} — {p.cashier_name || "—"} — {formatDt(p.collected_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            <h3 className="dashboard-subtitle dashboard-section-title--with-badge">دفعات الموردين</h3>
            {(detail.supplier_payments || []).length === 0 ? (
              <p className="shift-section-empty">لا توجد دفعات موردين في هذه الوردية</p>
            ) : (
              <ul className="dashboard-stock-list">
                {(detail.supplier_payments || []).map((p) => (
                  <li key={p.voucher_id || p.movement_id} className="shift-sale-row-btn" style={{ display: "block" }}>
                    <span className="shift-sale-row-main">
                      {p.supplier_name || "مورد"} — {ils(p.amount)} — سند #{p.voucher_no ?? "—"} — {p.cashier_name || "—"} — {formatDt(p.paid_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <SectionTitle
              title="المبيعات"
              filtered={filteredTransactions.length}
              total={transactionTotal}
              searchActive={receiptSearchActive}
            />
            {filteredTransactions.length === 0 ? (
              <p className="shift-section-empty">
                {receiptSearchActive
                  ? `لا توجد نتائج لـ "${receiptSearch.trim()}"`
                  : "لا توجد مبيعات"}
              </p>
            ) : (
              <ul className="dashboard-stock-list">
                {filteredTransactions.map((t) => {
                  const expanded = expandedSaleId === t.id;
                  return (
                    <li key={t.id} style={{ display: "block", paddingBottom: expanded ? "0.5rem" : undefined }}>
                      <button
                        type="button"
                        onClick={() => toggleSale(t.id)}
                        className="shift-sale-row-btn"
                      >
                        <span className="shift-sale-row-main">
                          <span className="shift-sale-row-toggle">{expanded ? "▼" : "◀"}</span>
                          <span className="shift-sale-row-time">{formatCashTime(t.created_at)}</span>
                          <span className="shift-ref-chip">#{t.id}</span>
                          {t.receipt_number ? (
                            <span className="shift-ref-chip shift-ref-chip--receipt">{t.receipt_number}</span>
                          ) : null}
                          <span className="shift-sale-row-meta">
                            {PM[t.payment_method] || t.payment_method}
                          </span>
                        </span>
                        <span className="num">{ils(t.total)}</span>
                      </button>
                      {expanded ? (
                        <div className="shift-sale-expanded">
                          <ReceiptLineItems itemsJson={t.items_json} />
                          <ReceiptTotals record={t} />
                          <PrimaryButton
                            size="sm"
                            type="button"
                            onClick={() => printSaleReceipt(t.id)}
                            disabled={printingSaleId === t.id}
                          >
                            {printingSaleId === t.id ? "جاري الطباعة…" : "طباعة الإيصال"}
                          </PrimaryButton>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}

            <SectionTitle
              title="الاسترجاعات"
              filtered={filteredRefunds.length}
              total={refundTotal}
              searchActive={receiptSearchActive}
            />
            {filteredRefunds.length === 0 ? (
              <p className="shift-section-empty">
                {receiptSearchActive
                  ? `لا توجد نتائج لـ "${receiptSearch.trim()}"`
                  : "لا توجد استرجاعات"}
              </p>
            ) : (
              <ul className="dashboard-stock-list">
                {filteredRefunds.map((r) => {
                  const expanded = expandedRefundId === r.id;
                  const origReceipt =
                    r.original_receipt_number ||
                    (r.original_transaction_id
                      ? shiftLookups.txById.get(r.original_transaction_id)?.receipt_number
                      : null);
                  return (
                    <li key={r.id} style={{ display: "block", paddingBottom: expanded ? "0.5rem" : undefined }}>
                      <button
                        type="button"
                        onClick={() => toggleRefund(r.id)}
                        className="shift-sale-row-btn"
                      >
                        <span className="shift-sale-row-main">
                          <span className="shift-sale-row-toggle">{expanded ? "▼" : "◀"}</span>
                          <span className="shift-sale-row-time">{formatCashTime(r.created_at)}</span>
                          <span className="shift-ref-chip">#{r.id}</span>
                          {r.original_transaction_id ? (
                            <span className="shift-ref-chip">بيع #{r.original_transaction_id}</span>
                          ) : null}
                          {origReceipt ? (
                            <span className="shift-ref-chip shift-ref-chip--receipt">{origReceipt}</span>
                          ) : null}
                          {r.original_shift_id != null &&
                          Number(r.original_shift_id) !== Number(detail.shift.id) ? (
                            <span className="shift-ref-chip">من وردية #{r.original_shift_id}</span>
                          ) : null}
                          <span className="shift-sale-row-meta">
                            {PM[r.payment_method] || r.payment_method}
                          </span>
                        </span>
                        <span className="num">{ils(r.total)}</span>
                      </button>
                      {expanded ? (
                        <div className="shift-sale-expanded">
                          {r.reason ? (
                            <p style={{ margin: "0 0 0.35rem", color: "var(--office-text-muted)" }}>
                              السبب: {r.reason}
                            </p>
                          ) : null}
                          <ReceiptLineItems itemsJson={r.items_json} />
                          <ReceiptTotals record={r} showReceiptNumber={false} />
                          <PrimaryButton
                            size="sm"
                            type="button"
                            onClick={() => printRefundReceipt(r.id)}
                            disabled={printingRefundId === r.id}
                          >
                            {printingRefundId === r.id ? "جاري الطباعة…" : "طباعة إيصال الاسترجاع"}
                          </PrimaryButton>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        ) : null}
      </Modal>
    </div>
  );
}
