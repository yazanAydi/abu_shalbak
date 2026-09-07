import { useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders, getUser } from "../utils/auth";
import { ROLE_LABELS_AR, isAdminRole } from "../utils/roles";
import {
  defaultAccountantPermissions,
  normalizeAccountantPermissions,
} from "../utils/accountantPermissions";
import AccountantPermissionsPanel from "../components/AccountantPermissionsPanel";
import {
  PageHeader,
  Card,
  CardBody,
  FormField,
  Select,
  PrimaryButton,
  SecondaryButton,
  SkeletonRows,
  useToast,
} from "../components/ui";

const DEFAULT_TARGET = "default";

function unwrapUsers(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.users)) return data.users;
  return [];
}

export default function AccountantPermissions() {
  const toast = useToast();
  const user = getUser();
  const canEdit = isAdminRole(user?.role);
  const [target, setTarget] = useState(DEFAULT_TARGET);
  const [accounts, setAccounts] = useState([]);
  const [permissions, setPermissions] = useState(defaultAccountantPermissions());
  const [custom, setCustom] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .get("/api/admin/users", { headers: getAuthHeaders() })
      .then(({ data }) => {
        setAccounts(
          unwrapUsers(data)
            .filter((u) => u.role === "admin" || u.role === "accountant")
            .sort((a, b) => {
              const roleOrder = (a.role === "admin" ? 0 : 1) - (b.role === "admin" ? 0 : 1);
              if (roleOrder !== 0) return roleOrder;
              return String(a.username || "").localeCompare(String(b.username || ""), "ar");
            })
        );
      })
      .catch(() => {
        setAccounts([]);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const request =
      target === DEFAULT_TARGET
        ? api.get("/api/settings", { headers: getAuthHeaders() }).then(({ data }) => ({
            permissions: normalizeAccountantPermissions(data.accountant_permissions),
            custom: false,
          }))
        : api
            .get(`/api/admin/users/${target}/permissions`, { headers: getAuthHeaders() })
            .then(({ data }) => ({
              permissions: normalizeAccountantPermissions(data.permissions),
              custom: !!data.custom,
            }));

    request
      .then((next) => {
        if (cancelled) return;
        setPermissions(next.permissions);
        setCustom(next.custom);
      })
      .catch(() => {
        if (cancelled) return;
        setError("تعذّر تحميل الصلاحيات");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [target]);

  function markAccountCustom(id, hasCustom) {
    setAccounts((prev) =>
      prev.map((account) =>
        Number(account.id) === Number(id)
          ? { ...account, has_custom_permissions: hasCustom }
          : account
      )
    );
  }

  async function save(e) {
    e.preventDefault();
    if (!canEdit) return;
    setSaving(true);
    setError(null);
    try {
      if (target === DEFAULT_TARGET) {
        const { data } = await api.patch(
          "/api/settings",
          { accountant_permissions: permissions },
          { headers: getAuthHeaders() }
        );
        setPermissions(normalizeAccountantPermissions(data.accountant_permissions));
        setCustom(false);
      } else {
        const { data } = await api.put(
          `/api/admin/users/${target}/permissions`,
          { permissions },
          { headers: getAuthHeaders() }
        );
        setPermissions(normalizeAccountantPermissions(data.permissions));
        setCustom(!!data.custom);
        markAccountCustom(target, true);
      }
      toast.success("تم الحفظ بنجاح");
    } catch (err) {
      const msg = err.response?.data?.error || "فشل الحفظ";
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefault() {
    if (!canEdit || target === DEFAULT_TARGET) return;
    setSaving(true);
    setError(null);
    try {
      const { data } = await api.put(
        `/api/admin/users/${target}/permissions`,
        { permissions: null },
        { headers: getAuthHeaders() }
      );
      setPermissions(normalizeAccountantPermissions(data.permissions));
      setCustom(false);
      markAccountCustom(target, false);
      toast.success("تم الرجوع إلى الإعداد الافتراضي");
    } catch (err) {
      const msg = err.response?.data?.error || "فشل الحفظ";
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  const selectedAccount = accounts.find((account) => String(account.id) === String(target));

  return (
    <div>
      <PageHeader
        icon="settings"
        title="الصلاحيات"
        subtitle="اختر المدير أو المحاسب بالاسم لمنحه صلاحيات خاصة، أو عدّل الإعداد الافتراضي لجميع المحاسبين."
      />
      <Card>
        <CardBody>
          <FormField label="الحساب">
            <Select
              value={target}
              disabled={saving}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value={DEFAULT_TARGET}>الافتراضي — جميع المحاسبين</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.username} — {ROLE_LABELS_AR[account.role] || account.role}
                  {account.has_custom_permissions ? " (مخصص)" : ""}
                </option>
              ))}
            </Select>
          </FormField>

          {loading ? (
            <SkeletonRows rows={6} cols={2} />
          ) : (
            <form onSubmit={save}>
              {error ? <p className="settings-error">{error}</p> : null}
              {!canEdit ? (
                <p className="settings-favorites-hint">عرض فقط — لا يمكن للمحاسب تعديل هذه الصلاحيات.</p>
              ) : null}
              {target !== DEFAULT_TARGET && !custom ? (
                <p className="settings-favorites-hint">هذا الحساب يستخدم الإعدادات الافتراضية</p>
              ) : null}
              {target !== DEFAULT_TARGET && custom && selectedAccount ? (
                <p className="settings-favorites-hint">صلاحيات مخصصة لحساب {selectedAccount.username}</p>
              ) : null}
              <AccountantPermissionsPanel
                value={permissions}
                onChange={setPermissions}
                readOnly={!canEdit}
              />
              {canEdit ? (
                <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <PrimaryButton type="submit" disabled={saving}>
                    {saving ? "جاري الحفظ…" : "حفظ"}
                  </PrimaryButton>
                  {target !== DEFAULT_TARGET && custom ? (
                    <SecondaryButton type="button" onClick={resetToDefault} disabled={saving}>
                      الرجوع إلى الافتراضي
                    </SecondaryButton>
                  ) : null}
                </div>
              ) : null}
            </form>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
