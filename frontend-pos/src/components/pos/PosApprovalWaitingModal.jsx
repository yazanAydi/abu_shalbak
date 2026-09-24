import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import api from "../../apiClient";
import { getAuthHeaders } from "../../utils/auth";
import { useVisiblePoll } from "../../hooks/useVisiblePoll";
import { playApprovalDecision } from "../../utils/posSounds";
import "../ShiftModal.css";

const WAITING_CHIP_SLOT_ID = "pos-waiting-chip-slot";

function kindFromApiPath(apiPath) {
  const path = String(apiPath || "");
  if (path.includes("shop-consumption")) return "shop";
  if (path.includes("supplier-payment")) return "supplier";
  if (path.includes("advance")) return "advance";
  if (path.includes("customer-cash-debt")) return "cash_debt";
  if (path.includes("on-account")) return "on_account";
  return "refund";
}

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

const TERMINAL = ["approved", "rejected", "expired"];

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
  const [minimized, setMinimized] = useState(false);
  const terminalRef = useRef(false);
  const onTerminalRef = useRef(onTerminal);
  onTerminalRef.current = onTerminal;

  useEffect(() => {
    setStatus("pending");
    setDetail(null);
    setErr("");
    setMinimized(false);
    terminalRef.current = false;
  }, [open, requestId]);

  const poll = useCallback(async () => {
    if (!open || !requestId) return;
    try {
      const { data } = await api.get(`${apiPath}/${requestId}`, {
        headers: getAuthHeaders(),
        params: { _: Date.now() },
      });
      const payload = data?.data ?? data;
      if (!payload || typeof payload !== "object") return;
      setDetail(payload);
      const next = payload.status || "pending";
      setStatus(next);
      setErr("");
      if (TERMINAL.includes(next) && !terminalRef.current) {
        terminalRef.current = true;
        setMinimized(false);
        playApprovalDecision(kindFromApiPath(apiPath), requestId);
        onTerminalRef.current?.(payload);
      }
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "تعذّر التحقق من الحالة");
    }
  }, [open, requestId, apiPath]);

  useEffect(() => {
    if (open && requestId) poll();
  }, [open, requestId, poll]);

  // Keep polling even if the till tab is in the background — Telegram approval
  // often happens on another device, and the cashier must see the result.
  useVisiblePoll(poll, 2500, {
    enabled: open && !!requestId,
    hiddenIntervalMs: 2500,
  });

  if (!open || !requestId) return null;

  const isTerminal = TERMINAL.includes(status);
  const extra = detailLine?.(detail);

  if (minimized && !isTerminal) {
    const chip = (
      <button
        type="button"
        className="pos-waiting-chip"
        onClick={() => setMinimized(false)}
      >
        بانتظار الموافقة — {titlePrefix} #{requestId}
      </button>
    );
    const slot = typeof document !== "undefined" ? document.getElementById(WAITING_CHIP_SLOT_ID) : null;
    return slot ? createPortal(chip, slot) : chip;
  }

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
            <button type="button" className="shift-modal-secondary" onClick={() => setMinimized(true)}>
              إخفاء (يستمر بالخلفية)
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export { ils as approvalIls };
