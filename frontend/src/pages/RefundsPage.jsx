import { useCallback, useEffect, useState } from "react";
import { firstOfCurrentMonthYmd, todayYmd } from "../utils/reportDates";
import { Link } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders, getUser } from "../utils/auth";
import { isAdminRole } from "../utils/roles";
import RefundMetrics from "../components/RefundMetrics";
import RefundFilters from "../components/RefundFilters";
import RefundTable from "../components/RefundTable";
import RefundDetailsModal from "../components/RefundDetailsModal";
import { formatRefundReason, statusLabelAr, ils as refundIls } from "../utils/refundHelpers";
import { PageHeader, ReportToolbar } from "../components/ui";
import "../components/RefundsManagement.css";

const CASHIER_NAME_DEBOUNCE_MS = 300;

const REFUND_COLUMNS = [
  { key: "id", header: "#" },
  { key: "original_transaction_id", header: "الفاتورة الأصلية", value: (r) => `#${r.original_transaction_id}` },
  { key: "cashier_username", header: "الكاشير", value: (r) => r.cashier_username || "—" },
  { key: "reason", header: "السبب", value: (r) => formatRefundReason(r.reason) },
  { key: "total", header: "المبلغ", value: (r) => refundIls(r.total) },
  { key: "status", header: "الحالة", value: (r) => statusLabelAr(r).text },
  {
    key: "payment_method",
    header: "طريقة الرد",
    value: (r) => (r.payment_method === "cash" ? "نقد" : "بطاقة"),
  },
  { key: "created_at", header: "التاريخ", value: (r) => (r.created_at || "").replace("T", " ").slice(0, 16) },
];

function firstOfMonth() {
  return firstOfCurrentMonthYmd();
}

function todayYmdLocal() {
  return todayYmd();
}

