import { useCallback, useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders, getUser } from "../utils/auth";
import { ROLE_LABELS_AR, USER_ROLES, isKioskOnlyRole, roleNeedsPassword } from "../utils/roles";
import {
  PageHeader,
  Card,
  CardBody,
  DataTable,
  FormField,
  FormGrid,
  Input,
  Select,
  PrimaryButton,
  SecondaryButton,
  DangerButton,
  StatusBadge,
  ReportToolbar,
  useToast,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";

export default function UserManagement() {
  const toast = useToast();
  const me = getUser();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ username: "", password: "", role: "cashier" });
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editRole, setEditRole] = useState("cashier");
  const [editPassword, setEditPassword] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/api/admin/users", { headers: getAuthHeaders() });
      setUsers(data);
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "فشل التحميل");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function addUser() {
    if (!form.username.trim()) {
      toast.error("اسم المستخدم مطلوب");
      return;
    }
    if (roleNeedsPassword(form.role) && !form.password) {
      toast.error("كلمة المرور مطلوبة لهذا الدور");
      return;
    }
    setSaving(true);
    try {
      const body = {
        username: form.username.trim(),
        role: form.role,
      };
      if (form.password) body.password = form.password;
      await api.post("/api/admin/users", body, {
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      });
      setForm({ username: "", password: "", role: "cashier" });
      toast.success("تم إنشاء المستخدم");
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "فشل الإنشاء");
    } finally {
      setSaving(false);
    }
  }

  function startEdit(u) {
    setEditing(u.id);
    setEditRole(u.role);
    setEditPassword("");
  }

  function cancelEdit() {
    setEditing(null);
    setEditPassword("");
  }

  async function saveEdit(id) {
    setSaving(true);
    try {
      const body = { role: editRole };
      if (editPassword.trim()) body.password = editPassword;
      await api.patch(`/api/admin/users/${id}`, body, {
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      });
      cancelEdit();
      toast.success("تم الحفظ");
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "فشل الحفظ");
    } finally {
      setSaving(false);
    }
  }

  async function removeUser(id) {
    if (!window.confirm("حذف هذا الحساب؟")) return;
    try {
      await api.delete(`/api/admin/users/${id}`, { headers: getAuthHeaders() });
      toast.success("تم الحذف");
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "فشل الحذف");
    }
  }

  const columns = [
    {
      key: "username",
      header: "المستخدم",
      value: (u) => u.username,
      render: (u) => (
        <>
          {u.username}
          {u.id === me?.id ? (
            <span style={{ color: "var(--office-text-muted)", marginInlineStart: 6 }}>
              (أنت)
            </span>
          ) : null}
        </>
      ),
    },
    {
      key: "role",
      header: "الدور",
      value: (u) => ROLE_LABELS_AR[u.role] || u.role,
      render: (u) =>
        editing === u.id ? (
          <Select
            className="ui-input"
            value={editRole}
            onChange={(e) => setEditRole(e.target.value)}
            onClick={(e) => e.stopPropagation()}
          >
            {USER_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS_AR[r] || r}
              </option>
            ))}
          </Select>
        ) : (
          <StatusBadge tone="blue">{ROLE_LABELS_AR[u.role] || u.role}</StatusBadge>
        ),
    },
    {
      key: "actions",
      header: "إجراءات",
      render: (u) =>
        editing === u.id ? (
          <div className="ui-table__actions" onClick={(e) => e.stopPropagation()}>
            <Input
              type="password"
              placeholder="كلمة مرور جديدة (اختياري)"
              value={editPassword}
              onChange={(e) => setEditPassword(e.target.value)}
              style={{ maxWidth: 200 }}
            />
            <PrimaryButton size="sm" type="button" onClick={() => saveEdit(u.id)} disabled={saving}>
              حفظ
            </PrimaryButton>
            <SecondaryButton size="sm" type="button" onClick={cancelEdit}>
              إلغاء
            </SecondaryButton>
          </div>
        ) : (
          <div className="ui-table__actions">
            <SecondaryButton size="sm" type="button" onClick={() => startEdit(u)}>
              تعديل
            </SecondaryButton>
            <DangerButton
              size="sm"
              type="button"
              onClick={() => removeUser(u.id)}
              disabled={u.id === me?.id}
            >
              حذف
            </DangerButton>
          </div>
        ),
    },
  ];

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title="إدارة الحسابات"
        subtitle={
          <>
            أنشئ حسابات بصلاحية:{" "}
            {USER_ROLES.map((r) => (
              <StatusBadge key={r} tone="neutral" noDot>
                {ROLE_LABELS_AR[r] || r}
              </StatusBadge>
            ))}
          </>
        }
        icon="users"
        actions={
          <ReportToolbar
            title="إدارة الحسابات"
            columns={pickExportColumns(columns)}
            rows={users}
            filename="users"
            disabled={loading}
          />
        }
      />

      <Card>
        <CardBody>
          <h2 className="dashboard-section-title">مستخدم جديد</h2>
          <FormGrid>
            <FormField label="اسم المستخدم">
              <Input
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                autoComplete="off"
              />
            </FormField>
            {roleNeedsPassword(form.role) ? (
              <FormField label="كلمة المرور">
                <Input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  autoComplete="new-password"
                />
              </FormField>
            ) : (
              <FormField label="كلمة المرور">
                <p className="ui-hint" style={{ margin: 0 }}>
                  غير مطلوبة — موظفو المخبز/الرفوف يسجّلون الحضور عبر كشك الوجه فقط
                </p>
              </FormField>
            )}
            <FormField label="الدور">
              <Select
                value={form.role}
                onChange={(e) => {
                  const role = e.target.value;
                  setForm((f) => ({
                    ...f,
                    role,
                    password: isKioskOnlyRole(role) ? "" : f.password,
                  }));
                }}
              >
                {USER_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS_AR[r] || r}
                  </option>
                ))}
              </Select>
            </FormField>
          </FormGrid>
          <PrimaryButton
            type="button"
            onClick={addUser}
            disabled={saving}
            style={{ marginTop: "1rem" }}
          >
            {saving ? "…" : "إضافة"}
          </PrimaryButton>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h2 className="dashboard-section-title">المستخدمون</h2>
          <DataTable
            columns={columns}
            rows={users}
            loading={loading}
            empty="لا يوجد مستخدمون"
            emptyIcon="users"
          />
        </CardBody>
      </Card>
    </div>
  );
}
