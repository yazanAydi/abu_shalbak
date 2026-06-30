import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { PageHeader, ReportToolbar, Select } from "../components/ui";

const ils = (n, cur) => `${cur || "₪"}${Number(n ?? 0).toFixed(2)}`;

const STATUS_AR = { pending: "قيد الانتظار", cleared: "مصروف/مقبوض", bounced: "مرتد", cancelled: "ملغي" };
const TYPE_AR = { received: "شيك مستلم", issued: "شيك صادر" };

const CHECK_COLUMNS = [
  { key: "check_type", header: "النوع", value: (c) => TYPE_AR[c.check_type] },
  { key: "check_no", header: "رقم", value: (c) => c.check_no || "—" },
  { key: "bank_name", header: "البنك", value: (c) => c.bank_name || "—" },
  {
    key: "amount",
    header: "المبلغ",
    value: (c) => ils(c.amount, c.currency === "NIS" ? "₪" : c.currency),
  },
  { key: "due_date", header: "الاستحقاق", value: (c) => c.due_date || "—" },
  { key: "status", header: "الحالة", value: (c) => STATUS_AR[c.status] },
];

const ACCOUNT_COLUMNS = [
  { key: "name", header: "الاسم" },
  { key: "bank_name", header: "البنك", value: (a) => a.bank_name || "—" },
  { key: "account_no", header: "رقم الحساب", value: (a) => a.account_no || "—" },
  { key: "currency", header: "العملة" },
  {
    key: "balance",
    header: "الرصيد",
    value: (a) => ils(a.balance, a.currency === "NIS" ? "₪" : a.currency),
  },
];
const emptyCheck = {
  check_type: "received", check_no: "", bank_name: "", branch: "",
  amount: "", currency: "NIS", due_date: "",
  customer_id: "", supplier_id: "", bank_account_id: "", notes: "",
};

