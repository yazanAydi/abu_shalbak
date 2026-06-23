import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders, getUser, removeToken } from "../utils/auth";
import { isAdminRole } from "../utils/roles";
import "./SupplierFinance.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

const PAYMENT_METHODS = [
  { value: "transfer", ar: "تحويل" },
  { value: "cash", ar: "نقدي" },
  { value: "check", ar: "شيك" },
  { value: "other", ar: "أخرى" },
];

const OPEX_LABEL = {
  rent: "إيجار",
  utilities: "مرافق",
  salaries: "رواتب",
  delivery: "توصيل",
  fees: "عمولات/رسوم",
  other: "أخرى",
};

function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

export default function SupplierFinance() {
  const navigate = useNavigate();
  const u = getUser();
  const [err, setErr] = useState("");
  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(todayYmd);
  const [overview, setOverview] = useState(null);
  const [suppliers, setSuppliers] = useState([]);
  const [payments, setPayments] = useState([]);

  const [supForm, setSupForm] = useState({
    name: "",
    contact_phone: "",
    contact_email: "",
    notes: "",
  });
  const [editing, setEditing] = useState(null);
  const [edit, setEdit] = useState({});

  const [payForm, setPayForm] = useState({
    supplier_id: "",
    amount: "",
    paid_on: todayYmd(),
    payment_method: "transfer",
    reference_note: "",
    invoice_id: "",
  });
  const [opexList, setOpexList] = useState([]);
  const [opexForm, setOpexForm] = useState({
    category: "other",
    amount: "",
    paid_on: todayYmd(),
    payment_method: "transfer",
    reference_note: "",
  });
  const [reconDate, setReconDate] = useState(todayYmd);
  const [reconExpected, setReconExpected] = useState(null);
  const [reconForm, setReconForm] = useState({ counted_cash: "", note: "" });
  const [reconRow, setReconRow] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [invForm, setInvForm] = useState({
    supplier_id: "",
    ref_text: "",
    amount_total: "",
    amount_paid: "0",
    due_on: "",
  });
  const [refundRows, setRefundRows] = useState([]);

  const loadOverview = useCallback(async () => {
    if (!from || !to) return;
    setErr("");
    try {
      const { data } = await api.get("/api/finance/overview", {
        params: { from, to },
        headers: getAuthHeaders(),
      });
      setOverview(data);
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    }
  }, [from, to]);

  const loadSuppliers = useCallback(async () => {
    try {
      const { data } = await api.get("/api/finance/suppliers", {
        headers: getAuthHeaders(),
      });
      setSuppliers(data);
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    }
  }, []);

  const loadPayments = useCallback(async () => {
    setErr("");
    try {
      const { data } = await api.get("/api/finance/payments", {
        params: { from, to },
        headers: getAuthHeaders(),
      });
      setPayments(data);
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    }
  }, [from, to]);

  useEffect(() => {
    loadSuppliers();
  }, [loadSuppliers]);

  const loadOpex = useCallback(async () => {
    if (!from || !to) return;
    try {
      const { data } = await api.get("/api/finance/operating-expenses", {
        params: { from, to },
        headers: getAuthHeaders(),
      });
      setOpexList(data);
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    }
  }, [from, to]);

  const loadRefunds = useCallback(async () => {
    if (!from || !to) return;
    try {
      const { data } = await api.get("/api/refunds", {
        params: { from, to },
        headers: getAuthHeaders(),
      });
      setRefundRows(data);
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    }
  }, [from, to]);

  const loadInvoices = useCallback(async () => {
    try {
      const { data } = await api.get("/api/finance/invoices", { headers: getAuthHeaders() });
      setInvoices(data);
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    }
  }, []);

  const loadRecon = useCallback(async () => {
    if (!reconDate) return;
    try {
      const [ex, saved] = await Promise.all([
        api.get("/api/finance/cash/expected", {
          params: { date: reconDate },
          headers: getAuthHeaders(),
        }),
        api.get("/api/finance/cash/reconciliation", {
          params: { date: reconDate },
          headers: getAuthHeaders(),
        }),
      ]);
      setReconExpected(ex.data);
      setReconRow(saved.data);
      if (saved.data) {
        setReconForm({
          counted_cash: String(saved.data.counted_cash),
          note: saved.data.note || "",
        });
      } else {
        setReconForm({ counted_cash: "", note: "" });
      }
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    }
  }, [reconDate]);

  useEffect(() => {
    loadOverview();
    loadPayments();
    loadOpex();
    loadRefunds();
  }, [loadOverview, loadPayments, loadOpex, loadRefunds]);

  useEffect(() => {
    loadInvoices();
  }, [loadInvoices]);

  useEffect(() => {
    loadRecon();
  }, [loadRecon]);

  async function addSupplier() {
    if (!supForm.name.trim()) {
      setErr("اسم المورد مطلوب");
      return;
    }
    setErr("");
    try {
      await api.post("/api/finance/suppliers", supForm, {
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      });
      setSupForm({ name: "", contact_phone: "", contact_email: "", notes: "" });
      loadSuppliers();
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    }
  }

  function startEdit(s) {
    setEditing(s.id);
    setEdit({ ...s });
  }

  async function saveSupplier(id) {
    setErr("");
    try {
      await api.put(`/api/finance/suppliers/${id}`, edit, {
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      });
      setEditing(null);
      loadSuppliers();
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    }
  }

  async function delSupplier(id) {
    if (!window.confirm("حذف المورد؟")) return;
    setErr("");
    try {
      await api.delete(`/api/finance/suppliers/${id}`, { headers: getAuthHeaders() });
      loadSuppliers();
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    }
  }

  async function addPayment() {
    const sid = Number(payForm.supplier_id);
    if (!sid) {
      setErr("اختر مورد");
      return;
    }
    setErr("");
    try {
      await api.post(
        "/api/finance/payments",
        {
          supplier_id: sid,
          amount: Number(payForm.amount),
          paid_on: payForm.paid_on,
          payment_method: payForm.payment_method,
          reference_note: payForm.reference_note || null,
          invoice_id: payForm.invoice_id ? Number(payForm.invoice_id) : null,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      setPayForm({
        supplier_id: payForm.supplier_id,
        amount: "",
        paid_on: todayYmd(),
        payment_method: "transfer",
        reference_note: "",
        invoice_id: "",
      });
      loadPayments();
      loadOverview();
      loadInvoices();
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    }
  }

  async function delPayment(id) {
    if (!window.confirm("حذف سجل الدفع؟")) return;
    setErr("");
    try {
      await api.delete(`/api/finance/payments/${id}`, { headers: getAuthHeaders() });
      loadPayments();
      loadOverview();
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    }
  }

  async function addOpex() {
    if (!opexForm.amount) return;
    setErr("");
    try {
      await api.post(
        "/api/finance/operating-expenses",
        {
          ...opexForm,
          amount: Number(opexForm.amount),
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      setOpexForm({ category: "other", amount: "", paid_on: todayYmd(), payment_method: "transfer", reference_note: "" });
      loadOpex();
      loadOverview();
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    }
  }

  async function delOpex(id) {
    if (!window.confirm("حذف؟")) return;
    setErr("");
    try {
      await api.delete(`/api/finance/operating-expenses/${id}`, { headers: getAuthHeaders() });
      loadOpex();
      loadOverview();
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    }
  }

  async function saveRecon() {
    if (!reconForm.counted_cash) {
      setErr("أدخل المبلغ النقدي العد");
      return;
    }
    setErr("");
    try {
      const { data } = await api.post(
        "/api/finance/cash/reconciliation",
        {
          recon_date: reconDate,
          counted_cash: Number(reconForm.counted_cash),
          note: reconForm.note || null,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      setReconRow(data);
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    }
  }

  async function addInvoice() {
    if (!invForm.supplier_id || !invForm.amount_total) return;
    setErr("");
    try {
      await api.post(
        "/api/finance/invoices",
        {
          supplier_id: Number(invForm.supplier_id),
          ref_text: invForm.ref_text || null,
          amount_total: Number(invForm.amount_total),
          amount_paid: invForm.amount_paid ? Number(invForm.amount_paid) : 0,
          due_on: invForm.due_on || null,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      setInvForm({ supplier_id: "", ref_text: "", amount_total: "", amount_paid: "0", due_on: "" });
      loadInvoices();
      loadOverview();
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    }
  }

  async function downloadExport() {
    try {
      const res = await api.get("/api/finance/export.csv", {
        params: { from, to },
        headers: getAuthHeaders(),
        responseType: "blob",
      });
      const url = window.URL.createObjectURL(new Blob([res.data], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `finance-${from}-${to}.csv`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e.message || "فشل التصدير");
    }
  }

  const payMethodAr = useMemo(
    () =>
      PAYMENT_METHODS.reduce((a, o) => {
        a[o.value] = o.ar;
        return a;
      }, {}),
    []
  );

  return (
    <div className="sf-page" dir="rtl" lang="ar">
      <header className="sf-top">
        <div className="sf-nav">
          {isAdminRole(u?.role) ? (
            <>
              <Link to="/checkout" className="sf-link">
                الكاشير
              </Link>
              <Link to="/reports" className="sf-link">
                تقرير المبيعات
              </Link>
              <Link to="/manage-products" className="sf-link">
                المنتجات
              </Link>
              <Link to="/manage-users" className="sf-link">
                الحسابات
              </Link>
            </>
          ) : (
            <Link to="/reports" className="sf-link">
              تقرير المبيعات
            </Link>
          )}
        </div>
        <h1 className="sf-title">المراقبة المالية</h1>
        <p className="sf-sub">مبيعات، استرجاعات، تكاليف تقديرية، مصاريف، كاش، ذمم موردين — للمدير والمحاسب</p>
      </header>

      {err ? <div className="sf-err">{err}</div> : null}

      <section className="sf-card">
        <h2 className="sf-h2">ملخص (فاتورة نقطة البيع × دفعات الموردين)</h2>
        <div className="sf-range">
          <label>
            من
            <input
              type="date"
              className="sf-input"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            إلى
            <input
              type="date"
              className="sf-input"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="sf-btn"
            onClick={() => {
              loadOverview();
              loadPayments();
              loadOpex();
              loadRefunds();
            }}
          >
            تحديث
          </button>
          <button type="button" className="sf-btn ghost" onClick={downloadExport}>
            تصدير ملف (CSV)
          </button>
        </div>
        {overview ? (
          <div className="sf-stats">
            <div className="sf-stat">
              <div className="sf-stat-l">مبيعات كاشير (إجمالي)</div>
              <div className="sf-stat-v success">{ils(overview.pos_sales_total)}</div>
              <div className="sf-stat-s">{overview.pos_transaction_count} عملية</div>
            </div>
            <div className="sf-stat">
              <div className="sf-stat-l">استرجاعات</div>
              <div className="sf-stat-v">−{ils(overview.refunds_total || 0)}</div>
              <div className="sf-stat-s">{overview.refund_count || 0} إرجاع</div>
            </div>
            <div className="sf-stat">
              <div className="sf-stat-l">صافي مبيعات (بعد الاسترجاع)</div>
              <div className="sf-stat-v success">{ils(overview.net_pos_sales)}</div>
            </div>
            <div className="sf-stat">
              <div className="sf-stat-l">تكلفة تقديرية (بعد الاسترجاع)</div>
              <div className="sf-stat-v">{ils(overview.net_estimated_cogs || 0)}</div>
            </div>
            <div className="sf-stat">
              <div className="sf-stat-l">ربح إجمالي تقديري</div>
              <div className="sf-stat-v success">{ils(overview.estimated_gross_profit || 0)}</div>
            </div>
            <div className="sf-stat">
              <div className="sf-stat-l">مخزون (تكلفة / بيع)</div>
              <div className="sf-stat-s">
                {ils(overview.inventory_value_at_cost || 0)} / {ils(overview.inventory_value_at_retail || 0)}
              </div>
            </div>
            <div className="sf-stat">
              <div className="sf-stat-l">ذمم موردين (مفتوح)</div>
              <div className="sf-stat-v warn">{ils(overview.open_payables_total || 0)}</div>
            </div>
            <div className="sf-stat">
              <div className="sf-stat-l">مصاريف تشغيل</div>
              <div className="sf-stat-v">{ils(overview.operating_expenses_total || 0)}</div>
            </div>
            <div className="sf-stat">
              <div className="sf-stat-l">دفعات موردين (فترة)</div>
              <div className="sf-stat-v warn">{ils(overview.supplier_payments_total)}</div>
            </div>
          </div>
        ) : null}
      </section>

      <section className="sf-card">
        <h2 className="sf-h2">مصاريف التشغيل (إيجار، رواتب، …)</h2>
        <div className="sf-pay-form">
          <select
            className="sf-input"
            value={opexForm.category}
            onChange={(e) => setOpexForm((f) => ({ ...f, category: e.target.value }))}
          >
            {Object.entries(OPEX_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <input
            className="sf-input"
            type="number"
            placeholder="مبلغ"
            value={opexForm.amount}
            onChange={(e) => setOpexForm((f) => ({ ...f, amount: e.target.value }))}
          />
          <input
            className="sf-input"
            type="date"
            value={opexForm.paid_on}
            onChange={(e) => setOpexForm((f) => ({ ...f, paid_on: e.target.value }))}
          />
          <select
            className="sf-input"
            value={opexForm.payment_method}
            onChange={(e) => setOpexForm((f) => ({ ...f, payment_method: e.target.value }))}
          >
            {PAYMENT_METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.ar}
              </option>
            ))}
          </select>
          <button type="button" className="sf-btn" onClick={addOpex}>
            إضافة
          </button>
        </div>
        <div className="sf-table-wrap">
          <table className="sf-table">
            <thead>
              <tr>
                <th>الفئة</th>
                <th>التاريخ</th>
                <th>مبلغ</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {opexList.length === 0 ? (
                <tr>
                  <td colSpan={4} className="sf-empty">
                    لا سجلات
                  </td>
                </tr>
              ) : (
                opexList.map((o) => (
                  <tr key={o.id}>
                    <td>{OPEX_LABEL[o.category] || o.category}</td>
                    <td>{o.paid_on}</td>
                    <td>{ils(o.amount)}</td>
                    <td>
                      <button type="button" className="sf-btn sm danger" onClick={() => delOpex(o.id)}>
                        حذف
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="sf-card">
        <h2 className="sf-h2">تدقيق نقدي يومي (کاش)</h2>
        <p className="sf-sub sm">
          قارن المبلغ النقدي العد في الدرج مع «المتوقع» من النظام (مبيعات نقد ناقص استرجاعات نقدية).
        </p>
        <div className="sf-range">
          <label>
            التاريخ
            <input
              type="date"
              className="sf-input"
              value={reconDate}
              onChange={(e) => setReconDate(e.target.value)}
            />
          </label>
        </div>
        {reconExpected ? (
          <p>
            متوقع نقد: <strong>{ils(reconExpected.expected_cash)}</strong> — بطاقة:{" "}
            <strong>{ils(reconExpected.expected_card)}</strong>
          </p>
        ) : null}
        {reconRow ? (
          <p>
            فروق: <strong>{ils(reconRow.over_short)}</strong> (عدّت: {ils(reconRow.counted_cash)})
          </p>
        ) : null}
        <div className="sf-pay-form">
          <input
            className="sf-input"
            type="number"
            placeholder="ما عُدّ نقدياً"
            value={reconForm.counted_cash}
            onChange={(e) => setReconForm((f) => ({ ...f, counted_cash: e.target.value }))}
          />
          <input
            className="sf-input"
            placeholder="ملاحظة"
            value={reconForm.note}
            onChange={(e) => setReconForm((f) => ({ ...f, note: e.target.value }))}
          />
          <button type="button" className="sf-btn" onClick={saveRecon}>
            حفظ التدقيق
          </button>
        </div>
      </section>

      <section className="sf-card">
        <h2 className="sf-h2">فواتير موردين (ذمم / مستحقات)</h2>
        <div className="sf-form-grid">
          <select
            className="sf-input"
            value={invForm.supplier_id}
            onChange={(e) => setInvForm((f) => ({ ...f, supplier_id: e.target.value }))}
          >
            <option value="">مورد</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input
            className="sf-input"
            placeholder="مرجع فاتورة"
            value={invForm.ref_text}
            onChange={(e) => setInvForm((f) => ({ ...f, ref_text: e.target.value }))}
          />
          <input
            className="sf-input"
            type="number"
            placeholder="مبلغ إجمالي"
            value={invForm.amount_total}
            onChange={(e) => setInvForm((f) => ({ ...f, amount_total: e.target.value }))}
          />
          <input
            className="sf-input"
            type="number"
            placeholder="مدفوع"
            value={invForm.amount_paid}
            onChange={(e) => setInvForm((f) => ({ ...f, amount_paid: e.target.value }))}
          />
          <input
            className="sf-input"
            type="date"
            value={invForm.due_on}
            onChange={(e) => setInvForm((f) => ({ ...f, due_on: e.target.value }))}
          />
          <button type="button" className="sf-btn" onClick={addInvoice}>
            إضافة فاتورة
          </button>
        </div>
        <div className="sf-table-wrap">
          <table className="sf-table">
            <thead>
              <tr>
                <th>مورد</th>
                <th>مرجع</th>
                <th>إجمالي</th>
                <th>مدفوع</th>
                <th>استحقاق</th>
                <th>حالة</th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 ? (
                <tr>
                  <td colSpan={6} className="sf-empty">
                    لا فواتير
                  </td>
                </tr>
              ) : (
                invoices.map((i) => (
                  <tr key={i.id}>
                    <td>{i.supplier_name}</td>
                    <td>{i.ref_text || "—"}</td>
                    <td>{ils(i.amount_total)}</td>
                    <td>{ils(i.amount_paid)}</td>
                    <td>{i.due_on || "—"}</td>
                    <td>{i.status === "open" ? "مفتوح" : "مغلق"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="sf-card">
        <h2 className="sf-h2">سجل الاسترجاعات (الفترة)</h2>
        <p className="sf-sub" style={{ marginTop: "-0.25rem" }}>
          <Link to="/refunds">إدارة الاسترجاعات والموافقات ←</Link>
        </p>
        <div className="sf-table-wrap">
          <table className="sf-table">
            <thead>
              <tr>
                <th>تاريخ</th>
                <th>فاتورة أصل</th>
                <th>مبلغ</th>
                <th>طريقة الرد</th>
              </tr>
            </thead>
            <tbody>
              {refundRows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="sf-empty">
                    لا استرجاعات
                  </td>
                </tr>
              ) : (
                refundRows.map((r) => (
                  <tr key={r.id}>
                    <td>{(r.created_at || "").slice(0, 10)}</td>
                    <td>#{r.original_transaction_id}</td>
                    <td>{ils(r.total)}</td>
                    <td>{r.payment_method === "cash" ? "نقد" : "بطاقة"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="sf-card">
        <h2 className="sf-h2">موردو البضائع</h2>
        <div className="sf-form-grid">
          <input
            className="sf-input"
            placeholder="اسم المورد *"
            value={supForm.name}
            onChange={(e) => setSupForm((f) => ({ ...f, name: e.target.value }))}
          />
          <input
            className="sf-input"
            placeholder="هاتف"
            value={supForm.contact_phone}
            onChange={(e) => setSupForm((f) => ({ ...f, contact_phone: e.target.value }))}
          />
          <input
            className="sf-input"
            placeholder="بريد"
            value={supForm.contact_email}
            onChange={(e) => setSupForm((f) => ({ ...f, contact_email: e.target.value }))}
          />
          <input
            className="sf-input sf-input-wide"
            placeholder="ملاحظات"
            value={supForm.notes}
            onChange={(e) => setSupForm((f) => ({ ...f, notes: e.target.value }))}
          />
          <button type="button" className="sf-btn" onClick={addSupplier}>
            إضافة مورد
          </button>
        </div>

        <div className="sf-table-wrap">
          <table className="sf-table">
            <thead>
              <tr>
                <th>الاسم</th>
                <th>هاتف</th>
                <th>بريد</th>
                <th>ملاحظات</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {suppliers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="sf-empty">
                    لا موردين بعد
                  </td>
                </tr>
              ) : (
                suppliers.map((s) => (
                  <tr key={s.id}>
                    {editing === s.id ? (
                      <>
                        <td>
                          <input
                            className="sf-input"
                            value={edit.name}
                            onChange={(e) => setEdit((x) => ({ ...x, name: e.target.value }))}
                          />
                        </td>
                        <td>
                          <input
                            className="sf-input"
                            value={edit.contact_phone || ""}
                            onChange={(e) =>
                              setEdit((x) => ({ ...x, contact_phone: e.target.value }))
                            }
                          />
                        </td>
                        <td>
                          <input
                            className="sf-input"
                            value={edit.contact_email || ""}
                            onChange={(e) =>
                              setEdit((x) => ({ ...x, contact_email: e.target.value }))
                            }
                          />
                        </td>
                        <td>
                          <input
                            className="sf-input"
                            value={edit.notes || ""}
                            onChange={(e) => setEdit((x) => ({ ...x, notes: e.target.value }))}
                          />
                        </td>
                        <td className="sf-actions">
                          <button
                            type="button"
                            className="sf-btn sm"
                            onClick={() => saveSupplier(s.id)}
                          >
                            حفظ
                          </button>
                          <button
                            type="button"
                            className="sf-btn sm ghost"
                            onClick={() => setEditing(null)}
                          >
                            إلغاء
                          </button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td>{s.name}</td>
                        <td>{s.contact_phone || "—"}</td>
                        <td>{s.contact_email || "—"}</td>
                        <td className="sf-notes">{s.notes || "—"}</td>
                        <td className="sf-actions">
                          <button
                            type="button"
                            className="sf-btn sm ghost"
                            onClick={() => startEdit(s)}
                          >
                            تعديل
                          </button>
                          <button
                            type="button"
                            className="sf-btn sm danger"
                            onClick={() => delSupplier(s.id)}
                          >
                            حذف
                          </button>
                        </td>
                      </>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="sf-card">
        <h2 className="sf-h2">تسجيل دفعة لمورد (فترة الجدول = أعلاه)</h2>
        <div className="sf-pay-form">
          <label>
            مورد
            <select
              className="sf-input"
              value={payForm.supplier_id}
              onChange={(e) => setPayForm((f) => ({ ...f, supplier_id: e.target.value }))}
            >
              <option value="">— اختر —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            المبلغ
            <input
              className="sf-input"
              type="number"
              min="0.01"
              step="0.01"
              value={payForm.amount}
              onChange={(e) => setPayForm((f) => ({ ...f, amount: e.target.value }))}
            />
          </label>
          <label>
            تاريخ الدفع
            <input
              className="sf-input"
              type="date"
              value={payForm.paid_on}
              onChange={(e) => setPayForm((f) => ({ ...f, paid_on: e.target.value }))}
            />
          </label>
          <label>
            طريقة الدفع
            <select
              className="sf-input"
              value={payForm.payment_method}
              onChange={(e) => setPayForm((f) => ({ ...f, payment_method: e.target.value }))}
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.ar}
                </option>
              ))}
            </select>
          </label>
          <label className="sf-note-field">
            فاتورة مورد (اختياري — يحدّث المدفوع)
            <select
              className="sf-input"
              value={payForm.invoice_id}
              onChange={(e) => setPayForm((f) => ({ ...f, invoice_id: e.target.value }))}
            >
              <option value="">—</option>
              {invoices
                .filter(
                  (i) =>
                    !payForm.supplier_id || String(i.supplier_id) === String(payForm.supplier_id)
                )
                .filter((i) => i.status === "open")
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    #{i.id} {i.ref_text || ""} (متبقي {ils(i.amount_total - i.amount_paid)})
                  </option>
                ))}
            </select>
          </label>
          <label className="sf-note-field">
            مرجع / ملاحظة
            <input
              className="sf-input"
              value={payForm.reference_note}
              onChange={(e) => setPayForm((f) => ({ ...f, reference_note: e.target.value }))}
              placeholder="رقم فاتورة، تفاصيل…"
            />
          </label>
          <button type="button" className="sf-btn" onClick={addPayment}>
            تسجيل الدفعة
          </button>
        </div>

        <h3 className="sf-h3">سجل الدفعات (للفترة المحددة)</h3>
        <div className="sf-table-wrap">
          <table className="sf-table">
            <thead>
              <tr>
                <th>التاريخ</th>
                <th>المورد</th>
                <th>المبلغ</th>
                <th>الطريقة</th>
                <th>مرجع</th>
                <th>سجّلها</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {payments.length === 0 ? (
                <tr>
                  <td colSpan={7} className="sf-empty">
                    لا دفعات في هذه الفترة
                  </td>
                </tr>
              ) : (
                payments.map((p) => (
                  <tr key={p.id}>
                    <td>{p.paid_on}</td>
                    <td>{p.supplier_name}</td>
                    <td>{ils(p.amount)}</td>
                    <td>{payMethodAr[p.payment_method] || p.payment_method}</td>
                    <td className="sf-notes">{p.reference_note || "—"}</td>
                    <td>{p.recorded_by_username || "—"}</td>
                    <td>
                      <button
                        type="button"
                        className="sf-btn sm danger"
                        onClick={() => delPayment(p.id)}
                      >
                        حذف
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className="sf-footer">
        <button
          type="button"
          className="sf-link-bare"
          onClick={() => {
            removeToken();
            navigate("/login", { replace: true });
          }}
        >
          خروج
        </button>
        {" — "}
        {u?.username} ({u?.role})
      </p>
    </div>
  );
}
