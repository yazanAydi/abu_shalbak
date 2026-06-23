import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

const formatDt = (v) => (v ? String(v).replace("T", " ").slice(0, 16) : "—");

function statusLabel(status) {
  if (status === "approved") return "موافَق";
  if (status === "rejected") return "مرفوض";
  if (status === "pending") return "قيد المراجعة";
  return status || "—";
}

export default function MyRefundRequests() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get("/api/refund-requests/mine", {
        headers: getAuthHeaders(),
      });
      const payload = data?.data ?? data;
      setRows(Array.isArray(payload) ? payload : []);
    } catch (e) {
      setError(e.response?.data?.error || e.message || "تعذّر التحميل");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 7000);
    return () => clearInterval(timer);
  }, [load]);

  async function acknowledge(id) {
    try {
      await api.post(`/api/refund-requests/${id}/acknowledge`, {}, { headers: getAuthHeaders() });
      await load();
    } catch (e) {
      setError(e.response?.data?.error || e.message || "فشل");
    }
  }

  return (
    <div className="pos-screen" dir="rtl" lang="ar">
      <header className="pos-header" style={{ justifyContent: "space-between" }}>
        <h1 style={{ margin: 0, fontSize: "1.25rem" }}>طلباتي للاسترجاع</h1>
        <Link to="/checkout" className="pos-btn-ghost">
          العودة للكاشير
        </Link>
      </header>

      {error ? <div className="pos-blocked">{error}</div> : null}

      <div className="pos-cart-panel" style={{ margin: "1rem" }}>
        {loading && rows.length === 0 ? <p>جاري التحميل…</p> : null}
        {!loading && rows.length === 0 ? (
          <p className="pos-cart-empty">لا توجد طلبات استرجاع</p>
        ) : (
          <table className="pos-cart-table">
            <thead>
              <tr>
                <th>#</th>
                <th>الفاتورة</th>
                <th>المبلغ</th>
                <th>الحالة</th>
                <th>التاريخ</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const unread =
                  (r.status === "approved" || r.status === "rejected") &&
                  !r.cashier_acknowledged_at;
                return (
                  <tr key={r.id} className={unread ? "pos-refund-unread" : ""}>
                    <td>{r.id}</td>
                    <td>#{r.transaction_id}</td>
                    <td>{ils(r.total_amount ?? 0)}</td>
                    <td>{statusLabel(r.status)}</td>
                    <td>{formatDt(r.approved_at || r.rejected_at || r.created_at)}</td>
                    <td>
                      {unread ? (
                        <button type="button" className="pos-toolbar-btn" onClick={() => acknowledge(r.id)}>
                          تمّت المطالعة
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