export default function BanksChecks() {
  const [tab, setTab] = useState("checks");
  const [checks, setChecks] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [showCheckForm, setShowCheckForm] = useState(false);
  const [checkForm, setCheckForm] = useState(emptyCheck);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState({ status: "", type: "" });

  const loadChecks = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (filter.status) q.set("status", filter.status);
      if (filter.type) q.set("type", filter.type);
      const { data } = await api.get(`/api/banks/checks?${q}`, { headers: getAuthHeaders() });
      setChecks(data);
    } catch { setError("تعذّر تحميل الشيكات"); }
    finally { setLoading(false); }
  }, [filter]);

  const loadAccounts = useCallback(async () => {
    const { data } = await api.get("/api/banks/accounts", { headers: getAuthHeaders() });
    setAccounts(data);
  }, []);

  useEffect(() => { loadChecks(); loadAccounts(); }, [loadChecks, loadAccounts]);

  async function addCheck(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post("/api/banks/checks", {
        ...checkForm,
        amount: Number(checkForm.amount),
        customer_id: checkForm.customer_id || undefined,
        supplier_id: checkForm.supplier_id || undefined,
        bank_account_id: checkForm.bank_account_id || undefined,
      }, { headers: getAuthHeaders() });
      setMsg("تم تسجيل الشيك");
      setShowCheckForm(false);
      setCheckForm(emptyCheck);
      loadChecks();
    } catch (e) {
      setError(e.response?.data?.error || "فشل التسجيل");
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(check, status) {
    try {
      await api.patch(`/api/banks/checks/${check.id}/status`, { status }, { headers: getAuthHeaders() });
      setMsg("تم تحديث الحالة");
      loadChecks();
    } catch (e) {
      setError(e.response?.data?.error || "فشل التحديث");
    }
  }

  const fc = (key) => (e) => setCheckForm((p) => ({ ...p, [key]: e.target.value }));

  const reportConfig = useMemo(() => {
    if (tab === "accounts") {
      return {
        title: "الحسابات البنكية",
        columns: ACCOUNT_COLUMNS,
        rows: accounts,
        filename: "bank-accounts",
      };
    }
    return {
      title: "الشيكات",
      columns: CHECK_COLUMNS,
      rows: checks,
      filename: "bank-checks",
    };
  }, [tab, checks, accounts]);

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title="البنوك والشيكات"
        subtitle="الحسابات البنكية والشيكات"
        icon="banks"
        actions={
          <ReportToolbar
            title={reportConfig.title}
            columns={reportConfig.columns}
            rows={reportConfig.rows}
            filename={reportConfig.filename}
            disabled={loading && tab === "checks"}
          />
        }
      />

      {error && <div className="error-banner" onClick={() => setError(null)}>{error} ✕</div>}
      {msg && <div className="success-banner" onClick={() => setMsg(null)}>{msg} ✕</div>}

      <div className="tab-bar">
        <button className={tab === "checks" ? "tab active" : "tab"} onClick={() => setTab("checks")}>الشيكات</button>
        <button className={tab === "accounts" ? "tab active" : "tab"} onClick={() => setTab("accounts")}>الحسابات البنكية</button>
      </div>

      {tab === "checks" && (
        <>
          <div className="filter-row">
            <Select value={filter.type} onChange={(e) => setFilter((p) => ({ ...p, type: e.target.value }))}>
              <option value="">كل الأنواع</option>
              <option value="received">مستلمة</option>
              <option value="issued">صادرة</option>
            </Select>
            <Select value={filter.status} onChange={(e) => setFilter((p) => ({ ...p, status: e.target.value }))}>
              <option value="">كل الحالات</option>
              <option value="pending">قيد الانتظار</option>
              <option value="cleared">مصروف</option>
              <option value="bounced">مرتد</option>
              <option value="cancelled">ملغي</option>
            </Select>
            <button className="btn-primary" onClick={() => setShowCheckForm(true)}>+ شيك جديد</button>
          </div>

          {showCheckForm && (
            <form className="check-form" onSubmit={addCheck}>
              <h3>تسجيل شيك جديد</h3>
              <div className="form-grid">
                <div className="form-field">
                  <label>النوع</label>
                  <Select value={checkForm.check_type} onChange={fc("check_type")}>
                    <option value="received">شيك مستلم</option>
                    <option value="issued">شيك صادر</option>
                  </Select>
                </div>
                <div className="form-field"><label>رقم الشيك</label><input value={checkForm.check_no} onChange={fc("check_no")} /></div>
                <div className="form-field"><label>اسم البنك</label><input value={checkForm.bank_name} onChange={fc("bank_name")} /></div>
                <div className="form-field"><label>الفرع</label><input value={checkForm.branch} onChange={fc("branch")} /></div>
                <div className="form-field"><label>المبلغ *</label><input required type="number" min="0.01" step="0.01" value={checkForm.amount} onChange={fc("amount")} /></div>
                <div className="form-field">
                  <label>العملة</label>
                  <Select value={checkForm.currency} onChange={fc("currency")}>
                    <option value="NIS">شيكل</option>
                    <option value="USD">دولار</option>
                    <option value="JOD">دينار</option>
                  </Select>
                </div>
                <div className="form-field"><label>تاريخ الاستحقاق</label><input type="date" value={checkForm.due_date} onChange={fc("due_date")} /></div>
                <div className="form-field">
                  <label>الحساب البنكي</label>
                  <Select value={checkForm.bank_account_id} onChange={fc("bank_account_id")}>
                    <option value="">— اختر حساباً —</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </Select>
                </div>
                <div className="form-field"><label>ملاحظات</label><textarea value={checkForm.notes} onChange={fc("notes")} /></div>
              </div>
              <div className="form-actions">
                <button type="submit" className="btn-primary" disabled={saving}>{saving ? "جاري الحفظ…" : "حفظ"}</button>
                <button type="button" className="btn-secondary" onClick={() => setShowCheckForm(false)}>إلغاء</button>
              </div>
            </form>
          )}

          {loading ? <p>جاري التحميل…</p> : checks.length === 0 ? (
            <p className="empty-msg">لا توجد شيكات</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr><th>النوع</th><th>رقم</th><th>البنك</th><th>المبلغ</th><th>الاستحقاق</th><th>الحالة</th><th>عمليات</th></tr>
              </thead>
              <tbody>
                {checks.map((c) => (
                  <tr key={c.id} className={c.status === "bounced" ? "negative" : ""}>
                    <td>{TYPE_AR[c.check_type]}</td>
                    <td>{c.check_no || "—"}</td>
                    <td>{c.bank_name || "—"}</td>
                    <td>{ils(c.amount, c.currency === "NIS" ? "₪" : c.currency)}</td>
                    <td>{c.due_date || "—"}</td>
                    <td>{STATUS_AR[c.status]}</td>
                    <td>
                      {c.status === "pending" && (
                        <>
                          <button className="btn-link" onClick={() => changeStatus(c, "cleared")}>صُرف</button>
                          <button className="btn-link danger" onClick={() => changeStatus(c, "bounced")}>مرتد</button>
                          <button className="btn-link" onClick={() => changeStatus(c, "cancelled")}>إلغاء</button>
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

      {tab === "accounts" && (
        <div>
          <h2>الحسابات البنكية</h2>
          {accounts.length === 0 ? (
            <p className="empty-msg">لا توجد حسابات بنكية</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr><th>الاسم</th><th>البنك</th><th>رقم الحساب</th><th>العملة</th><th>الرصيد</th></tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td>{a.bank_name || "—"}</td>
                    <td>{a.account_no || "—"}</td>
                    <td>{a.currency}</td>
                    <td>{ils(a.balance, a.currency === "NIS" ? "₪" : a.currency)}</td>
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
