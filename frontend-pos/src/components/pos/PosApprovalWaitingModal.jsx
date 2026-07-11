import { useEffect, useRef, useState } from "react";
import api from "../../apiClient";
import { getAuthHeaders } from "../../utils/auth";
import "../ShiftModal.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {number|null} props.requestId
 * @param {string} props.apiPath — e.g. /api/on-account-requests or /api/advance-requests
 * @param {string} props.titlePrefix
 * @param {Record<string, string>} props.statusLabels
 * @param {(detail: object) => string|null} [props.detailLine]
 * @param {() => void} props.onClose
 * @param {(detail: object) => void} [props.onTerminal]
 */
export default function PosApprovalWaitingModal({
  open,
  requestId,
  apiPath,
  titlePrefix,
  statusLabels,
  detailLine,
  onClose,
  onTerminal,
}) {
  const [status, setStatus] = useState("pending");
  const [detail, setDetail] = useState(null);
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
        const { data } = await api.get(`${apiPath}/${requestId}`, {
          headers: getAuthHeaders(),
        });
        if (cancelled) return;
        const payload = data?.data ?? data;
        setDetail(payload);
        setStatus(payload.status || "pending");
        setErr("");
        if (["approved", "rejected", "expired"].includes(payload.status)) {
          if (!terminalRef.current) {
            terminalRef.current = true;
            onTerminal?.(payload);
          }
        }
      } catch (e) {
        if (!cancelled) {
          setErr(e.response?.data?.error || e.message || "تعذّر التحقق من الحالة");
        }
      }
    }

    poll();
    const t = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [open, requestId, apiPath, onTerminal]);

  if (!open || !requestId) return null;

  const isTerminal = ["approved", "rejected", "expired"].includes(status);
  const extra = detailLine?.(detail);

  return (
    <div className="shift-modal-overlay" role="dialog" aria-modal="true" dir="rtl" lang="ar">
      <div className="shift-modal-backdrop" onClick={isTerminal ? onClose : undefined} aria-hidden />
      <div className="shift-modal-panel">
        <h2 className="shift-modal-title">
          {titlePrefix} #{requestId}
        </h2>
        <p className={`shift-modal-meta ${status === "approved" ? "shift-modal-success" : ""}`}>
          {statusLabels[status] || status}
        </p>
        {extra ? <p className="shift-modal-meta">{extra}</p> : null}
        {status === "pending" ? (
          <p className="shift-modal-hint">جاري انتظار موافقة المدير عبر التيليجرام أو لوحة الإدارة…</p>
        ) : null}
        {err ? <div className="shift-modal-err">{err}</div> : null}
        <div className="shift-modal-actions">
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

export { ils as approvalIls };
