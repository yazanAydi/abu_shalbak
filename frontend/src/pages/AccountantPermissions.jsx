import { useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders, getUser } from "../utils/auth";
import { isAdminRole } from "../utils/roles";
import {
  defaultAccountantPermissions,
  normalizeAccountantPermissions,
} from "../utils/accountantPermissions";
import AccountantPermissionsPanel from "../components/AccountantPermissionsPanel";
import {
  PageHeader,
  Card,
  CardBody,
  PrimaryButton,
  SkeletonRows,
  useToast,
} from "../components/ui";

export default function AccountantPermissions() {
  const toast = useToast();
  const user = getUser();
  const canEdit = isAdminRole(user?.role);
  const [permissions, setPermissions] = useState(defaultAccountantPermissions());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .get("/api/settings", { headers: getAuthHeaders() })
      .then(({ data }) => {
        setPermissions(normalizeAccountantPermissions(data.accountant_permissions));
        setError(null);
      })
      .catch(() => {
        setError("تعذّر تحميل الصلاحيات");
      })
      .finally(() => setLoading(false));
  }, []);

  async function save(e) {
    e.preventDefault();
    if (!canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const { data } = await api.patch(
        "/api/settings",
        { accountant_permissions: permissions },
        { headers: getAuthHeaders() }
      );
      setPermissions(normalizeAccountantPermissions(data.accountant_permissions));
      toast.success("تم الحفظ بنجاح");
    } catch (err) {
      const msg = err.response?.data?.error || "فشل الحفظ";
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        icon="settings"
        title="الصلاحيات"
        subtitle="اختر الصفحات والميزات التي يمكن لجميع حسابات المحاسب الوصول إليها في لوحة الإدارة."
      />
      <Card>
        <CardBody>
          {loading ? (
            <SkeletonRows rows={6} cols={2} />
          ) : (
            <form onSubmit={save}>
              {error ? <p className="settings-error">{error}</p> : null}
              {!canEdit ? (
                <p className="settings-favorites-hint">عرض فقط — لا يمكن للمحاسب تعديل هذه الصلاحيات.</p>
              ) : null}
              <AccountantPermissionsPanel
                value={permissions}
                onChange={setPermissions}
                readOnly={!canEdit}
              />
              {canEdit ? (
                <div style={{ marginTop: 16 }}>
                  <PrimaryButton type="submit" disabled={saving}>
                    {saving ? "جاري الحفظ…" : "حفظ"}
                  </PrimaryButton>
                </div>
              ) : null}
            </form>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
