import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders, getUser } from "../utils/auth";
import { ROLE_LABELS_AR, USER_ROLES } from "../utils/roles";
import "./UserManagement.css";

export default function UserManagement() {
  const me = getUser();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({ username: "", password: "", role: "cashier" });
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editRole, setEditRole] = useState("cashier");
  const [editPassword, setEditPassword] = useState("");

  const load = useCallback(async () => {
    setErr("");
    setLoading(true);
    try {
      const { data } = await api.get("/api/admin/users", { headers: getAuthHeaders() });
      setUsers(data);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "فشل التحميل");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function addUser() {
    if (!form.username.trim() || !form.password) {
      setErr("اسم المستخدم وكلمة المرور مطلوبان");
      return;
    }
    setErr("");
    setSaving(true);
    try {
      await api.post(
        "/api/admin/users",
        {
          username: form.username.trim(),
          password: form.password,
          role: form.role,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      setForm({ username: "", password: "", role: "cashier" });
      load();
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "فشل الإنشاء");
    } finally {
      setSaving(false);
    }
  }

  function startEdit(u) {
    setEditing(u.id);
    setEditRole(u.role);
    setEditPassword("");
    setErr("");
  }

  function cancelEdit() {
    setEditing(null);
    setEditPassword("");
  }

  async function saveEdit(id) {
    setErr("");
    setSaving(true);
    try {
      const body = { role: editRole };
      if (editPassword.trim()) body.password = editPassword;
      await api.patch(`/api/admin/users/${id}`, body, {
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      });
      cancelEdit();
      load();
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "فشل الحفظ");
    } finally {
      setSaving(false);
    }
  }

  async function removeUser(id) {
    if (!window.confirm("حذف هذا الحساب؟")) return;
    setErr("");
    try {
      await api.delete(`/api/admin/users/${id}`, { headers: getAuthHeaders() });
      load();
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "فشل الحذف");
    }
  }

  return (
    <div className="um-page" dir="rtl" lang="ar">
      <header className="um-top">
        <div className="um-nav-row">
          <Link to="/checkout" className="um-back">
            ← العودة للكاشير
          </Link>
          <Link to="/reports" className="um-back">
            تقرير يومي
          </Link>
          <Link to="/finance" className="um-back">
            المالية
          </Link>
        </div>
        <h1 className="um-title">إدارة الحسابات</h1>
        <p className="um-sub">
          أنشئ حسابات بصلاحية: {" "}
          {USER_ROLES.map((r) => (
            <span key={r} className="um-role-pill" title={r}>
              {ROLE_LABELS_AR[r] || r}
            </span>
          ))}
        </p>
      </header>

      {err ? <div className="um-err">{err}</div> : null}

      <section className="um-card">
        <h2 className="um-h2">مستخدم جديد</h2>
        <div className="um-form-row">
          <label>
            اسم المستخدم
            <input
              className="um-input"
              value={form.username}
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
              autoComplete="off"
            />
          </label>
          <label>
            كلمة المرور
            <input
              type="password"
              className="um-input"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              autoComplete="new-password"
            />
          </label>
          <label>
            الدور
            <select
              className="um-input"
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
            >
              {USER_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS_AR[r] || r}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="um-btn"
            onClick={addUser}
            disabled={saving}
          >
            {saving ? "…" : "إضافة"}
          </button>
        </div>
      </section>

      <section className="um-card">
        <h2 className="um-h2">المستخدمون</h2>
        {loading ? <p>جاري التحميل…</p> : null}
        {!loading && users.length === 0 ? <p>لا يوجد مستخدمون</p> : null}
        <div className="um-table-wrap">
          <table className="um-table">
            <thead>
              <tr>
                <th>المستخدم</th>
                <th>الدور</th>
                <th>إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.username}
                    {u.id === me?.id ? (
                      <span className="um-you">(أنت)</span>
                    ) : null}
                  </td>
                  <td>
                    {editing === u.id ? (
                      <select
                        className="um-input um-input-sm"
                        value={editRole}
                        onChange={(e) => setEditRole(e.target.value)}
                      >
                        {USER_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS_AR[r] || r}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="um-role-disp">
                        {ROLE_LABELS_AR[u.role] || u.role}
                      </span>
                    )}
                  </td>
                  <td className="um-actions">
                    {editing === u.id ? (
                      <>
                        <input
                          type="password"
                          className="um-input um-input-sm"
                          placeholder="كلمة مرور جديدة (اختياري)"
                          value={editPassword}
                          onChange={(e) => setEditPassword(e.target.value)}
                        />
                        <button
                          type="button"
                          className="um-btn"
                          onClick={() => saveEdit(u.id)}
                          disabled={saving}
                        >
                          حفظ
                        </button>
                        <button
                          type="button"
                          className="um-btn secondary"
                          onClick={cancelEdit}
                        >
                          إلغاء
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="um-btn light"
                          onClick={() => startEdit(u)}
                        >
                          تعديل
                        </button>
                        <button
                          type="button"
                          className="um-btn danger"
                          onClick={() => removeUser(u.id)}
                          disabled={u.id === me?.id}
                        >
                          حذف
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