export default function RefundsPage() {
  const u = getUser();
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const initialFilters = {
    dateFrom: firstOfMonth(),
    dateTo: todayYmdLocal(),
    cashierName: "",
    status: "",
    minAmount: "",
    maxAmount: "",
    q: "",
  };
  const [filters, setFilters] = useState(initialFilters);
  const [appliedFilters, setAppliedFilters] = useState(initialFilters);

  const [selected, setSelected] = useState(() => new Set());
  const [modalId, setModalId] = useState(null);
  const [bulkNote, setBulkNote] = useState("");

  const fetchList = useCallback(async () => {
    setErr("");
    setLoading(true);
    try {
      const params = {};
      if (appliedFilters.dateFrom) params.date_from = appliedFilters.dateFrom;
      if (appliedFilters.dateTo) params.date_to = appliedFilters.dateTo;
      if (appliedFilters.cashierName.trim()) params.cashier_name = appliedFilters.cashierName.trim();
      if (appliedFilters.status) params.status = appliedFilters.status;
      if (appliedFilters.minAmount !== "") params.min_amount = appliedFilters.minAmount;
      if (appliedFilters.maxAmount !== "") params.max_amount = appliedFilters.maxAmount;
      if (appliedFilters.q.trim()) params.q = appliedFilters.q.trim();

      const [sumRes, listRes] = await Promise.all([
        api.get("/api/refunds/summary", { headers: getAuthHeaders() }),
        api.get("/api/refunds", { headers: getAuthHeaders(), params }),
      ]);
      setSummary(sumRes.data);
      setRows(Array.isArray(listRes.data) ? listRes.data : []);
      setSelected(new Set());
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "تعذّر التحميل");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [appliedFilters]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  useEffect(() => {
    const t = setTimeout(() => {
      setAppliedFilters((prev) =>
        prev.cashierName === filters.cashierName
          ? prev
          : { ...prev, cashierName: filters.cashierName }
      );
    }, CASHIER_NAME_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [filters.cashierName]);

  const emptyFilters = {
    dateFrom: "",
    dateTo: "",
    cashierName: "",
    status: "",
    minAmount: "",
    maxAmount: "",
    q: "",
  };

  function resetFilters() {
    setFilters(emptyFilters);
    setAppliedFilters(emptyFilters);
  }

  function applySearch() {
    setAppliedFilters({ ...filters });
  }

  function toggleSelect(id, checked) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleSelectAllPending(ids) {
    const allOn = ids.length > 0 && ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOn) {
        ids.forEach((id) => next.delete(id));
      } else {
        ids.forEach((id) => next.add(id));
      }
      return next;
    });
  }

  const selectedPending = [...selected].filter(
    (id) => rows.find((r) => r.id === id)?.status === "pending"
  );

  async function bulkStatus(status) {
    if (selectedPending.length === 0) return;
    setErr("");
    try {
      await api.post(
        "/api/refunds/bulk",
        { ids: selectedPending, status, review_notes: bulkNote.trim() || null },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      setBulkNote("");
      await fetchList();
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "فشلت العملية الجماعية");
    }
  }

  async function bulkDelete() {
    if (selectedPending.length === 0) return;
    if (!window.confirm(`حذف ${selectedPending.length} طلب استرجاع قيد الانتظار؟`)) return;
    setErr("");
    try {
      for (const id of selectedPending) {
        await api.delete(`/api/refunds/${id}`, { headers: getAuthHeaders() });
      }
      await fetchList();
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "فشل الحذف");
    }
  }

  async function openPrint(id) {
    try {
      const res = await api.get(`/api/refunds/${id}/receipt`, {
        headers: getAuthHeaders(),
        responseType: "blob",
      });
      const url = URL.createObjectURL(res.data);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "فشل الطباعة");
    }
  }

  return (
    <div className="office-page report-page rf-page" dir="rtl" lang="ar">
      <PageHeader
        title="إدارة الاسترجاعات"
        subtitle="مراجعة وتصدير الاسترجاعات"
        icon="refunds"
        actions={
          <ReportToolbar
            title="إدارة الاسترجاعات"
            subtitle={`${appliedFilters.dateFrom || "—"} إلى ${appliedFilters.dateTo || "—"}`}
            columns={REFUND_COLUMNS}
            rows={rows}
            filename="refunds"
            disabled={loading}
          />
        }
      />

      {summary?.pending?.count > 0 ? (
        <p className="rf-muted" style={{ marginBottom: "1rem" }}>
          ⚠️ {summary.pending.count} طلب/طلبات بانتظار الموافقة —{" "}
          <Link to="/refund-approvals">افتح موافقات الاسترجاع</Link>
        </p>
      ) : null}

      {err ? <div className="report-err">{err}</div> : null}

      <RefundMetrics summary={summary} />

      <RefundFilters
        filters={filters}
        onChange={setFilters}
        onSearch={applySearch}
        onReset={resetFilters}
      />

      <div className="rf-page-actions">
        {selectedPending.length > 0 ? (
          <>
            <input
              type="text"
              className="rf-finput"
              style={{ maxWidth: 220 }}
              placeholder="ملاحظات للمجموعة"
              value={bulkNote}
              onChange={(e) => setBulkNote(e.target.value)}
            />
            <button type="button" className="rf-fbtn rf-fbtn--success" onClick={() => bulkStatus("approved")}>
              ✓ موافقة ({selectedPending.length})
            </button>
            <button type="button" className="rf-fbtn rf-fbtn--danger" onClick={() => bulkStatus("rejected")}>
              ✗ رفض ({selectedPending.length})
            </button>
            <button type="button" className="rf-fbtn" onClick={bulkDelete}>
              🗑️ حذف المعلّقة ({selectedPending.length})
            </button>
          </>
        ) : null}
      </div>

      {loading ? (
        <p>جاري التحميل…</p>
      ) : rows.length === 0 ? (
        <div className="rf-empty">
          <h2>لا توجد استرجاعات</h2>
          <p>لم يُعثر على استرجاعات ضمن التصفية الحالية.</p>
          <Link to="/reports" className="rf-fbtn rf-fbtn--primary">
            ← العودة للوحة التحكم
          </Link>{" "}
          <button type="button" className="rf-fbtn" onClick={resetFilters}>
            بدء تصفية جديدة
          </button>
        </div>
      ) : (
        <RefundTable
          rows={rows}
          selected={selected}
          onToggleSelect={toggleSelect}
          onToggleSelectAllPending={toggleSelectAllPending}
          onViewDetails={(r) => setModalId(r.id)}
          onPrint={(r) => openPrint(r.id)}
        />
      )}

      <RefundDetailsModal
        open={modalId != null}
        refundId={modalId}
        onClose={() => setModalId(null)}
        onUpdated={fetchList}
        onPrint={openPrint}
      />
    </div>
  );
}
