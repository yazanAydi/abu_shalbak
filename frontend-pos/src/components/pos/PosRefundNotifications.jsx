import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../../apiClient";
import { getAuthHeaders } from "../../utils/auth";
import "../ShiftModal.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

/** Oldest terminal decision first so the cashier clears the queue in order. */
function sortUnreadFifo(items) {
  return [...items].sort((a, b) => {
    const ta = a.approved_at || a.rejected_at || a.created_at || "";
    const tb = b.approved_at || b.rejected_at || b.created_at || "";
    return String(ta).localeCompare(String(tb));
  });
}

/**
 * Polls unread refund decisions and shows ONE centered modal at a time (FIFO).
 * Cashier taps "تمّ" to acknowledge; the next unread item appears automatically.
 */
export default function PosRefundNotifications() {
  const [unread, setUnread] = useState([]);
  const [ackLoading, setAckLoading] = useState(false);
  const [err, setErr] = useState("");

  const poll = useCallback(async () => {
    try {
      const { data } = await api.get("/api/refund-requests/mine/unread", {
        headers: getAuthHeaders(),
      });
      const payload = data?.data ?? data;
      const list = Array.isArray(payload) ? sortUnreadFifo(payload) : [];
      setUnread(list);
    } catch {
      /* offline-safe: keep current queue */
    }
  }, []);

  useEffect(() => {
    poll();
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  }, [poll]);

  const current = unread[0] ?? null;

  async function acknowledge() {
    if (!current || ackLoading) return;
    setAckLoading(true);
    setErr("");
    try {
      await api.post(
        `/api/refund-requests/${current.id}/acknowledge`,
        {},
        { headers: getAuthHeaders() }
      );
      setUnread((prev) => prev.filter((x) => x.id !== current.id));
      await poll();
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "تعذّر التأكيد");
    } finally {
      setAckLoading(false);
    }
  }

  if (!current) return null;

  const approved = current.status === "approved";
  const title = approved ? "تمت الموافقة على الاسترجاع" : "تم رفض طلب الاسترجاع";
  const statusClass = approved ? "shift-modal-success" : "shift-modal-err";

  return (
    <div className="shift-modal-overlay" role="dialog" aria-modal="true" dir="rtl" lang="ar">
      <div className="shift-modal-backdrop" aria-hidden />
      <div className="shift-modal-panel">
        <h2 className="shift-modal-title">طلب استرجاع #{current.id}</h2>
        <p className={`shift-modal-meta ${statusClass}`}>{title}</p>
        <p className="shift-modal-meta">
          فاتورة #{current.transaction_id} — {ils(current.total_amount ?? 0)}
        </p>
        {unread.length > 1 ? (
          <p className="shift-modal-hint">
            {unread.length} إشعار/إشعارات — اضغط «تمّ» للانتقال إلى التالي
          </p>
        ) : null}
        {err ? <div className="shift-modal-err">{err}</div> : null}
        <div className="shift-modal-actions">
          <button
            type="button"
            className="shift-modal-primary"
            onClick={acknowledge}
            disabled={ackLoading}
          >
            {ackLoading ? "جاري الحفظ…" : "تمّ"}
          </button>
          <Link to="/my-refunds" className="shift-modal-secondary" style={{ textAlign: "center", textDecoration: "none" }}>
            كل الطلبات
          </Link>
        </div>
      </div>
    </div>
  );
}
