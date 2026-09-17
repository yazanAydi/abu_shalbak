import { apiErrorMessage } from "../utils/apiError";
import { useCallback, useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils } from "../utils/format";
import { reconcileStaffEmployees } from "../utils/reconcileStaffEmployees";
import {
  Button,
  Card,
  CardBody,
  DataTable,
  FormField,
  FormGrid,
  Input,
  Select,
  Modal,
  StatusPill,
  useToast,
} from "../components/ui";

const TYPE_LABELS = {
  monthly: "شهري",
  daily: "يومي",
  hourly: "بالساعة",
};

const emptyForm = {
  name: "",
  phone: "",
  start_on: "",
  end_on: "",
  active: true,
};

export default function EmployeeRecordsPanel() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [rateForm, setRateForm] = useState({
    effective_from: "",
    compensation_type: "monthly",
    amount: "",
    expected_days: "",
    expected_hours: "",
    notes: "",
  });
  const [debtCustomers, setDebtCustomers] = useState([]);
  const [customerId, setCustomerId] = useState("");
  const [saving, setSaving] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      await reconcileStaffEmployees();
      const { data } = await api.get("/api/employees", { headers: getAuthHeaders() });
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل تحميل الموظفين"));
    } finally {
      setLoading(false);
    }
    // toast is a stable page helper; omit from deps to avoid refetch loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDetail = useCallback(async (id) => {
    if (!id) {
      setDetail(null);
      return;
    }
    try {
      const { data } = await api.get(`/api/employees/${id}`, { headers: getAuthHeaders() });
      setDetail(data);
      const { data: customers } = await api.get("/api/employees/debt-customers", {
        headers: getAuthHeaders(),
      });
      setDebtCustomers(Array.isArray(customers) ? customers : []);
      setCustomerId(data.customer_id ? String(data.customer_id) : "");
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل تحميل بيانات الموظف"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  function openCreate() {
    setEditing(false);
    setForm(emptyForm);
    setShowForm(true);
  }

  function openEdit() {
    if (!detail) return;
    setEditing(true);
    setForm({
      name: detail.name || "",
      phone: detail.phone || "",
      start_on: detail.start_on || "",
      end_on: detail.end_on || "",
      active: !!detail.active,
    });
    setShowForm(true);
  }

  async function saveEmployee() {
    if (!form.name.trim()) {
      toast.error("اسم الموظف مطلوب");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        start_on: form.start_on || null,
        end_on: form.end_on || null,
        active: form.active,
      };
      if (editing && detail) {
        await api.patch(`/api/employees/${detail.id}`, payload, { headers: getAuthHeaders() });
        toast.success("تم حفظ الموظف");
      } else {
        const { data } = await api.post("/api/employees", payload, { headers: getAuthHeaders() });
        toast.success("تم إضافة الموظف");
        setSelectedId(data.id);
      }
      setShowForm(false);
      await loadList();
      if (editing && detail) await loadDetail(detail.id);
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل الحفظ"));
    } finally {
      setSaving(false);
    }
  }

  async function saveRate() {
    if (!detail) return;
    setSaving(true);
    try {
      await api.post(
        `/api/employees/${detail.id}/compensation`,
        {
          effective_from: rateForm.effective_from,
          compensation_type: rateForm.compensation_type,
          amount: Number(rateForm.amount),
          expected_days: rateForm.expected_days === "" ? null : Number(rateForm.expected_days),
          expected_hours: rateForm.expected_hours === "" ? null : Number(rateForm.expected_hours),
          notes: rateForm.notes || null,
        },
        { headers: getAuthHeaders() }
      );
      toast.success("أُضيف معدل بتاريخ سريان — المعدلات السابقة لم تُعدَّل");
      setRateForm({
        effective_from: "",
        compensation_type: rateForm.compensation_type,
        amount: "",
        expected_days: "",
        expected_hours: "",
        notes: "",
      });
      await loadDetail(detail.id);
      await loadList();
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل حفظ المعدل"));
    } finally {
      setSaving(false);
    }
  }

  async function saveCustomerLink() {
    if (!detail) return;
    setSaving(true);
    try {
      await api.post(
        `/api/employees/${detail.id}/link-customer`,
        { customer_id: customerId ? Number(customerId) : null },
        { headers: getAuthHeaders() }
      );
      toast.success(customerId ? "حُفظ حساب الذمة للموظف" : "أُلغي حساب الذمة");
      await loadDetail(detail.id);
      await loadList();
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل حفظ حساب الذمة"));
    } finally {
      setSaving(false);
    }
  }

  async function createDebtAccount() {
    if (!detail) return;
    setSaving(true);
    try {
      await api.post(`/api/employees/${detail.id}/debt-account`, {}, { headers: getAuthHeaders() });
      toast.success("أُنشئ حساب ذمة مربوط بهذا الموظف");
      await loadDetail(detail.id);
      await loadList();
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل إنشاء حساب الذمة"));
    } finally {
      setSaving(false);
    }
  }

  const columns = [
    { key: "name", header: "الاسم", value: (r) => r.name },
    {
      key: "active",
      header: "الحالة",
      render: (r) => (
        <StatusPill tone={r.active ? "green" : "neutral"}>{r.active ? "نشط" : "غير نشط"}</StatusPill>
      ),
    },
    {
      key: "kind",
      header: "النوع",
      render: (r) => (r.kind === "cashier" ? "كاشير" : "موظف"),
    },
    {
      key: "rate",
      header: "المعدل الحالي",
      render: (r) =>
        r.current_compensation
          ? `${TYPE_LABELS[r.current_compensation.compensation_type] || r.current_compensation.compensation_type} ${ils(r.current_compensation.amount)}`
          : "—",
    },
    {
      key: "user",
      header: "الحساب",
      render: (r) => (r.user_username ? r.user_username : "—"),
    },
    {
      key: "actions",
      header: "",
      render: (r) => (
        <Button
          size="sm"
          variant="secondary"
          onClick={(e) => {
            e.stopPropagation();
            setSelectedId(r.id);
          }}
        >
          فتح
        </Button>
      ),
    },
  ];

  return (
    <>
      <Card className="ui-mt-md">
        <CardBody>
          <p className="ui-text-muted" style={{ marginTop: 0 }}>
            يمكن إضافة موظف بدون حساب دخول. حسابات الكاشير والرفوف والمخبز تظهر هنا تلقائياً.
          </p>
          <div className="ui-toolbar">
            <Button icon="plus" onClick={openCreate}>
              موظف جديد
            </Button>
            <Button variant="secondary" onClick={loadList} disabled={loading}>
              تحديث
            </Button>
          </div>
          <DataTable
            loading={loading}
            columns={columns}
            rows={rows}
            empty="لا يوجد موظفون بعد"
            emptyIcon="users"
            onRowClick={(r) => setSelectedId(r.id)}
          />
        </CardBody>
      </Card>

      {detail && (
        <Card className="ui-mt-md">
          <CardBody>
            <div className="ui-toolbar">
              <h2 className="ui-section-title" style={{ margin: 0 }}>
                {detail.name}
              </h2>
              <Button variant="secondary" size="sm" onClick={openEdit}>
                تعديل البيانات
              </Button>
            </div>
            <p className="ui-text-muted">
              {detail.active ? "نشط" : "غير نشط"}
              {detail.kind === "cashier" ? " · كاشير" : " · موظف"}
              {detail.start_on ? ` · من ${detail.start_on}` : ""}
              {detail.end_on ? ` · إلى ${detail.end_on}` : ""}
              {detail.phone ? ` · ${detail.phone}` : ""}
              {detail.user_username ? ` · ${detail.user_username}` : ""}
              {detail.customer_name ? ` · ذمة: ${detail.customer_name}` : ""}
            </p>

            <h3>حساب الذمة (عميل)</h3>
            <p className="ui-text-muted">
              اربط حساباً فارغاً بلا حركات، أو أنشئ حساب ذمة جديداً. لا يُربط حساب له فواتير أو دفعات سابقة، ولا يُلغى حساب استُخدم مالياً.
            </p>
            <FormGrid>
              <FormField label="حساب العميل" className="ui-field--full">
                <Select
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  disabled={saving || detail.debt_account_locked}
                >
                  <option value="">— بدون حساب ذمة —</option>
                  {debtCustomers.map((c) => {
                    const isCurrent = Number(c.id) === Number(detail.customer_id);
                    const blocked =
                      (c.linked_employee_id && c.linked_employee_id !== detail.id) ||
                      (!isCurrent && !c.linkable);
                    return (
                    <option
                      key={c.id}
                      value={c.id}
                      disabled={blocked}
                    >
                      #{c.id} {c.name}
                      {c.customer_code ? ` (${c.customer_code})` : ""}
                      {c.linked_employee_id && c.linked_employee_id !== detail.id
                        ? ` — حساب ذمة لـ ${c.linked_employee_name}`
                        : !isCurrent && c.has_financial_history
                          ? " — له حركات مالية"
                        : ""}
                    </option>
                    );
                  })}
                </Select>
              </FormField>
            </FormGrid>
            <div className="ui-toolbar" style={{ gap: 8 }}>
              <Button onClick={saveCustomerLink} disabled={saving || detail.debt_account_locked}>
                حفظ حساب الذمة
              </Button>
              <Button variant="secondary" onClick={createDebtAccount} disabled={saving || !!detail.customer_id}>
                إنشاء حساب ذمة
              </Button>
            </div>

            <h3>سجل المعدلات</h3>
            <p className="ui-text-muted">زيادة الراتب = صف جديد بتاريخ سريان. الصفوف السابقة لا تُعاد حسابها.</p>
            <DataTable
              columns={[
                { key: "effective_from", header: "يسري من" },
                {
                  key: "compensation_type",
                  header: "النوع",
                  render: (r) => TYPE_LABELS[r.compensation_type] || r.compensation_type,
                },
                { key: "amount", header: "المبلغ", render: (r) => ils(r.amount), className: "num" },
                { key: "notes", header: "ملاحظة", render: (r) => r.notes || "—" },
              ]}
              rows={detail.compensation || []}
              empty="لا يوجد معدل بعد"
            />
            <FormGrid>
              <FormField label="يسري من" required>
                <Input
                  type="date"
                  value={rateForm.effective_from}
                  onChange={(e) => setRateForm((f) => ({ ...f, effective_from: e.target.value }))}
                />
              </FormField>
              <FormField label="النوع" required>
                <Select
                  value={rateForm.compensation_type}
                  onChange={(e) => setRateForm((f) => ({ ...f, compensation_type: e.target.value }))}
                >
                  <option value="monthly">شهري</option>
                  <option value="daily">يومي</option>
                  <option value="hourly">بالساعة</option>
                </Select>
              </FormField>
              <FormField label="المبلغ (₪)" required>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={rateForm.amount}
                  onChange={(e) => setRateForm((f) => ({ ...f, amount: e.target.value }))}
                />
              </FormField>
              <FormField label="أيام متوقعة (اختياري)">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={rateForm.expected_days}
                  onChange={(e) => setRateForm((f) => ({ ...f, expected_days: e.target.value }))}
                />
              </FormField>
              <FormField label="ساعات متوقعة (اختياري)">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={rateForm.expected_hours}
                  onChange={(e) => setRateForm((f) => ({ ...f, expected_hours: e.target.value }))}
                />
              </FormField>
              <FormField label="ملاحظة" className="ui-field--full">
                <Input
                  value={rateForm.notes}
                  onChange={(e) => setRateForm((f) => ({ ...f, notes: e.target.value }))}
                />
              </FormField>
            </FormGrid>
            <Button onClick={saveRate} disabled={saving}>
              إضافة معدل
            </Button>
          </CardBody>
        </Card>
      )}

      <Modal
        open={showForm}
        title={editing ? "تعديل موظف" : "موظف جديد"}
        onClose={() => setShowForm(false)}
        footer={
          <>
            <Button onClick={saveEmployee} disabled={saving}>
              حفظ
            </Button>
            <Button variant="secondary" onClick={() => setShowForm(false)}>
              إلغاء
            </Button>
          </>
        }
      >
        <FormGrid>
          <FormField label="الاسم" required>
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </FormField>
          <FormField label="الهاتف">
            <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
          </FormField>
          <FormField label="تاريخ البداية">
            <Input type="date" value={form.start_on} onChange={(e) => setForm((f) => ({ ...f, start_on: e.target.value }))} />
          </FormField>
          <FormField label="تاريخ الانتهاء">
            <Input type="date" value={form.end_on} onChange={(e) => setForm((f) => ({ ...f, end_on: e.target.value }))} />
          </FormField>
          <FormField label="الحالة">
            <Select
              value={form.active ? "1" : "0"}
              onChange={(e) => setForm((f) => ({ ...f, active: e.target.value === "1" }))}
            >
              <option value="1">نشط</option>
              <option value="0">غير نشط</option>
            </Select>
          </FormField>
        </FormGrid>
      </Modal>
    </>
  );
}
