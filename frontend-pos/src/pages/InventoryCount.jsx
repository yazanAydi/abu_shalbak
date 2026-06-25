import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { searchProductsApi } from "../utils/productSearch";

export default function InventoryCount() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
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

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return undefined;
    }

    setSearchLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const rows = await searchProductsApi(q, { limit: 15 });
        setSearchResults(rows);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);

    return () => window.clearTimeout(timer);
  }, [search]);

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
      setSearch("");
      setSearchResults([]);
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

  return (
    <div className="page-container" dir="rtl" lang="ar">
      <div className="page-header">
        <h1>الجرد والمخزون</h1>
        <div className="header-actions">
          <Link to="/expiry" className="nav-pill">تقرير الصلاحية</Link>
          <Link to="/checkout" className="nav-pill">← الكاشير</Link>
        </div>
      </div>

      {error && <div className="error-banner" onClick={() => setError(null)}>{error} ✕</div>}
      {msg && <div className="success-banner" onClick={() => setMsg(null)}>{msg} ✕</div>}

      {activeSession ? (
        <div className="inventory-session">
          <div className="session-header">
            <h2>جلسة جرد #{activeSession.id} — {activeSession.status === "open" ? "مفتوحة" : activeSession.status}</h2>
            <div className="session-actions">
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
              <input
                type="text"
                placeholder="ابحث عن منتج بالاسم أو الباركود…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {searchLoading && search.trim().length >= 2 && (
                <p className="empty-msg" style={{ marginTop: 8 }}>جاري البحث…</p>
              )}
              {!searchLoading && searchResults.length > 0 && (
                <ul className="search-dropdown">
                  {searchResults.map((p) => (
                    <li key={p.id} onClick={() => { setSelectedProduct(p); setSearchResults([]); setSearch(p.name); }}>
                      {p.name} — {p.matched_barcode || p.barcode} (نظام: {p.stock})
                    </li>
                  ))}
                </ul>
              )}
              {selectedProduct && (
                <div className="count-product-row">
                  <span>{selectedProduct.name}</span>
                  <span>رصيد النظام: {selectedProduct.stock}</span>
                  <input
                    type="number"
                    min="0"
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
          <div className="list-actions">
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
    </div>
  );
}
