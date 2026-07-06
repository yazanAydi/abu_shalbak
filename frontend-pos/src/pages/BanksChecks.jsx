import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import {
  PageHeader,
  ReportToolbar,
  Tabs,
  FilterBar,
  DataTable,
  Modal,
  Button,
  FormField,
  FormGrid,
  Input,
  Select,
  Textarea,
  StatusPill,
  useToast,
} from "../components/ui";

const ils = (n, cur) => `${cur || "₪"}${Number(n ?? 0).toFixed(2)}`;

const STATUS_AR = { pending: "قيد الانتظار", cleared: "مصروف/مقبوض", bounced: "مرتد", cancelled: "ملغي" };
const TYPE_AR = { received: "شيك مستلم", issued: "شيك صادر" };
const STATUS_TONE = { pending: "orange", cleared: "green", bounced: "red", cancelled: "neutral" };

const CHECK_COLUMNS = [
  { key: "check_type", header: "النوع", value: (c) => TYPE_AR[c.check_type] },
  { key: "check_no", header: "رقم", value: (c) => c.check_no || "—" },
  { key: "bank_name", header: "البنك", value: (c) => c.bank_name || "—" },
  {
    key: "amount",
    header: "المبلغ",
    className: "num",
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
    className: "num",
    value: (a) => ils(a.balance, a.currency === "NIS" ? "₪" : a.currency),
  },
];

const emptyCheck = {
  check_type: "received",
  check_no: "",
  bank_name: "",
  branch: "",
  amount: "",
  currency: "NIS",
  due_date: "",
  customer_id: "",
  supplier_id: "",
  bank_account_id: "",
  notes: "",
};

