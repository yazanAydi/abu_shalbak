import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { voucherPartyName } from "../utils/partySearch";
import PartyPicker from "../components/PartyPicker";

const ils = (n) => `₪${Number(n ?? 0).toFixed(2)}`;
const TYPE_AR = { receipt: "سند قبض", payment: "سند صرف" };
const STATUS_AR = { draft: "مسودة", posted: "مرحّل" };

const emptyLine = { line_type: "cash", amount: "", currency: "NIS", bank_name: "", description: "" };

function resetForm(setLines, setNotes, setParty) {
  setLines([{ ...emptyLine }]);
  setNotes("");
  setParty(null);
}

export default function VouchersPage() {
  const [vouchers, setVouchers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [voucherType, setVoucherType] = useState("receipt");
  const [voucherDate, setVoucherDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState([{ ...emptyLine }]);
  const [party, setParty] = useState(null);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState(null);
  const [filter, setFilter] = useState({ type: "", status: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (filter.type) q.set("type", filter.type);
      if (filter.status) q.set("status", filter.status);
      const { data } = await api.get(`/api/vouchers?${q}`, { headers: getAuthHeaders() });
      setVouchers(data);
    } catch { setError("تعذّر تحميل السندات"); }
    finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  function addLine() { setLines((p) => [...p, { ...emptyLine }]); }
  function removeLine(i) { setLines((p) => p.filter((_, idx) => idx !== i)); }
  function updateLine(i, key, val) {
    setLines((p) => {
      const n = [...p];
      const line = { ...n[i], [key]: val };
      if (key === "line_type" && val !== "check") line.bank_name = "";
      n[i] = line;
      return n;
    });
  }

  async function submit(e) {
    e.preventDefault();
    if (!party) {
      setError("يرجى اختيار الاسم (زبون أو مورد)");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/vouchers", {
        voucher_type: voucherType,
        voucher_date: voucherDate,
        notes,
        lines: lines.map((L) => ({
          ...L,
          amount: Number(L.amount),
          customer_id: party.type === "customer" ? party.id : null,
          supplier_id: party.type === "supplier" ? party.id : null,
        })),
      }, { headers: getAuthHeaders() });
      setMsg("تم إنشاء السند");
      setShowForm(false);
      resetForm(setLines, setNotes, setParty);
      load();
    } catch (e) {
      setError(e.response?.data?.error || "فشل الإنشاء");
    } finally {
      setSaving(false);
    }
  }

  async function postVoucher(v) {
    if (!window.confirm(`ترحيل السند #${v.id}؟ لا يمكن التراجع.`)) return;
    try {
      await api.post(`/api/vouchers/${v.id}/post`, {}, { headers: getAuthHeaders() });
      setMsg("تم الترحيل");
      load();
    } catch (e) {
      setError(e.response?.data?.error || "فشل الترحيل");
    }
  }

  async function deleteVoucher(v) {
    if (!window.confirm(`حذف السند #${v.id}؟`)) return;
    try {
      await api.delete(`/api/vouchers/${v.id}`, { headers: getAuthHeaders() });
      setMsg("تم الحذف");
      load();
    } catch (e) {
      setError(e.response?.data?.error || "فشل الحذف");
    }
  }

  async function loadDetail(v) {
    const { data } = await api.get(`/api/vouchers/${v.id}`, { headers: getAuthHeaders() });
    setDetail(data);
  }

  const total = lines.reduce((s, L) => s + (Number(L.amount) || 0), 0);

  return (
    <div className="page-container" dir="rtl" lang="ar">
      <div className="page-header">
        <h1>سندات القبض والصرف</h1>
        <Link to="/checkout" className="nav-pill">← الكاشير</Link>
      </div>

      {error && <div className="error-banner" onClick={() => setError(null)}>{error} ✕</div>}
      {msg && <div className="success-banner" onClick={() => setMsg(null)}>{msg} ✕</div>}

      {detail ? (
        <div className="voucher-detail">
          <div className="detail-header">
            <h2>{TYPE_AR[detail.voucher_type]} رقم {detail.voucher_no} — {STATUS_AR[detail.status]}</h2>
            <div>التاريخ: {detail.voucher_date} | المجموع: <strong>{ils(detail.total_amount)}</strong></div>
            {voucherPartyName(detail) && <div>الاسم: <strong>{voucherPartyName(detail)}</strong></div>}
            {detail.notes && <div>ملاحظات: {detail.notes}</div>}
            <button className="btn-secondary" onClick={() => setDetail(null)}>إغلاق</button>
          </div>
          <table className="data-table">
            <thead>
              <tr><th>النوع</th><th>المبلغ</th><th>العملة</th><th>البنك</th><th>البيان</th></tr>
            </thead>
            <tbody>
              {detail.lines?.map((L, i) => (
                <tr key={i}>
                  <td>{L.line_type === "cash" ? "نقدي" : L.line_type === "check" ? "شيك" : "بنك"}</td>
                  <td>{ils(L.amount_nis)}</td>
                  <td>{L.currency}</td>
                  <td>{L.line_type === "check" ? L.bank_name || "—" : "—"}</td>
                  <td>{L.description || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : showForm ? (
        <form className="voucher-form" onSubmit={submit}>
          <h2>سند جديد</h2>
          <div className="form-grid">
            <div className="form-field">
              <label>النوع</label>
              <select value={voucherType} onChange={(e) => setVoucherType(e.target.value)}>
                <option value="receipt">سند قبض</option>
                <option value="payment">سند صرف</option>
              </select>
            </div>
            <div className="form-field"><label>التاريخ</label>
              <input type="date" value={voucherDate} onChange={(e) => setVoucherDate(e.target.value)} />
            </div>
            <div className="form-field">
              <label>الاسم</label>
              <PartyPicker value={party} onPick={setParty} placeholder="ابحث بالاسم أو الرقم…" />
            </div>
            <div className="form-field" style={{ gridColumn: "1/-1" }}>
              <label>ملاحظات</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>

          <h3>أسطر السند</h3>
          {lines.map((L, i) => (
            <div key={i} className="voucher-line-row">
              <select value={L.line_type} onChange={(e) => updateLine(i, "line_type", e.target.value)}>
                <option value="cash">نقدي</option>
                <option value="check">شيك</option>
                <option value="bank">بنك</option>
              </select>
              <input type="number" min="0.01" step="0.01" placeholder="المبلغ *" required
                value={L.amount} onChange={(e) => updateLine(i, "amount", e.target.value)} />
              <select value={L.currency} onChange={(e) => updateLine(i, "currency", e.target.value)}>
                <option value="NIS">₪</option>
                <option value="USD">$</option>
                <option value="JOD">د.أ</option>
              </select>
              {L.line_type === "check" && (
                <input
                  placeholder="اسم البنك"
                  value={L.bank_name}
                  onChange={(e) => updateLine(i, "bank_name", e.target.value)}
                />
              )}
              <input placeholder="بيان" value={L.description}
                onChange={(e) => updateLine(i, "description", e.target.value)} />
              {lines.length > 1 && (
                <button type="button" className="btn-link danger" onClick={() => removeLine(i)}>✕</button>
              )}
            </div>
          ))}
          <div className="voucher-total">المجموع: <strong>{ils(total)}</strong></div>
          <button type="button" className="btn-secondary" onClick={addLine}>+ سطر</button>

          <div className="form-actions">
            <button type="submit" className="btn-primary" disabled={saving}>{saving ? "جاري الحفظ…" : "حفظ كمسودة"}</button>
            <button type="button" className="btn-secondary" onClick={() => { setShowForm(false); resetForm(setLines, setNotes, setParty); }}>إلغاء</button>
          </div>
        </form>
      ) : (
        <>
          <div className="filter-row">
            <select value={filter.type} onChange={(e) => setFilter((p) => ({ ...p, type: e.target.value }))}>
              <option value="">كل الأنواع</option>
              <option value="receipt">قبض</option>
              <option value="payment">صرف</option>
            </select>
            <select value={filter.status} onChange={(e) => setFilter((p) => ({ ...p, status: e.target.value }))}>
              <option value="">كل الحالات</option>
              <option value="draft">مسودة</option>
              <option value="posted">مرحّل</option>
            </select>
            <button className="btn-primary" onClick={() => { setParty(null); setShowForm(true); }}>+ سند جديد</button>
          </div>

          {loading ? <p>جاري التحميل…</p> : vouchers.length === 0 ? (
            <p className="empty-msg">لا توجد سندات</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr><th>رقم</th><th>النوع</th><th>التاريخ</th><th>المجموع</th><th>الحالة</th><th>عمليات</th></tr>
              </thead>
              <tbody>
                {vouchers.map((v) => (
                  <tr key={v.id}>
                    <td>{v.voucher_no}</td>
                    <td>{TYPE_AR[v.voucher_type]}</td>
                    <td>{v.voucher_date}</td>
                    <td>{ils(v.total_amount)}</td>
                    <td>{STATUS_AR[v.status]}</td>
                    <td>
                      <button className="btn-link" onClick={() => loadDetail(v)}>عرض</button>
                      {v.status === "draft" && (
                        <>
                          <button className="btn-link" onClick={() => postVoucher(v)}>ترحيل</button>
                          <button className="btn-link danger" onClick={() => deleteVoucher(v)}>حذف</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
