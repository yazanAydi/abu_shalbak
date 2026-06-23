import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders, getUser, removeToken } from "../utils/auth";
import { isAdminRole } from "../utils/roles";
import { SHIFT_VARIANCE_WARNING } from "../components/ShiftEnd";
import "./ShiftAudit.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

const PM = { cash: "نقد", visa: "بطاقة" };

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

export default function ShiftAudit() {
  const navigate = useNavigate();
  const reportUser = getUser();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [status, setStatus] = useState("");
  const [cashierId, setCashierId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status === "open" || status === "closed") params.set("status", status);
      if (String(cashierId).trim() !== "") params.set("cashier_id", String(cashierId).trim());
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);
      const q = params.toString();
      const { data } = await api.get(`/api/shifts${q ? `?${q}` : ""}`, {
        headers: getAuthHeaders(),
      });
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "تعذّر التحميل");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [status, cashierId, dateFrom, dateTo]);

  useEffect(() => {
    load();
  }, [load]);

  async function openDetail(id) {
    setDetail(null);
    setDetailLoading(true);
    setErr(null);
    try {
      const { data } = await api.get(`/api/shifts/${id}`, { headers: getAuthHeaders() });
      setDetail(data);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "تعذّر فتح التفاصيل");
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    setDetail(null);
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
      setErr(e.response?.data?.error || e.message || "فشل التصدير");
    }
  }

  function logout() {
    removeToken();
    navigate("/login", { replace: true });
  }

  const varianceClass = (v) => {
    if (v == null || Number.isNaN(Number(v))) return "";
    return Math.abs(Number(v)) > SHIFT_VARIANCE_WARNING ? "sa-var-warn" : "";
  };

  return (
    <div className="sa-page" dir="rtl" lang="ar">
      <div className="sa-nav">
        <Link to="/reports" className="sa-nav-link">
          التقرير اليومي
        </Link>
        <Link to="/finance" className="sa-nav-link">
          المالية
        </Link>
        {isAdminRole(reportUser?.role) ? (
          <>
            <Link to="/checkout" className="sa-nav-link">
              الكاشير
            </Link>
            <Link to="/manage-products" className="sa-nav-link">
              المنتجات
            </Link>
            <Link to="/manage-users" className="sa-nav-link">
              الحسابات
            </Link>
          </>
        ) : null}
        <button type="button" className="sa-nav-link" onClick={logout}>
          خروج
        </button>
      </div>

      <h1 className="sa-title">تدقيق الورديات</h1>

      <div className="sa-filters">
        <label>
          الحالة
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">الكل</option>
            <option value="open">مفتوحة</option>
            <option value="closed">مغلقة</option>
          </select>
        </label>
        <label>
          رقم الكاشير
          <input
            type="number"
            min="1"
            placeholder="اختياري"
            value={cashierId}
            onChange={(e) => setCashierId(e.target.value)}
          />
        </label>
        <label>
          من تاريخ
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </label>
        <label>
          إلى تاريخ
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </label>
        <button type="button" className="sa-btn" onClick={load} disabled={loading}>
          بحث
        </button>
      </div>

      {err ? <div className="sa-err">{err}</div> : null}

      {loading ? (
        <p>جاري التحميل…</p>
      ) : (
        <div className="sa-table-wrap">
          <table className="sa-table">
            <thead>
              <tr>
                <th>الكاشير</th>
                <th>البداية</th>
                <th>النهاية</th>
                <th>افتتاح</th>
                <th>إغلاق</th>
                <th>متوقع</th>
                <th>الفرق</th>
                <th>الحالة</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={`sa-row-click ${varianceClass(r.variance)}`}
                  onClick={() => openDetail(r.id)}
                  onKeyDown={(e) => e.key === "Enter" && openDetail(r.id)}
                  role="button"
                  tabIndex={0}
                >
                  <td>{r.cashier_name || r.cashier_id}</td>
                  <td>{r.start_time?.replace("T", " ").slice(0, 16) || "—"}</td>
                  <td>{r.end_time ? r.end_time.replace("T", " ").slice(0, 16) : "—"}</td>
                  <td>{ils(r.opening_cash ?? 0)}</td>
                  <td>{r.closing_cash != null ? ils(r.closing_cash) : "—"}</td>
                  <td>{r.expected_cash != null ? ils(r.expected_cash) : "—"}</td>
                  <td className={varianceClass(r.variance)}>
                    {r.variance != null ? `${r.variance >= 0 ? "+" : ""}${ils(r.variance)}` : "—"}
                  </td>
                  <td>{r.status === "open" ? "مفتوحة" : "مغلقة"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 ? <p className="sa-empty">لا توجد ورديات.</p> : null}
        </div>
      )}

      {detailLoading ? (
        <div className="sa-modal-overlay">
          <div className="sa-modal">جاري التحميل…</div>
        </div>
      ) : null}

      {detail && !detailLoading ? (
        <div className="sa-modal-overlay" role="dialog" aria-modal="true">
          <div className="sa-modal sa-modal-wide">
            <div className="sa-modal-head">
              <h2>وردية #{detail.shift?.id}</h2>
              <button type="button" className="sa-btn ghost" onClick={closeDetail}>
                إغلاق
              </button>
            </div>
            <p className="sa-modal-meta">
              {detail.shift?.cashier_name} — افتتاح {ils(detail.shift?.opening_cash ?? 0)}
              {detail.shift?.status === "closed" ? (
                <>
                  {" "}
                  — إغلاق {ils(detail.shift?.closing_cash ?? 0)} — متوقع{" "}
                  {ils(detail.shift?.expected_cash ?? 0)} — فرق{" "}
                  <span className={varianceClass(detail.shift?.variance)}>
                    {detail.shift?.variance != null
                      ? `${detail.shift.variance >= 0 ? "+" : ""}${ils(detail.shift.variance)}`
                      : "—"}
                  </span>
                </>
              ) : (
                <>
                  {" "}
                  — متوقع حالياً {detail.summary?.expected != null ? ils(detail.summary.expected) : "—"}
                </>
              )}
            </p>
            <button
              type="button"
              className="sa-btn"
              onClick={() => downloadCsv(detail.shift?.id)}
            >
              تصدير CSV
            </button>

            <h3 className="sa-subh">حركة النقد (زمنياً)</h3>
            <ul className="sa-timeline">
              {(detail.cash_movements || []).map((m) => (
                <li key={m.id}>
                  <span className="sa-tl-time">{m.created_at}</span>
                  <span className="sa-tl-type">{movementLabel(m.movement_type)}</span>
                  <span className="sa-tl-amt">{ils(m.amount)}</span>
                  <span className="sa-tl-desc">{m.description || ""}</span>
                </li>
              ))}
            </ul>

            <h3 className="sa-subh">المبيعات</h3>
            <ul className="sa-timeline">
              {(detail.transactions || []).map((t) => (
                <li key={t.id}>
                  <span className="sa-tl-time">{t.created_at}</span>
                  <span className="sa-tl-type">بيع #{t.id}</span>
                  <span className="sa-tl-amt">{ils(t.total)}</span>
                  <span className="sa-tl-desc">{PM[t.payment_method] || t.payment_method}</span>
                </li>
              ))}
            </ul>

            <h3 className="sa-subh">الاسترجاعات</h3>
            <ul className="sa-timeline">
              {(detail.refunds || []).map((r) => (
                <li key={r.id}>
                  <span className="sa-tl-time">{r.created_at}</span>
                  <span className="sa-tl-type">استرجاع #{r.id}</span>
                  <span className="sa-tl-amt">{ils(r.total)}</span>
                  <span className="sa-tl-desc">{PM[r.payment_method] || r.payment_method}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
