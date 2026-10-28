import { useEffect, useRef, useState } from "react";
import api from "../../apiClient";
import { getAuthHeaders } from "../../utils/auth";
import { playApprovalDecision } from "../../utils/posSounds";
import "../ShiftModal.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

const STATUS_LABEL = {
  pending: "بانتظار موافقة المدير…",
  approved: "تمت الموافقة على الاسترجاع",
  rejected: "تم رفض طلب الاسترجاع",
  expired: "انتهت صلاحية الطلب",
};

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {number|null} props.requestId
 * @param {() => void} props.onClose
 * @param {() => void} [props.onTerminal]
 */
export default function PosRefundWaitingModal({ open, requestId, onClose, onTerminal }) {
  const [status, setStatus] = useState("pending");
  const [detail, setDetail] = useState(null);
  const [delivery, setDelivery] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const [retryNote, setRetryNote] = useState("");
  const [err, setErr] = useState("");
  const terminalRef = useRef(false);

  useEffect(() => {
    if (!open || !requestId) {
      setStatus("pending");
      setDetail(null);
      setErr("");
      terminalRef.current = false;
      return undefined;
    }

    let cancelled = false;

    async function poll() {
      try {
        const { data } = await api.get(`/api/refund-requests/${requestId}`, {
          headers: getAuthHeaders(),
        });
        if (cancelled) return;
        const payload = data?.data ?? data;
        setDetail(payload);
        setStatus(payload.status || "pending");
        if (payload.telegram_delivery === "queued" || payload.telegram_delivery === "sent" || payload.telegram_delivery === "failed") {
          setDelivery(payload.telegram_delivery);
        } else if (payload.telegram_message_id) {
          setDelivery("sent");
        } else if (payload.telegram_delivery === null) {
          setDelivery(null);
        }
        setErr("");
        if (["approved", "rejected", "expired"].includes(payload.status)) {
          if (!terminalRef.current) {
            terminalRef.current = true;
            playApprovalDecision("refund", requestId);
            onTerminal?.();
          }
        }
      } catch (e) {
        if (!cancelled) {
          setErr(e.response?.data?.error || e.message || "تعذّر التحقق من الحالة");
        }
      }
    }

    poll();
    // Skip the request while the till is in the background. The next tick is only
    // 3s away, so a returning cashier is never left looking at stale status.
    const t = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      poll();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [open, requestId, onTerminal]);

  if (!open || !requestId) return null;

  const isTerminal = ["approved", "rejected", "expired"].includes(status);

  return (
    <div className="shift-modal-overlay" role="dialog" aria-modal="true" dir="rtl" lang="ar">
      <div className="shift-modal-backdrop" onClick={isTerminal ? onClose : undefined} aria-hidden />
      <div className="shift-modal-panel">
        <h2 className="shift-modal-title">طلب استرجاع #{requestId}</h2>
        <p className={`shift-modal-meta ${status === "approved" ? "shift-modal-success" : ""}`}>
          {STATUS_LABEL[status] || status}
        </p>
        {detail?.total_amount != null ? (
          <p className="shift-modal-meta">المبلغ: {ils(detail.total_amount)}</p>
        ) : null}
        {status === "pending" && delivery === "queued" ? (
          <p className="shift-modal-hint">جاري إرسال رسالة تيليجرام… الطلب محفوظ ولن يُعاد إنشاؤه.</p>
        ) : status === "pending" && delivery === "failed" ? (
          <p className="shift-modal-hint">تعذّر إرسال تيليجرام. الطلب محفوظ؛ أعد الإرسال أو وافق من لوحة الإدارة.</p>
        ) : status === "pending" ? (
          <p className="shift-modal-hint">جاري انتظار موافقة المدير عبر التيليجرام أو لوحة الإدارة…</p>
        ) : null}
        {retryNote ? <div className="shift-modal-err">{retryNote}</div> : null}
        {err ? <div className="shift-modal-err">{err}</div> : null}
        <div className="shift-modal-actions">
          {status === "pending" && delivery === "failed" ? (
            <button
              type="button"
              className="shift-modal-secondary"
              disabled={retrying}
              onClick={async () => {
                setRetrying(true);
                try {
                  await api.post(
                    "/api/telegram/outbound/retry",
                    { kind: "refund", request_id: requestId },
                    { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
                  );
                  setDelivery("queued");
                  setRetryNote("");
                } catch (e) {
                  setRetryNote(e.response?.data?.error || "تعذّر إعادة إرسال تيليجرام");
                } finally {
                  setRetrying(false);
                }
              }}
            >
              {retrying ? "جاري الإرسال…" : "إعادة الإرسال"}
            </button>
          ) : null}
          <button type="button" className="shift-modal-primary" onClick={onClose} disabled={!isTerminal && !err}>
            {isTerminal ? "إغلاق" : "—"}
          </button>
          {!isTerminal ? (
            <button type="button" className="shift-modal-secondary" onClick={onClose}>
              إخفاء (يستمر بالخلفية)
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
