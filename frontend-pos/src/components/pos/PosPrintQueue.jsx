import { useCallback, useRef, useState } from "react";
import api from "../../apiClient";
import { getAuthHeaders } from "../../utils/auth";
import { useVisiblePoll } from "../../hooks/useVisiblePoll";
import { printHtmlViaWindowsHelper } from "../../utils/windowsReceiptPrint";

const FAILED =
  "تم حفظ العملية وتعذرت الطباعة. لا تُعد إدخال العملية؛ استخدم إعادة الطباعة.";

function payloadOf(res) {
  return res?.data?.data ?? res?.data ?? null;
}

/**
 * Claims pending receipts for this cashier and sends them to the local helper once.
 * A failed or uncertain helper call is not claimed again.
 */
export default function PosPrintQueue() {
  const [notice, setNotice] = useState("");
  const [failedId, setFailedId] = useState(null);
  const busy = useRef(false);

  const poll = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const claimed = await api.post(
        "/api/pos/print-jobs/claim",
        {},
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      const job = payloadOf(claimed);
      if (!job?.id || !job.receipt_html) return;
      let outcome = "failed";
      try {
        const printed = await printHtmlViaWindowsHelper(job.receipt_html, { transactionId: job.id });
        outcome = printed?.ok ? "accepted" : "failed";
      } catch {
        outcome = "failed";
      }
      const result = await api.post(
        `/api/pos/print-jobs/${job.id}/result`,
        { outcome },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      if (outcome !== "accepted") {
        setFailedId(job.id);
        setNotice(payloadOf(result)?.message || FAILED);
      }
    } catch {
      /* leave the job pending if it was never claimed */
    } finally {
      busy.current = false;
    }
  }, []);

  useVisiblePoll(poll, 4000);

  async function reprint() {
    if (!failedId) return;
    try {
      const res = await api.post(
        `/api/pos/print-jobs/${failedId}/reprint`,
        {},
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      const job = payloadOf(res);
      const printed = await printHtmlViaWindowsHelper(job?.receipt_html, { transactionId: failedId });
      if (!printed?.ok) setNotice(printed?.error || FAILED);
      else setNotice("");
    } catch (err) {
      setNotice(err?.response?.data?.error || FAILED);
    }
  }

  if (!notice) return null;
  return (
    <div className="pos-action-error" role="status">
      <div>{notice}</div>
      {failedId ? (
        <button type="button" className="pos-toolbar-btn" onClick={reprint}>
          إعادة الطباعة
        </button>
      ) : null}
    </div>
  );
}
