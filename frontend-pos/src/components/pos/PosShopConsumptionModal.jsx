import { useEffect, useRef, useState } from "react";
import api from "../../apiClient";
import { getAuthHeaders } from "../../utils/auth";
import { ils, qty } from "../../utils/format";
import "../ShiftModal.css";

function extractApiError(err, fallback) {
  return err?.response?.data?.error || err?.message || fallback;
}

function cartPayload(cartItems) {
  return (cartItems || []).map((item) => ({
    product_id: item.id,
    unit_id: item.unitId ?? null,
    quantity: Number(item.quantity),
  }));
}

/**
 * Confirm internal shop consumption of the current cart at inventory cost.
 */
export default function PosShopConsumptionModal({ open, cartItems, onClose, onPosted, onWaiting }) {
  const [preview, setPreview] = useState(null);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState("");
  const keyRef = useRef("");

  useEffect(() => {
    if (!open) return undefined;
    keyRef.current =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `shop-use-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setReason("");
    setPreview(null);
    setError("");
    let cancelled = false;
    setPreviewing(true);
    api
      .post(
        "/api/pos/shop-consumption/preview",
        { items: cartPayload(cartItems) },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      )
      .then(({ data }) => {
        if (!cancelled) setPreview(data?.data ?? data);
      })
      .catch((err) => {
        if (!cancelled) setError(extractApiError(err, "تعذّر حساب تكلفة الاستهلاك"));
      })
      .finally(() => {
        if (!cancelled) setPreviewing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cartItems]);

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!preview || loading) return;
    setLoading(true);
    setError("");
    try {
      const { data } = await api.post(
        "/api/pos/shop-consumption",
        {
          items: cartPayload(cartItems),
          reason: reason.trim() || null,
          idempotency_key: keyRef.current,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      const payload = data?.data ?? data;
      if (payload?.pending_approval && payload?.request_id) {
        onWaiting?.(payload.request_id, { telegram: payload.telegram === true });
        return;
      }
      onPosted?.();
    } catch (err) {
      setError(extractApiError(err, "فشل ترحيل مصاريف المحل"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="shift-modal-overlay" role="dialog" aria-modal="true" dir="rtl" lang="ar">
      <div className="shift-modal-backdrop" onClick={loading ? undefined : onClose} aria-hidden />
      <form className="shift-modal-panel shift-modal-panel--form" onSubmit={handleSubmit}>
        <h2 className="shift-modal-title">ترحيل كمصاريف محل</h2>
        <p className="shift-modal-lead">
          يُرسل الطلب للموافقة. لا يُخصم المخزون ولا يُسجَّل المصروف قبل الموافقة، ولا تتحرك نقدية الصندوق.
        </p>

        {previewing ? <p className="shift-modal-lead">جاري حساب التكلفة…</p> : null}

        {preview ? (
          <>
            <table className="shift-modal-table">
              <thead>
                <tr>
                  <th>الصنف</th>
                  <th>الكمية</th>
                  <th>التكلفة</th>
                  <th>الإجمالي</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((line) => (
                  <tr key={`${line.product_id}-${line.unit_name}`}>
                    <td>{line.name}</td>
                    <td>
                      {qty(line.quantity)} {line.unit_name || ""}
                    </td>
                    <td>{ils(line.unit_cost)}</td>
                    <td>{ils(line.line_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="shift-modal-lead">إجمالي التكلفة: {ils(preview.total_cost)}</p>
          </>
        ) : null}

        <label className="shift-modal-label">
          السبب (اختياري)
          <input
            className="shift-modal-input"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="مثال: مواد تنظيف للاستخدام الداخلي"
          />
        </label>

        {error ? <div className="shift-modal-err">{error}</div> : null}

        <div className="shift-modal-actions">
          <button type="button" className="shift-modal-secondary" onClick={onClose} disabled={loading}>
            إلغاء
          </button>
          <button type="submit" className="shift-modal-primary" disabled={loading || previewing || !preview}>
            {loading ? "جاري الترحيل…" : "تأكيد الترحيل"}
          </button>
        </div>
      </form>
    </div>
  );
}
