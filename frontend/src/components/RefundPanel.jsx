import { useCallback, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import "./RefundPanel.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

const PM_AR = { cash: "نقد", visa: "بطاقة" };

export default function RefundPanel({ shiftReady = true, onRefundSuccess }) {
  const [tid, setTid] = useState("");
  const [lookup, setLookup] = useState(null);
  const [qtyByPid, setQtyByPid] = useState({});
  const [reason, setReason] = useState("");
  const [pm, setPm] = useState("cash");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState("");

  const load = useCallback(async () => {
    if (!shiftReady) {
      setErr("افتح وردية أولاً لتسجيل الاسترجاع");
      return;
    }
    const id = Number(tid);
    if (!id) {
      setErr("أدخل رقم الفاتورة");
      return;
    }
    setErr("");
    setDone("");
    setLoading(true);
    try {
      const { data } = await api.get(`/api/refunds/lookup/${id}`, {
        headers: getAuthHeaders(),
      });
      setLookup(data);
      const q = {};
      for (const L of data.lines || []) {
        q[L.product_id] = 0;
      }
      setQtyByPid(q);
    } catch (e) {
      setLookup(null);
      setErr(e.response?.data?.error || e.message || "لم يُعثر على الفاتورة");
    } finally {
      setLoading(false);
    }
  }, [tid, shiftReady]);

  async function submitRefund() {
    if (!shiftReady) {
      setErr("افتح وردية أولاً");
      return;
    }
    if (!lookup) return;
    const lines = [];
    for (const L of lookup.lines) {
      const q = Number(qtyByPid[L.product_id]) || 0;
      if (q > 0) lines.push({ product_id: L.product_id, quantity: q });
    }
    if (lines.length === 0) {
      setErr("حدد كمية للإرجاع");
      return;
    }
    setErr("");
    setLoading(true);
    try {
      const { data } = await api.post(
        "/api/refunds",
        {
          original_transaction_id: lookup.transaction_id,
          lines,
          reason: reason || null,
          payment_method: pm,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      setDone(data?.message || "تم إرسال طلب الاسترجاع.");
      setLookup(null);
      setTid("");
      setReason("");
      onRefundSuccess?.();
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "فشل");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`rf-panel ${!shiftReady ? "rf-panel--disabled" : ""}`} dir="rtl">
      <h3 className="rf-title">استرجاع (رقم الفاتورة)</h3>
      {!shiftReady ? (
        <p className="rf-muted">يجب بدء الوردية قبل استخدام الاسترجاع.</p>
      ) : null}
      <div className="rf-row">
        <input
          className="rf-input"
          type="number"
          min="1"
          placeholder="رقم الفاتورة"
          value={tid}
          onChange={(e) => setTid(e.target.value)}
          disabled={!shiftReady}
        />
        <button type="button" className="rf-btn" onClick={load} disabled={loading || !shiftReady}>
          عرض
        </button>
      </div>
      {err ? <div className="rf-err">{err}</div> : null}
      {done ? <div className="rf-ok">{done}</div> : null}
      {lookup ? (
        <div className="rf-detail">
          <p className="rf-meta">
            بتاريخ {lookup.created_at} — الدفع الأصلي: {PM_AR[lookup.payment_method] || lookup.payment_method} — {ils(lookup.total)}
          </p>
          <table className="rf-table">
            <thead>
              <tr>
                <th>المنتج</th>
                <th>متاح للإرجاع</th>
                <th>كمية</th>
              </tr>
            </thead>
            <tbody>
              {lookup.lines.map((L) => (
                <tr key={L.product_id}>
                  <td>{L.name}</td>
                  <td>{L.quantity_returnable}</td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      max={L.quantity_returnable}
                      className="rf-input sm"
                      value={qtyByPid[L.product_id] ?? 0}
                      disabled={!shiftReady}
                      onChange={(e) =>
                        setQtyByPid((m) => ({
                          ...m,
                          [L.product_id]: e.target.value,
                        }))
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <label className="rf-lb">
            طريقة رد المبلغ للزبون
            <select
              className="rf-input"
              value={pm}
              onChange={(e) => setPm(e.target.value)}
              disabled={!shiftReady}
            >
              <option value="cash">نقد</option>
              <option value="visa">بطاقة</option>
            </select>
          </label>
          <label className="rf-lb">
            سبب (اختياري)
            <input
              className="rf-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={!shiftReady}
            />
          </label>
          <button
            type="button"
            className="rf-btn primary"
            onClick={submitRefund}
            disabled={loading || !shiftReady}
          >
            تنفيذ الاسترجاع
          </button>
        </div>
      ) : null}
    </div>
  );
}
