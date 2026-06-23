import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders, getUser, removeToken } from "../utils/auth";
import { isAdminRole, canViewReports } from "../utils/roles";

const CASHIER_NAME_DEBOUNCE_MS = 300;
import RefundMetrics from "../components/RefundMetrics";
import RefundFilters from "../components/RefundFilters";
import RefundTable from "../components/RefundTable";
import RefundDetailsModal from "../components/RefundDetailsModal";
import { downloadCsv, refundsToCsv } from "../utils/refundHelpers";
import "../components/RefundsManagement.css";

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export default function RefundsPage() {
  const navigate = useNavigate();
  const u = getUser();
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const initialFilters = {
    dateFrom: firstOfMonth(),
    dateTo: todayYmd(),
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

  function logout() {
    removeToken();
    navigate("/login", { replace: true });
  }

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

  function exportCsv() {
    const name = `refunds_${appliedFilters.dateFrom || "all"}_${appliedFilters.dateTo || "all"}.csv`;
    downloadCsv(name, refundsToCsv(rows));
  }

  return (
    <div className="report-page rf-page" dir="rtl" lang="ar">
      <div className="report-top-nav">
        <Link to="/reports" className="report-nav-link">
          لوحة التحكم
        </Link>
        <Link to="/finance" className="report-nav-link">
          المالية
        </Link>
        {canViewReports(u?.role) ? (
          <Link to="/shift-audit" className="report-nav-link">
            تدقيق الورديات
          </Link>
        ) : null}
        {isAdminRole(u?.role) ? (
          <>
            <Link to="/checkout" className="report-nav-link">
              الكاشير
            </Link>
            <Link to="/manage-products" className="report-nav-link">
              المنتجات
            </Link>
          </>
        ) : null}
        <button type="button" className="report-nav-link" onClick={logout}>
          خروج
        </button>
      </div>

      <h1 className="rf-page-title">إدارة الاسترجاعات</h1>

      {err ? <div className="report-err">{err}</div> : null}

      <RefundMetrics summary={summary} />

      <RefundFilters
        filters={filters}
        onChange={setFilters}
        onSearch={applySearch}
        onReset={resetFilters}
      />

      <div className="rf-page-actions">
        <button type="button" className="rf-fbtn rf-fbtn--primary" onClick={exportCsv}>
          📥 تصدير CSV
        </button>
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
