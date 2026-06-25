import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";

const ils = (n) => `₪${Number(n ?? 0).toFixed(2)}`;

const emptyForm = {
  name: "", phone: "", phone2: "", address: "", city: "",
  price_category: "retail", credit_limit: 0, notes: "",
};

export default function CustomerManagement() {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [statement, setStatement] = useState(null);
  const [paymentAmount, setPaymentAmount] = useState("");

  const load = useCallback(async (q) => {
    setLoading(true);
    try {
      const { data } = await api.get(
        q ? `/api/customers?q=${encodeURIComponent(q)}` : "/api/customers",
        { headers: getAuthHeaders() }
      );
      setCustomers(data);
    } catch { setError("تعذّر تحميل العملاء"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function startNew() {
    setEditing(null);
    setForm(emptyForm);
    setShowForm(true);
    setMsg(null);
  }

  function startEdit(c) {
    setEditing(c);
    setForm({
      name: c.name || "", phone: c.phone || "", phone2: c.phone2 || "",
      address: c.address || "", city: c.city || "",
      price_category: c.price_category || "retail",
      credit_limit: c.credit_limit || 0, notes: c.notes || "",
    });
    setShowForm(true);
    setMsg(null);
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await api.put(`/api/customers/${editing.id}`, form, { headers: getAuthHeaders() });
      } else {
        await api.post("/api/customers", form, { headers: getAuthHeaders() });
      }
      setMsg("تم الحفظ بنجاح");
      setShowForm(false);
      load(search);
    } catch (e) {
      setError(e.response?.data?.error || "فشل الحفظ");
    } finally {
      setSaving(false);
    }
  }

  async function deleteCustomer(c) {
    if (!window.confirm(`حذف العميل "${c.name}"؟`)) return;
    try {
      await api.delete(`/api/customers/${c.id}`, { headers: getAuthHeaders() });
      setMsg("تم الحذف");
      load(search);
    } catch (e) {
      setError(e.response?.data?.error || e.message || "فشل الحذف");
    }
  }

  async function loadStatement(c) {
    const { data } = await api.get(`/api/customers/${c.id}/statement`, { headers: getAuthHeaders() });
    setStatement(data);
  }

  async function recordPayment(c) {
    const amt = Number(paymentAmount);
    if (!Number.isFinite(amt) || amt <= 0) { setError("أدخل مبلغاً صحيحاً"); return; }
    try {
      await api.post(`/api/customers/${c.id}/payment`, { amount: amt }, { headers: getAuthHeaders() });
      setMsg(`تم تسجيل دفعة ${ils(amt)} للعميل ${c.name}`);
      setPaymentAmount("");
      load(search);
    } catch (e) {
      setError(e.response?.data?.error || "فشل التسجيل");
    }
  }

  const f = (key) => (e) => setForm((p) => ({ ...p, [key]: e.target.value }));

  return (
    <div className="page-container" dir="rtl" lang="ar">
      <div className="page-header">
        <h1>إدارة العملاء</h1>
        <Link to="/checkout" className="nav-pill">← الكاشير</Link>
      </div>

      {error && <div className="error-banner" onClick={() => setError(null)}>{error} ✕</div>}
      {msg && <div className="success-banner" onClick={() => setMsg(null)}>{msg} ✕</div>}

      {statement ? (
        <div className="statement-view">
          <div className="statement-header">
            <h2>كشف حساب: {statement.customer.name}</h2>
            <div>الرصيد الحالي: <strong>{ils(statement.customer.balance)}</strong></div>
            <button className="btn-secondary" onClick={() => setStatement(null)}>إغلاق</button>
          </div>
          <table className="data-table">
            <thead>
              <tr><th>التاريخ</th><th>النوع</th><th>مدين</th><th>دائن</th><th>الرصيد</th></tr>
            </thead>
            <tbody>
              {statement.events.map((e, i) => (
                <tr key={i}>
                  <td>{e.ev_date?.slice(0, 16)}</td>
                  <td>{e.ev_type === "sale" ? "بيع" : "إرجاع"}</td>
                  <td>{e.debit > 0 ? ils(e.debit) : "—"}</td>
                  <td>{e.credit > 0 ? ils(e.credit) : "—"}</td>
                  <td>{ils(e.running_balance)}</td>
                </tr>
              ))}
              {statement.events.length === 0 && (
                <tr><td colSpan={5} className="empty-msg">لا توجد حركات</td></tr>
              )}
            </tbody>
          </table>
        </div>
      ) : showForm ? (
        <form className="customer-form" onSubmit={save}>
          <h2>{editing ? "تعديل عميل" : "عميل جديد"}</h2>
          <div className="form-grid">
            <div className="form-field"><label>الاسم *</label><input required value={form.name} onChange={f("name")} /></div>
            <div className="form-field"><label>الجوال</label><input value={form.phone} onChange={f("phone")} /></div>
            <div className="form-field"><label>جوال 2</label><input value={form.phone2} onChange={f("phone2")} /></div>
            <div className="form-field"><label>العنوان</label><input value={form.address} onChange={f("address")} /></div>
            <div className="form-field"><label>المدينة</label><input value={form.city} onChange={f("city")} /></div>
            <div className="form-field">
              <label>فئة السعر</label>
              <select value={form.price_category} onChange={f("price_category")}>
                <option value="retail">مفرق</option>
                <option value="wholesale">جملة</option>
              </select>
            </div>
            <div className="form-field">
              <label>حد الائتمان (₪)</label>
              <input type="number" min="0" value={form.credit_limit} onChange={f("credit_limit")} />
            </div>
            <div className="form-field"><label>ملاحظات</label><textarea value={form.notes} onChange={f("notes")} /></div>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn-primary" disabled={saving}>{saving ? "جاري الحفظ…" : "حفظ"}</button>
            <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>إلغاء</button>
          </div>
        </form>
      ) : (
        <>
          <div className="list-controls">
            <input placeholder="بحث بالاسم أو الجوال…" value={search}
              onChange={(e) => { setSearch(e.target.value); load(e.target.value); }} />
            <button className="btn-primary" onClick={startNew}>+ عميل جديد</button>
          </div>
          {loading ? <p>جاري التحميل…</p> : customers.length === 0 ? (
            <p className="empty-msg">لا يوجد عملاء</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr><th>الاسم</th><th>الجوال</th><th>المدينة</th><th>الرصيد</th><th>حد الائتمان</th><th>عمليات</th></tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>{c.phone || "—"}</td>
                    <td>{c.city || "—"}</td>
                    <td className={c.balance > 0 ? "negative" : ""}>{ils(c.balance)}</td>
                    <td>{c.credit_limit > 0 ? ils(c.credit_limit) : "—"}</td>
                    <td>
                      <button className="btn-link" onClick={() => startEdit(c)}>تعديل</button>
                      <button className="btn-link" onClick={() => loadStatement(c)}>كشف حساب</button>
                      {c.balance > 0 && (
                        <span className="inline-pay">
                          <input type="number" min="0.01" step="0.01" placeholder="دفعة" value={paymentAmount}
                            onChange={(e) => setPaymentAmount(e.target.value)} style={{ width: 80 }} />
                          <button className="btn-link" onClick={() => recordPayment(c)}>دفع</button>
                        </span>
                      )}
                      <button className="btn-link danger" onClick={() => deleteCustomer(c)}>حذف</button>
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
