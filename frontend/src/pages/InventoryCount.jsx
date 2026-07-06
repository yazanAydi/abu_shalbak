import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import ProductPicker from "../components/ProductPicker";
import QtyStepper from "../components/QtyStepper";
import { ReportToolbar } from "../components/ui";

const SESSION_COLUMNS = [
  { key: "id", header: "رقم" },
  {
    key: "status",
    header: "الحالة",
    value: (s) => (s.status === "open" ? "مفتوح" : s.status === "posted" ? "مرحّل" : "ملغي"),
  },
  { key: "created_at", header: "أُنشئ في", value: (s) => s.created_at?.slice(0, 16) || "—" },
  { key: "created_by_name", header: "بواسطة", value: (s) => s.created_by_name || "—" },
];

const LINE_COLUMNS = [
  { key: "name", header: "المنتج" },
  { key: "barcode", header: "الباركود" },
  { key: "system_qty", header: "رصيد النظام" },
  { key: "counted_qty", header: "المعدود" },
  {
    key: "variance",
    header: "الفرق",
    value: (L) => `${L.variance > 0 ? "+" : ""}${L.variance}`,
  },
];

const ils = (n) => `₪${Number(n ?? 0).toFixed(2)}`;

export default function InventoryCount({ embedded = false }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [countedQty, setCountedQty] = useState("");
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const loadSessions = useCallback(async () => {
    try {
      const { data } = await api.get("/api/inventory/counts", { headers: getAuthHeaders() });
      setSessions(data);
    } catch {
      setError("تعذّر تحميل جلسات الجرد");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  async function loadSession(id) {
    const { data } = await api.get(`/api/inventory/counts/${id}`, { headers: getAuthHeaders() });
    setActiveSession(data);
  }

  async function openNew() {
    setError(null);
    setMsg(null);
    try {
      await api.post("/api/inventory/counts", {}, { headers: getAuthHeaders() });
      await loadSessions();
      setMsg("فُتحت جلسة جرد جديدة");
    } catch (e) {
      setError(e.response?.data?.error || "فشل فتح جلسة");
    }
  }

  async function addCountLine(session, product) {
    if (!countedQty || isNaN(Number(countedQty))) return;
    setSaving(true);
    try {
      await api.post(
        `/api/inventory/counts/${session.id}/lines`,
        { product_id: product.id, counted_qty: Number(countedQty) },
        { headers: getAuthHeaders() }
      );
      await loadSession(session.id);
      setSelectedProduct(null);
      setCountedQty("");
      setMsg("تم حفظ الكمية");
    } catch (e) {
      setError(e.response?.data?.error || "فشل الحفظ");
    } finally {
      setSaving(false);
    }
  }

  async function postSession(session) {
    if (!window.confirm("هل تريد ترحيل الجرد وتحديث المخزون؟ لا يمكن التراجع عن هذه الخطوة.")) return;
    setSaving(true);
    try {
      await api.post(`/api/inventory/counts/${session.id}/post`, {}, { headers: getAuthHeaders() });
      await loadSessions();
      setActiveSession(null);
      setMsg("تم ترحيل الجرد وتحديث المخزون");
    } catch (e) {
      setError(e.response?.data?.error || "فشل الترحيل");
    } finally {
      setSaving(false);
    }
  }

  const reportConfig = useMemo(() => {
    if (activeSession) {
      return {
        title: `جلسة جرد #${activeSession.id}`,
        columns: LINE_COLUMNS,
        rows: activeSession.lines || [],
        filename: `inventory-count-${activeSession.id}`,
      };
    }
    return {
      title: "جلسات الجرد",
      columns: SESSION_COLUMNS,
      rows: sessions,
      filename: "inventory-count-sessions",
    };
  }, [activeSession, sessions]);

  const content = (
    <>
      {error && <div className="error-banner" onClick={() => setError(null)}>{error} ✕</div>}
      {msg && <div className="success-banner" onClick={() => setMsg(null)}>{msg} ✕</div>}

      {activeSession ? (
        <div className="inventory-session">
          <div className="session-header">
            <h2>جلسة جرد #{activeSession.id} — {activeSession.status === "open" ? "مفتوحة" : activeSession.status}</h2>
            <div className="session-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <ReportToolbar
                title={reportConfig.title}
                columns={reportConfig.columns}
                rows={reportConfig.rows}
                filename={reportConfig.filename}
              />
              {activeSession.status === "open" && (
                <button className="btn-danger" onClick={() => postSession(activeSession)} disabled={saving}>
                  ترحيل الجرد
                </button>
              )}
              <button className="btn-secondary" onClick={() => setActiveSession(null)}>رجوع للقائمة</button>
            </div>
          </div>

          {activeSession.status === "open" && (
            <div className="count-input-area">
              <h3>إضافة صنف</h3>
              <ProductPicker onPick={setSelectedProduct} />
              {selectedProduct && (
                <div className="count-product-row">
                  <span>{selectedProduct.name}</span>
                  <span>رصيد النظام: {selectedProduct.stock}</span>
                  <QtyStepper
                    min={0}
                    placeholder="الكمية المعدودة"
                    value={countedQty}
                    onChange={(e) => setCountedQty(e.target.value)}
                  />
                  <button onClick={() => addCountLine(activeSession, selectedProduct)} disabled={saving}>
                    حفظ
                  </button>
                </div>
              )}
            </div>
          )}

          <h3>أسطر الجرد ({activeSession.lines?.length || 0})</h3>
          {activeSession.lines?.length > 0 ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>المنتج</th>
                  <th>الباركود</th>
                  <th>رصيد النظام</th>
                  <th>المعدود</th>
                  <th>الفرق</th>
                </tr>
              </thead>
              <tbody>
                {activeSession.lines.map((L) => (
                  <tr key={L.id} className={L.variance !== 0 ? "variance-row" : ""}>
                    <td>{L.name}</td>
                    <td>{L.barcode}</td>
                    <td>{L.system_qty}</td>
                    <td>{L.counted_qty}</td>
                    <td className={L.variance > 0 ? "positive" : L.variance < 0 ? "negative" : ""}>
                      {L.variance > 0 ? "+" : ""}{L.variance}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="empty-msg">لا توجد أسطر جرد بعد</p>
          )}
        </div>
      ) : (
        <div className="sessions-list">
          <div className="list-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <ReportToolbar
              title={reportConfig.title}
              columns={reportConfig.columns}
              rows={reportConfig.rows}
              filename={reportConfig.filename}
              disabled={loading}
            />
            <button className="btn-primary" onClick={openNew}>+ فتح جلسة جرد جديدة</button>
          </div>
          {loading ? (
            <p>جاري التحميل…</p>
          ) : sessions.length === 0 ? (
            <p className="empty-msg">لا توجد جلسات جرد</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr><th>رقم</th><th>الحالة</th><th>أُنشئ في</th><th>بواسطة</th><th>عمليات</th></tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{s.id}</td>
                    <td>{s.status === "open" ? "مفتوح" : s.status === "posted" ? "مرحّل" : "ملغي"}</td>
                    <td>{s.created_at?.slice(0, 16)}</td>
                    <td>{s.created_by_name || "—"}</td>
                    <td>
                      <button className="btn-link" onClick={() => loadSession(s.id).then(() => {})}>
                        عرض
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );

  if (embedded) return content;
  return (
    <div className="office-page page-container" dir="rtl" lang="ar">
      <div className="page-header">
        <h1>الجرد والمخزون</h1>
      </div>
      {content}
    </div>
  );
}