export default function BanksChecks() {
  const toast = useToast();
  const [tab, setTab] = useState("checks");
  const [checks, setChecks] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(false);
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
    } catch {
      toast.error("تعذّر تحميل الشيكات");
    } finally {
      setLoading(false);
    }
  }, [filter, toast]);

  const loadAccounts = useCallback(async () => {
    try {
      const { data } = await api.get("/api/banks/accounts", { headers: getAuthHeaders() });
      setAccounts(data);
    } catch {
      toast.error("تعذّر تحميل الحسابات");
    }
  }, [toast]);

  useEffect(() => {
    loadChecks();
    loadAccounts();
  }, [loadChecks, loadAccounts]);

  async function addCheck(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post(
        "/api/banks/checks",
        {
          ...checkForm,
          amount: Number(checkForm.amount),
          customer_id: checkForm.customer_id || undefined,
          supplier_id: checkForm.supplier_id || undefined,
          bank_account_id: checkForm.bank_account_id || undefined,
        },
        { headers: getAuthHeaders() }
      );
      toast.success("تم تسجيل الشيك");
      setShowCheckForm(false);
      setCheckForm(emptyCheck);
      loadChecks();
    } catch (e) {
      toast.error(e.response?.data?.error || "فشل التسجيل");
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(check, status) {
    try {
      await api.patch(`/api/banks/checks/${check.id}/status`, { status }, { headers: getAuthHeaders() });
      toast.success("تم تحديث الحالة");
      loadChecks();
    } catch (e) {
      toast.error(e.response?.data?.error || "فشل التحديث");
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

  const checkColumns = useMemo(
    () => [
      {
        key: "check_type",
        header: "النوع",
        render: (c) => TYPE_AR[c.check_type],
      },
      { key: "check_no", header: "رقم", render: (c) => c.check_no || "—" },
      { key: "bank_name", header: "البنك", render: (c) => c.bank_name || "—" },
      {
        key: "amount",
        header: "المبلغ",
        className: "num",
        render: (c) => ils(c.amount, c.currency === "NIS" ? "₪" : c.currency),
      },
      { key: "due_date", header: "الاستحقاق", render: (c) => c.due_date || "—" },
      {
        key: "status",
        header: "الحالة",
        render: (c) => (
          <StatusPill tone={STATUS_TONE[c.status] || "neutral"}>{STATUS_AR[c.status]}</StatusPill>
        ),
      },
      {
        key: "actions",
        header: "عمليات",
        render: (c) =>
          c.status === "pending" ? (
            <div className="ui-table__actions">
              <Button variant="ghost" size="sm" onClick={() => changeStatus(c, "cleared")}>
                صُرف
              </Button>
              <Button variant="ghost" size="sm" onClick={() => changeStatus(c, "bounced")}>
                مرتد
              </Button>
              <Button variant="ghost" size="sm" onClick={() => changeStatus(c, "cancelled")}>
                إلغاء
              </Button>
            </div>
          ) : null,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const accountColumns = useMemo(
    () => [
      { key: "name", header: "الاسم" },
      { key: "bank_name", header: "البنك", render: (a) => a.bank_name || "—" },
      { key: "account_no", header: "رقم الحساب", render: (a) => a.account_no || "—" },
      { key: "currency", header: "العملة" },
      {
        key: "balance",
        header: "الرصيد",
        className: "num",
        render: (a) => ils(a.balance, a.currency === "NIS" ? "₪" : a.currency),
      },
    ],
    []
  );

  const tabs = useMemo(
    () => [
      { id: "checks", label: "الشيكات" },
      { id: "accounts", label: "الحسابات البنكية" },
    ],
    []
  );

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

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === "checks" && (
        <>
          <FilterBar
            actions={
              <Button onClick={() => setShowCheckForm(true)}>+ شيك جديد</Button>
            }
          >
            <FormField label="النوع">
              <Select
                value={filter.type}
                onChange={(e) => setFilter((p) => ({ ...p, type: e.target.value }))}
              >
                <option value="">كل الأنواع</option>
                <option value="received">مستلمة</option>
                <option value="issued">صادرة</option>
              </Select>
            </FormField>
            <FormField label="الحالة">
              <Select
                value={filter.status}
                onChange={(e) => setFilter((p) => ({ ...p, status: e.target.value }))}
              >
                <option value="">كل الحالات</option>
                <option value="pending">قيد الانتظار</option>
                <option value="cleared">مصروف</option>
                <option value="bounced">مرتد</option>
                <option value="cancelled">ملغي</option>
              </Select>
            </FormField>
          </FilterBar>

          <DataTable
            columns={checkColumns}
            rows={checks}
            loading={loading}
            empty="لا توجد شيكات"
            emptyIcon="banks"
            rowClassName={(c) => (c.status === "bounced" ? "negative" : "")}
          />
        </>
      )}

      {tab === "accounts" && (
        <DataTable
          columns={accountColumns}
          rows={accounts}
          loading={false}
          empty="لا توجد حسابات بنكية"
          emptyIcon="banks"
        />
      )}

      <Modal
        open={showCheckForm}
        onClose={() => setShowCheckForm(false)}
        title="تسجيل شيك جديد"
        footer={
          <>
            <Button type="submit" form="check-form" disabled={saving}>
              {saving ? "جاري الحفظ…" : "حفظ"}
            </Button>
            <Button variant="secondary" type="button" onClick={() => setShowCheckForm(false)}>
              إلغاء
            </Button>
          </>
        }
      >
        <form id="check-form" onSubmit={addCheck}>
          <FormGrid>
            <FormField label="النوع">
              <Select value={checkForm.check_type} onChange={fc("check_type")}>
                <option value="received">شيك مستلم</option>
                <option value="issued">شيك صادر</option>
              </Select>
            </FormField>
            <FormField label="رقم الشيك">
              <Input value={checkForm.check_no} onChange={fc("check_no")} />
            </FormField>
            <FormField label="اسم البنك">
              <Input value={checkForm.bank_name} onChange={fc("bank_name")} />
            </FormField>
            <FormField label="الفرع">
              <Input value={checkForm.branch} onChange={fc("branch")} />
            </FormField>
            <FormField label="المبلغ" required>
              <Input
                required
                type="number"
                min="0.01"
                step="0.01"
                value={checkForm.amount}
                onChange={fc("amount")}
              />
            </FormField>
            <FormField label="العملة">
              <Select value={checkForm.currency} onChange={fc("currency")}>
                <option value="NIS">شيكل</option>
                <option value="USD">دولار</option>
                <option value="JOD">دينار</option>
              </Select>
            </FormField>
            <FormField label="تاريخ الاستحقاق">
              <Input type="date" value={checkForm.due_date} onChange={fc("due_date")} />
            </FormField>
            <FormField label="الحساب البنكي">
              <Select value={checkForm.bank_account_id} onChange={fc("bank_account_id")}>
                <option value="">— اختر حساباً —</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="ملاحظات" className="ui-field--full">
              <Textarea value={checkForm.notes} onChange={fc("notes")} />
            </FormField>
          </FormGrid>
        </form>
      </Modal>
    </div>
  );
}
