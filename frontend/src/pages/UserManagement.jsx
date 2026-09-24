import { useCallback, useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders, getUser } from "../utils/auth";
import {
  ROLE_LABELS_AR,
  USER_ROLES,
  isAdminRole,
  isAttendanceRole,
  isKioskOnlyRole,
  roleNeedsPassword,
} from "../utils/roles";
import { ils } from "../utils/format";
import {
  PageHeader,
  Card,
  CardHeader,
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
  Notice,
  useToast,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";
import { reconcileStaffEmployees } from "../utils/reconcileStaffEmployees";
import { apiErrorMessage } from "../utils/apiError";

const emptyForm = {
  username: "",
  password: "",
  role: "cashier",
  hourly_rate: "",
  wage_basis: "",
  daily_rate: "",
};

export default function UserManagement() {
  const toast = useToast();
  const me = getUser();
  const assignableRoles = isAdminRole(me?.role)
    ? USER_ROLES
    : USER_ROLES.filter((role) => role !== "admin");
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editRole, setEditRole] = useState("cashier");
  const [editPassword, setEditPassword] = useState("");
  const [editHourlyRate, setEditHourlyRate] = useState("");
  const [editWageBasis, setEditWageBasis] = useState("");
  const [editDailyRate, setEditDailyRate] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const recon = await reconcileStaffEmployees();
      const { data } = await api.get("/api/admin/users", { headers: getAuthHeaders() });
      setUsers(Array.isArray(data) ? data : []);
      if (recon?.created_count > 0) {
        toast.success("أُضيفت حسابات الموظفين الناقصة");
      }
      if (recon?.ambiguous_count > 0) {
        toast.info("وُجدت سجلات موظفين بنفس الاسم دون دمج. لم يُغيَّر تاريخها المالي.");
      }
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل التحميل"));
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
      if (isKioskOnlyRole(form.role)) {
        if (form.wage_basis !== "daily" && form.wage_basis !== "hourly") {
          toast.error("اختر طريقة احتساب الأجر");
          setSaving(false);
          return;
        }
        body.wage_basis = form.wage_basis;
        if (form.wage_basis === "daily") {
          if (!(Number(form.daily_rate) > 0)) {
            toast.error("أجر اليوم مطلوب");
            setSaving(false);
            return;
          }
          body.daily_rate = Number(form.daily_rate);
        } else if (!(Number(form.hourly_rate) > 0)) {
          toast.error("أجر الساعة مطلوب");
          setSaving(false);
          return;
        } else {
          body.hourly_rate = Number(form.hourly_rate);
        }
      } else if (form.role === "cashier" && form.hourly_rate !== "") {
        body.hourly_rate = Number(form.hourly_rate);
      }
      await api.post("/api/admin/users", body, {
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      });
      setForm(emptyForm);
      toast.success("تم إنشاء المستخدم");
      await load();
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل الإنشاء"));
    } finally {
      setSaving(false);
    }
  }

  function startEdit(u) {
    if (!isAdminRole(me?.role) && u.role === "admin") return;
    setEditing(u.id);
    setEditRole(u.role);
    setEditPassword("");
    setEditHourlyRate(u.hourly_rate != null && u.hourly_rate > 0 ? String(u.hourly_rate) : "");
    setEditWageBasis(u.wage_basis || "");
    setEditDailyRate(u.daily_rate != null ? String(u.daily_rate) : "");
  }

  function cancelEdit() {
    setEditing(null);
    setEditPassword("");
    setEditHourlyRate("");
  }

  async function saveEdit(id) {
    setSaving(true);
    try {
      const body = { role: editRole };
      if (editPassword.trim()) body.password = editPassword;
      if (isKioskOnlyRole(editRole)) {
        if (editWageBasis === "daily" || editWageBasis === "hourly") {
          body.wage_basis = editWageBasis;
          if (editWageBasis === "daily") body.daily_rate = Number(editDailyRate);
          else if (editHourlyRate !== "") body.hourly_rate = Number(editHourlyRate);
        }
      } else if (editRole === "cashier" && editHourlyRate !== "") {
        body.hourly_rate = Number(editHourlyRate);
      }
      await api.patch(`/api/admin/users/${id}`, body, {
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      });
      cancelEdit();
      toast.success("تم الحفظ");
      await load();
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل الحفظ"));
    } finally {
      setSaving(false);
    }
  }

  async function removeUser(id) {
    if (!window.confirm("حذف هذا الحساب؟")) return;
    try {
      await api.delete(`/api/admin/users/${id}`, { headers: getAuthHeaders() });
      toast.success("تم الحذف");
      await load();
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل الحذف"));
    }
  }

  const columns = [
    {
      key: "username",
      header: "المستخدم",
      nameColumn: true,
      value: (u) => u.username,
      render: (u) => (
        <>
          {u.username}
          {u.id === me?.id ? (
            <span className="ui-hint"> (أنت)</span>
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
            {assignableRoles.map((r) => (
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
      key: "hourly_rate",
      header: "الأجر",
      value: (u) => {
        if (u.role === "cashier" && u.hourly_rate > 0) return ils(u.hourly_rate);
        if (u.wage_basis === "daily" && u.daily_rate > 0) return `يومي ${ils(u.daily_rate)}`;
        if (u.wage_basis === "hourly" && u.hourly_rate > 0) return `ساعة ${ils(u.hourly_rate)}`;
        return "—";
      },
      render: (u) =>
        editing === u.id && editRole === "cashier" ? (
          <Input
            type="number"
            min="0"
            step="0.01"
            value={editHourlyRate}
            onChange={(e) => setEditHourlyRate(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 120 }}
          />
        ) : editing === u.id && isKioskOnlyRole(editRole) ? (
          <div onClick={(e) => e.stopPropagation()} style={{ display: "grid", gap: 6 }}>
            <Select value={editWageBasis} onChange={(e) => setEditWageBasis(e.target.value)}>
              <option value="">— دون تغيير —</option>
              <option value="daily">أجر يومي</option>
              <option value="hourly">أجر بالساعة</option>
            </Select>
            {editWageBasis === "daily" ? (
              <Input
                type="number"
                min="0"
                step="0.01"
                value={editDailyRate}
                onChange={(e) => setEditDailyRate(e.target.value)}
                style={{ maxWidth: 120 }}
              />
            ) : null}
            {editWageBasis === "hourly" ? (
              <Input
                type="number"
                min="0"
                step="0.01"
                value={editHourlyRate}
                onChange={(e) => setEditHourlyRate(e.target.value)}
                style={{ maxWidth: 120 }}
              />
            ) : null}
          </div>
        ) : u.role === "cashier" && u.hourly_rate > 0 ? (
          <span className="num">{ils(u.hourly_rate)}</span>
        ) : u.wage_basis === "daily" ? (
          <span className="num">يومي {u.daily_rate > 0 ? ils(u.daily_rate) : "—"}</span>
        ) : u.wage_basis === "hourly" && u.hourly_rate > 0 ? (
          <span className="num">ساعة {ils(u.hourly_rate)}</span>
        ) : (
          "—"
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
              className="ui-input--narrow"
            />
            <PrimaryButton size="sm" type="button" onClick={() => saveEdit(u.id)} disabled={saving}>
              حفظ
            </PrimaryButton>
            <SecondaryButton size="sm" type="button" onClick={cancelEdit}>
              إلغاء
            </SecondaryButton>
          </div>
        ) : !isAdminRole(me?.role) && u.role === "admin" ? (
          <span className="ui-hint">حساب مدير</span>
        ) : (
          <div className="ui-table__actions">
            <SecondaryButton size="sm" type="button" onClick={() => startEdit(u)}>
              تعديل
            </SecondaryButton>
            <DangerButton
              size="sm"
              type="button"
              aria-label={`حذف ${u.username}`}
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
            {assignableRoles.map((r) => (
              <StatusBadge key={r} tone="neutral" noDot>
                {ROLE_LABELS_AR[r] || r}
              </StatusBadge>
            ))}
          </>
        }
        icon="users"
        actions={
          <>
            <PrimaryButton
              type="button"
              onClick={() => document.getElementById("new-user-form")?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              مستخدم جديد
            </PrimaryButton>
            <ReportToolbar
              title="إدارة الحسابات"
              columns={pickExportColumns(columns)}
              rows={users}
              filename="users"
              disabled={loading}
            />
          </>
        }
      />

      <Card id="new-user-form">
        <CardHeader title="مستخدم جديد" />
        <CardBody>
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
                <Notice tone="info">غير مطلوبة — كشك الوجه فقط</Notice>
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
                    hourly_rate: isAttendanceRole(role) ? f.hourly_rate : "",
                    wage_basis: isKioskOnlyRole(role) ? f.wage_basis : "",
                    daily_rate: isKioskOnlyRole(role) ? f.daily_rate : "",
                  }));
                }}
              >
                {assignableRoles.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS_AR[r] || r}
                  </option>
                ))}
              </Select>
            </FormField>
            {form.role === "cashier" ? (
              <FormField label="أجر الساعة (₪)" hint="يُنسخ عند فتح وردية نقطة البيع">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.hourly_rate}
                  onChange={(e) => setForm((f) => ({ ...f, hourly_rate: e.target.value }))}
                />
              </FormField>
            ) : null}
            {isKioskOnlyRole(form.role) ? (
              <FormField label="طريقة احتساب الأجر" hint="كيف يُكتسب الأجر، وليس موعد صرفه">
                <Select
                  value={form.wage_basis}
                  onChange={(e) => setForm((f) => ({ ...f, wage_basis: e.target.value }))}
                >
                  <option value="">— اختر —</option>
                  <option value="daily">أجر يومي</option>
                  <option value="hourly">أجر بالساعة</option>
                </Select>
              </FormField>
            ) : null}
            {isKioskOnlyRole(form.role) && form.wage_basis === "daily" ? (
              <FormField label="أجر اليوم (₪)">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.daily_rate}
                  onChange={(e) => setForm((f) => ({ ...f, daily_rate: e.target.value }))}
                />
              </FormField>
            ) : null}
            {isKioskOnlyRole(form.role) && form.wage_basis === "hourly" ? (
              <FormField label="أجر الساعة (₪)">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.hourly_rate}
                  onChange={(e) => setForm((f) => ({ ...f, hourly_rate: e.target.value }))}
                />
              </FormField>
            ) : null}
          </FormGrid>
          <PrimaryButton
            type="button"
            onClick={addUser}
            disabled={saving}
            className="ui-mt-md"
          >
            {saving ? "…" : "إضافة"}
          </PrimaryButton>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="المستخدمون" />
        <CardBody>
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
