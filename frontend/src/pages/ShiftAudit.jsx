import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils, dateTime, dateTimeSeconds } from "../utils/format";
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

const PM = { cash: "نقد", visa: "بطاقة" };

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
      <div>
        الضريبة: <span className="num">{ils(record.tax ?? 0)}</span>
      </div>
      <div>
        <strong>
          الإجمالي: <span className="num">{ils(record.total ?? 0)}</span>
        </strong>
      </div>
      <div>الدفع: {PM[record.payment_method] || record.payment_method}</div>
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
  if (type === "payment") return "green";
  if (type === "refund") return "red";
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
            <span className="shift-detail-chip-k">متوقع</span>
            <span className="shift-detail-chip-v num">{ils(shift.expected_cash ?? 0)}</span>
          </div>
          <div className="shift-detail-chip">
            <span className="shift-detail-chip-k">الفرق</span>
            <span className={`shift-detail-chip-v num ${varianceWarn(shift.variance) ? "negative" : ""}`}>
              {shift.variance != null ? `${shift.variance >= 0 ? "+" : ""}${ils(shift.variance)}` : "—"}
            </span>
          </div>
        </>
      ) : (
        <div className="shift-detail-chip">
          <span className="shift-detail-chip-k">{status === "pending_count" ? "متوقع" : "متوقع حالياً"}</span>
          <span className="shift-detail-chip-v num">
            {summary?.expected != null ? ils(summary.expected) : "—"}
          </span>
        </div>
      )}
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
  const [pendingLoading, setPendingLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [cashierId, setCashierId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reconcileTarget, setReconcileTarget] = useState(null);
  const [closingCash, setClosingCash] = useState("");
  const [reconcileNotes, setReconcileNotes] = useState("");
  const [reconcileLoading, setReconcileLoading] = useState(false);
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
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "تعذّر تحميل الورديات المعلقة");
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
      toast.error(e.response?.data?.error || e.message || "تعذّر التحميل");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [status, cashierId, dateFrom, dateTo, toast]);

  useEffect(() => {
    loadPending();
    load();
  }, [loadPending, load]);

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
      toast.error(e.response?.data?.error || e.message || "تعذّر فتح التفاصيل");
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
      toast.error(e.response?.data?.error || e.message || "فشل طباعة الإيصال");
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
      toast.error(e.response?.data?.error || e.message || "فشل طباعة إيصال الاسترجاع");
    } finally {
      setPrintingRefundId(null);
    }
  }

  function openReconcile(row) {
    setReconcileTarget(row);
    setClosingCash("");
    setReconcileNotes("");
  }

  function closeReconcile() {
    setReconcileTarget(null);
    setClosingCash("");
    setReconcileNotes("");
  }

  async function submitReconcile(e) {
    e.preventDefault();
    if (!reconcileTarget?.id) return;
    const v = Number(String(closingCash).replace(",", "."));
    if (Number.isNaN(v) || v < 0) {
      toast.error("أدخل مبلغاً صالحاً");
      return;
    }
    setReconcileLoading(true);
    const shiftId = reconcileTarget.id;
    try {
      const { data } = await api.post(
        `/api/shifts/${shiftId}/reconcile`,
        { closing_cash: v, notes: reconcileNotes.trim() || null },
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
      toast.error(e.response?.data?.error || e.message || "فشل التصدير");
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
    { key: "start", header: "البداية", value: (r) => formatDt(r.start_time), render: (r) => formatDt(r.start_time) },
    { key: "end", header: "نهاية الوردية", value: (r) => formatDt(r.end_time), render: (r) => formatDt(r.end_time) },
    {
      key: "expected",
      header: "النقد المتوقع",
      className: "num",
      value: (r) => (r.expected_cash != null ? ils(r.expected_cash) : "—"),
      render: (r) => (r.expected_cash != null ? ils(r.expected_cash) : "—"),
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
    { key: "start", header: "البداية", value: (r) => formatDt(r.start_time), render: (r) => formatDt(r.start_time) },
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
      render: (r) => (r.expected_cash != null ? ils(r.expected_cash) : "—"),
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

  const reconcilePreview =
    reconcileTarget?.expected_cash != null && closingCash !== ""
      ? Number(closingCash) - Number(reconcileTarget.expected_cash)
      : null;

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title="تدقيق الورديات"
        subtitle="مراجعة الورديات والفروقات النقدية"
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
            <PrimaryButton type="submit" form="reconcile-form" disabled={reconcileLoading}>
              {reconcileLoading ? "جاري الحفظ…" : "تأكيد وإغلاق"}
            </PrimaryButton>
            <SecondaryButton type="button" onClick={closeReconcile}>
              إلغاء
            </SecondaryButton>
          </>
        }
      >
        {reconcileTarget ? (
          <form id="reconcile-form" onSubmit={submitReconcile}>
            <p style={{ color: "var(--office-text-muted)", lineHeight: 1.6 }}>
              {reconcileTarget.cashier_name} — النقد المتوقع:{" "}
              {reconcileTarget.expected_cash != null ? ils(reconcileTarget.expected_cash) : "—"}
            </p>
            <FormField label="النقد الفعلي في الدرج">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={closingCash}
                onChange={(e) => setClosingCash(e.target.value)}
                required
                autoFocus
              />
            </FormField>
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
                  const origReceipt = r.original_transaction_id
                    ? shiftLookups.txById.get(r.original_transaction_id)?.receipt_number
                    : null;
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
