import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils, dateTime } from "../utils/format";
import {
  PageHeader,
  Card,
  CardBody,
  Button,
  DataTable,
  Modal,
  Tabs,
  StatusPill,
  FormField,
  FormGrid,
  Input,
  Select,
  Textarea,
  Icon,
  SearchInput,
  ReportToolbar,
  useToast,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";

const CATEGORY_LABELS = {
  retail: "مفرق",
  wholesale: "جملة",
  vip: "مميز VIP",
  credit: "عميل آجل",
  corporate: "شركات",
};

const CATEGORY_TONE = {
  retail: "neutral",
  wholesale: "blue",
  vip: "orange",
  credit: "red",
  corporate: "green",
};

const emptyForm = {
  customer_code: "", name: "", phone: "", phone2: "", address: "", city: "",
  price_category: "retail", credit_limit: 0, payment_terms: "", opening_balance: 0, notes: "",
};

export default function CustomerManagement() {
  const toast = useToast();
  const [tab, setTab] = useState("list");
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ledger, setLedger] = useState(null);
  const [payments, setPayments] = useState([]);
  const [ledgerCustomer, setLedgerCustomer] = useState(null);
  const [balances, setBalances] = useState(null);

  const load = useCallback(async (q) => {
    setLoading(true);
    try {
      const { data } = await api.get(
        q ? `/api/customers?q=${encodeURIComponent(q)}` : "/api/customers",
        { headers: getAuthHeaders() }
      );
      setCustomers(data);
    } catch {
      toast.error("تعذّر تحميل العملاء");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadBalances = useCallback(async () => {
    try {
      const { data } = await api.get("/api/customers/balances?only_open=1", { headers: getAuthHeaders() });
      setBalances(data);
    } catch {
      toast.error("تعذّر تحميل الأرصدة");
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (tab === "balances") loadBalances(); }, [tab, loadBalances]);

  function startNew() {
    setEditing(null);
    setForm(emptyForm);
    setShowForm(true);
  }

  function startEdit(c) {
    setEditing(c);
    setForm({
      customer_code: c.customer_code || "", name: c.name || "", phone: c.phone || "",
      phone2: c.phone2 || "", address: c.address || "", city: c.city || "",
      price_category: c.price_category || "retail", credit_limit: c.credit_limit || 0,
      payment_terms: c.payment_terms || "", opening_balance: c.opening_balance || 0, notes: c.notes || "",
    });
    setShowForm(true);
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/api/customers/${editing.id}`, form, { headers: getAuthHeaders() });
        toast.success("تم تحديث العميل");
      } else {
        await api.post("/api/customers", form, { headers: getAuthHeaders() });
        toast.success("تمت إضافة العميل");
      }
      setShowForm(false);
      load(search);
    } catch (e2) {
      toast.error(e2.response?.data?.error || "فشل الحفظ");
    } finally {
      setSaving(false);
    }
  }

  async function deleteCustomer(c) {
    if (!window.confirm(`حذف العميل "${c.name}"؟`)) return;
    try {
      await api.delete(`/api/customers/${c.id}`, { headers: getAuthHeaders() });
      toast.success("تم حذف العميل");
      load(search);
    } catch (e) {
      toast.error(e.response?.data?.error || "فشل الحذف");
    }
  }

  async function openLedger(c) {
    setLedgerCustomer(c);
    try {
      const [lg, pay] = await Promise.all([
        api.get(`/api/customers/${c.id}/ledger`, { headers: getAuthHeaders() }),
        api.get(`/api/customers/${c.id}/payments`, { headers: getAuthHeaders() }),
      ]);
      setLedger(lg.data);
      setPayments(pay.data);
    } catch (e) {
      toast.error(e.response?.data?.error || "تعذّر تحميل كشف الحساب");
      setLedgerCustomer(null);
    }
  }

  const f = (key) => (e) => setForm((p) => ({ ...p, [key]: e.target.value }));

  const evLabel = { opening: "رصيد افتتاحي", sale: "فاتورة بيع", refund: "مرتجع بيع", payment: "دفعة" };

  const columns = [
    { key: "customer_code", header: "الكود", value: (c) => c.customer_code || "—", render: (c) => c.customer_code || "—" },
    { key: "name", header: "الاسم", value: (c) => c.name, render: (c) => <strong>{c.name}</strong> },
    { key: "phone", header: "الجوال", value: (c) => c.phone || "—", render: (c) => c.phone || "—" },
    {
      key: "price_category", header: "الفئة",
      value: (c) => CATEGORY_LABELS[c.price_category] || c.price_category,
      render: (c) => (
        <StatusPill tone={CATEGORY_TONE[c.price_category] || "neutral"} noDot>
          {CATEGORY_LABELS[c.price_category] || c.price_category}
        </StatusPill>
      ),
    },
    {
      key: "balance", header: "الرصيد", align: "left",
      className: "num",
      value: (c) => ils(c.balance),
      render: (c) => <span className={c.balance > 0 ? "negative" : c.balance < 0 ? "positive" : ""}>{ils(c.balance)}</span>,
    },
    { key: "credit_limit", header: "حد الائتمان", align: "left", className: "num", value: (c) => (c.credit_limit > 0 ? ils(c.credit_limit) : "—"), render: (c) => (c.credit_limit > 0 ? ils(c.credit_limit) : "—") },
    {
      key: "actions", header: "إجراءات",
      render: (c) => (
        <div className="ui-table__actions">
          <Button variant="ghost" size="sm" icon="vouchers" onClick={() => openLedger(c)}>كشف</Button>
          <Button variant="ghost" size="sm" icon="edit" onClick={() => startEdit(c)}>تعديل</Button>
          <Button variant="ghost" size="sm" icon="trash" onClick={() => deleteCustomer(c)} />
        </div>
      ),
    },
  ];

  const balanceColumns = [
    { key: "customer_code", header: "الكود", value: (c) => c.customer_code || "—", render: (c) => c.customer_code || "—" },
    { key: "name", header: "الاسم" },
    { key: "phone", header: "الجوال", value: (c) => c.phone || "—", render: (c) => c.phone || "—" },
    { key: "balance", header: "الرصيد", align: "left", className: "num", value: (c) => ils(c.balance), render: (c) => <span className={c.balance > 0 ? "negative" : "positive"}>{ils(c.balance)}</span> },
    { key: "credit_limit", header: "حد الائتمان", align: "left", className: "num", value: (c) => (c.credit_limit > 0 ? ils(c.credit_limit) : "—"), render: (c) => (c.credit_limit > 0 ? ils(c.credit_limit) : "—") },
  ];

  const reportConfig = useMemo(() => {
    if (tab === "balances" && balances) {
      return {
        title: "تقرير أرصدة العملاء",
        columns: pickExportColumns(balanceColumns),
        rows: balances.customers || [],
        filename: "customer-balances",
        summary: [
          { label: "إجمالي المستحق على العملاء", value: ils(balances.total_due) },
          { label: "إجمالي الرصيد الدائن", value: ils(balances.total_credit) },
        ],
      };
    }
    return {
      title: "إدارة العملاء",
      columns: pickExportColumns(columns),
      rows: customers,
      filename: "customers",
    };
  }, [tab, customers, balances]);

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        icon="customers"
        title="إدارة العملاء"
        subtitle="بطاقات العملاء، الفئات، الأرصدة وكشوف الحسابات"
        actions={
          <>
            <ReportToolbar
              title={reportConfig.title}
              columns={reportConfig.columns}
              rows={reportConfig.rows}
              filename={reportConfig.filename}
              summary={reportConfig.summary}
              disabled={loading}
            />
            <Button icon="plus" onClick={startNew}>عميل جديد</Button>
          </>
        }
      />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "list", label: "العملاء", icon: "customers" },
          { id: "balances", label: "تقرير الأرصدة", icon: "finance" },
        ]}
      />

      {tab === "list" && (
        <>
          <div className="ui-toolbar">
            <SearchInput
              placeholder="بحث بالاسم أو الجوال أو الكود…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                load(e.target.value);
              }}
            />
          </div>
          <DataTable columns={columns} rows={customers} loading={loading} emptyIcon="customers" empty="لا يوجد عملاء" emptyHint="أضف أول عميل للبدء" />
        </>
      )}

      {tab === "balances" && balances && (
        <>
          <div className="ui-stat-grid">
            <div className="ui-stat">
              <div className="ui-stat__icon ui-stat__icon--red"><Icon name="finance" /></div>
              <div>
                <div className="ui-stat__label">إجمالي المستحق على العملاء</div>
                <div className="ui-stat__value">{ils(balances.total_due)}</div>
              </div>
            </div>
            <div className="ui-stat">
              <div className="ui-stat__icon ui-stat__icon--green"><Icon name="finance" /></div>
              <div>
                <div className="ui-stat__label">إجمالي الرصيد الدائن</div>
                <div className="ui-stat__value">{ils(balances.total_credit)}</div>
              </div>
            </div>
          </div>
          <DataTable
            columns={balanceColumns}
            rows={balances.customers}
            emptyIcon="check"
            empty="لا توجد أرصدة مفتوحة"
          />
        </>
      )}

      {/* Form modal */}
      <Modal
        open={showForm}
        title={editing ? "تعديل عميل" : "عميل جديد"}
        onClose={() => setShowForm(false)}
        size="lg"
        footer={
          <>
            <Button onClick={save} disabled={saving}>{saving ? "جاري الحفظ…" : "حفظ"}</Button>
            <Button variant="secondary" onClick={() => setShowForm(false)}>إلغاء</Button>
          </>
        }
      >
        <form onSubmit={save}>
          <FormGrid>
            <FormField label="كود العميل"><Input value={form.customer_code} onChange={f("customer_code")} /></FormField>
            <FormField label="الاسم" required><Input required value={form.name} onChange={f("name")} /></FormField>
            <FormField label="الجوال"><Input value={form.phone} onChange={f("phone")} /></FormField>
            <FormField label="جوال 2"><Input value={form.phone2} onChange={f("phone2")} /></FormField>
            <FormField label="العنوان"><Input value={form.address} onChange={f("address")} /></FormField>
            <FormField label="المدينة"><Input value={form.city} onChange={f("city")} /></FormField>
            <FormField label="الفئة">
              <Select value={form.price_category} onChange={f("price_category")}>
                {Object.entries(CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </FormField>
            <FormField label="حد الائتمان (₪)"><Input type="number" min="0" step="0.01" value={form.credit_limit} onChange={f("credit_limit")} /></FormField>
            <FormField label="شروط الدفع" hint="مثال: صافي 30 يوم"><Input value={form.payment_terms} onChange={f("payment_terms")} /></FormField>
            {!editing && (
              <FormField label="رصيد افتتاحي (₪)" hint="موجب = على العميل"><Input type="number" step="0.01" value={form.opening_balance} onChange={f("opening_balance")} /></FormField>
            )}
            <FormField label="ملاحظات" className="ui-field--full"><Textarea value={form.notes} onChange={f("notes")} /></FormField>
          </FormGrid>
        </form>
      </Modal>

      {/* Ledger modal */}
      <Modal
        open={!!ledgerCustomer}
        title={ledgerCustomer ? `كشف حساب: ${ledgerCustomer.name}` : ""}
        onClose={() => { setLedgerCustomer(null); setLedger(null); }}
        size="lg"
      >
        {ledger && (
          <>
            <div className="detail-header">
              <div>الرصيد الحالي: <strong className={ledger.closing_balance > 0 ? "negative" : ""}>{ils(ledger.closing_balance)}</strong></div>
              <div>الرصيد الافتتاحي: <strong>{ils(ledger.customer.opening_balance)}</strong></div>
            </div>
            <DataTable
              columns={[
                { key: "ev_date", header: "التاريخ", render: (e) => (e.ev_date ? dateTime(e.ev_date) : "—") },
                { key: "ev_type", header: "النوع", render: (e) => evLabel[e.ev_type] || e.ev_type },
                { key: "ref_id", header: "المرجع", render: (e) => (e.ref_id ? `#${e.ref_id}` : "—") },
                { key: "debit", header: "مدين", align: "left", className: "num", render: (e) => (e.debit > 0 ? ils(e.debit) : "—") },
                { key: "credit", header: "دائن", align: "left", className: "num", render: (e) => (e.credit > 0 ? ils(e.credit) : "—") },
                { key: "running_balance", header: "الرصيد", align: "left", className: "num", render: (e) => ils(e.running_balance) },
              ]}
              rows={[ledger.opening, ...ledger.events]}
              rowKey={(e, i) => i}
              empty="لا توجد حركات"
            />
            <h3 style={{ margin: "1.5rem 0 0.5rem", fontSize: "1rem" }}>سجل الدفعات</h3>
            <DataTable
              columns={[
                { key: "voucher_date", header: "التاريخ" },
                { key: "voucher_no", header: "سند رقم", render: (p) => `#${p.voucher_no ?? p.voucher_id}` },
                { key: "amount_nis", header: "المبلغ", align: "left", className: "num", render: (p) => ils(p.amount_nis) },
                { key: "status", header: "الحالة", render: (p) => <StatusPill tone={p.status === "posted" ? "green" : "neutral"}>{p.status === "posted" ? "مرحّل" : "مسودة"}</StatusPill> },
                { key: "recorded_by", header: "بواسطة", render: (p) => p.recorded_by || "—" },
              ]}
              rows={payments}
              empty="لا توجد دفعات"
              emptyIcon="vouchers"
            />
          </>
        )}
      </Modal>
    </div>
  );
}
