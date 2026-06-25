import { useCallback, useEffect, useMemo, useState } from "react";

import { useSearchParams } from "react-router-dom";

import api from "../apiClient";

import { getAuthHeaders } from "../utils/auth";

import { ils, dateTime } from "../utils/format";

import { displayEntityCode, displayListRowNumber } from "../utils/entityCodeDisplay";

import {

  PageHeader,

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

import HesabatiImportCard from "../components/HesabatiImportCard";
import HesabatiStatementModal from "../components/HesabatiStatementModal";
import StatementHistoryImportModal from "../components/StatementHistoryImportModal";



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

  balance_group_id: "",

};



export default function CustomerManagement() {

  const toast = useToast();

  const [searchParams, setSearchParams] = useSearchParams();

  const [tab, setTab] = useState("list");

  const [balanceGroups, setBalanceGroups] = useState([]);

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

  const [statementCustomer, setStatementCustomer] = useState(null);
  const [historyImportCustomer, setHistoryImportCustomer] = useState(null);

  const [balances, setBalances] = useState(null);

  const [showAddGroup, setShowAddGroup] = useState(false);

  const [newGroupLabel, setNewGroupLabel] = useState("");

  const [savingGroup, setSavingGroup] = useState(false);



  const activeGroupSlug = searchParams.get("group") || "";

  const activeGroup = useMemo(

    () => balanceGroups.find((g) => g.slug === activeGroupSlug) || balanceGroups[0] || null,

    [balanceGroups, activeGroupSlug]

  );



  const loadGroups = useCallback(async () => {

    try {

      const { data } = await api.get("/api/customers/meta/balance-groups", { headers: getAuthHeaders() });

      setBalanceGroups(Array.isArray(data) ? data : []);

    } catch {

      toast.error("تعذّر تحميل فئات الأرصدة");

    }

  }, [toast]);



  const load = useCallback(async (q, groupId) => {

    setLoading(true);

    try {

      const params = new URLSearchParams();

      if (q) params.set("q", q);

      if (groupId) params.set("balance_group_id", String(groupId));

      const qs = params.toString();

      const { data } = await api.get(qs ? `/api/customers?${qs}` : "/api/customers", {

        headers: getAuthHeaders(),

      });

      setCustomers(data);

    } catch {

      toast.error("تعذّر تحميل العملاء");

    } finally {

      setLoading(false);

    }

  }, [toast]);



  const loadBalances = useCallback(async (groupId) => {

    try {

      const qs = groupId ? `only_open=1&balance_group_id=${groupId}` : "only_open=1";

      const { data } = await api.get(`/api/customers/balances?${qs}`, { headers: getAuthHeaders() });

      setBalances(data);

    } catch {

      toast.error("تعذّر تحميل الأرصدة");

    }

  }, [toast]);



  useEffect(() => { loadGroups(); }, [loadGroups]);



  useEffect(() => {

    if (!balanceGroups.length) return;

    if (!activeGroupSlug || !balanceGroups.some((g) => g.slug === activeGroupSlug)) {

      const next = new URLSearchParams(searchParams);

      next.set("group", balanceGroups[0].slug);

      setSearchParams(next, { replace: true });

    }

  }, [balanceGroups, activeGroupSlug, searchParams, setSearchParams]);



  useEffect(() => {

    if (!activeGroup) return;

    load(search, activeGroup.id);

  }, [load, search, activeGroup]);



  useEffect(() => {

    if (tab === "balances" && activeGroup) loadBalances(activeGroup.id);

  }, [tab, loadBalances, activeGroup]);



  function selectGroup(group) {

    const next = new URLSearchParams(searchParams);

    next.set("group", group.slug);

    setSearchParams(next);

  }



  function startNew() {

    setEditing(null);

    setForm({

      ...emptyForm,

      balance_group_id: activeGroup ? String(activeGroup.id) : "",

    });

    setShowForm(true);

  }



  function startEdit(c) {

    setEditing(c);

    setForm({

      customer_code: c.customer_code || "", name: c.name || "", phone: c.phone || "",

      phone2: c.phone2 || "", address: c.address || "", city: c.city || "",

      price_category: c.price_category || "retail", credit_limit: c.credit_limit || 0,

      payment_terms: c.payment_terms || "", opening_balance: c.opening_balance || 0, notes: c.notes || "",

      balance_group_id: c.balance_group_id ? String(c.balance_group_id) : "",

    });

    setShowForm(true);

  }



  async function save(e) {

    e.preventDefault();

    setSaving(true);

    try {

      const payload = {

        ...form,

        balance_group_id: form.balance_group_id ? Number(form.balance_group_id) : null,

      };

      if (editing) {

        await api.put(`/api/customers/${editing.id}`, payload, { headers: getAuthHeaders() });

        toast.success("تم تحديث العميل");

      } else {

        await api.post("/api/customers", payload, { headers: getAuthHeaders() });

        toast.success("تمت إضافة العميل");

      }

      setShowForm(false);

      load(search, activeGroup?.id);

    } catch (e2) {

      toast.error(e2.response?.data?.error || "فشل الحفظ");

    } finally {

      setSaving(false);

    }

  }



  async function saveGroup(e) {

    e.preventDefault();

    const label = newGroupLabel.trim();

    if (!label) return;

    setSavingGroup(true);

    try {

      const { data } = await api.post(

        "/api/customers/meta/balance-groups",

        { label_ar: label },

        { headers: getAuthHeaders() }

      );

      toast.success("تمت إضافة الفئة");

      setShowAddGroup(false);

      setNewGroupLabel("");

      await loadGroups();

      const next = new URLSearchParams(searchParams);

      next.set("group", data.slug);

      setSearchParams(next);

    } catch (e2) {

      toast.error(e2.response?.data?.error || "فشل إضافة الفئة");

    } finally {

      setSavingGroup(false);

    }

  }



  async function deleteCustomer(c) {

    if (!window.confirm(`حذف العميل "${c.name}"؟`)) return;

    try {

      await api.delete(`/api/customers/${c.id}`, { headers: getAuthHeaders() });

      toast.success("تم حذف العميل");

      load(search, activeGroup?.id);

    } catch (e) {

      toast.error(e.response?.data?.error || e.message || "فشل الحذف");

    }

  }



  function openStatementReport(c) {
    setStatementCustomer(c);
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

    { key: "customer_code", header: "الرقم", className: "num", value: (c) => displayEntityCode(c.customer_code), render: (c, i) => displayListRowNumber(0, 0, i) },

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

          <Button variant="ghost" size="sm" icon="finance" onClick={() => openStatementReport(c)}>عرض التقرير</Button>
          <Button variant="ghost" size="sm" icon="download" onClick={() => setHistoryImportCustomer(c)}>استيراد كشف قديم</Button>
          <Button variant="ghost" size="sm" icon="vouchers" onClick={() => openLedger(c)}>حركات النظام</Button>

          <Button variant="ghost" size="sm" icon="edit" onClick={() => startEdit(c)}>تعديل</Button>

          <Button variant="ghost" size="sm" icon="trash" onClick={() => deleteCustomer(c)} />

        </div>

      ),

    },

  ];



  const balanceColumns = [

    { key: "customer_code", header: "الرقم", className: "num", value: (c) => displayEntityCode(c.customer_code), render: (c, i) => displayListRowNumber(0, 0, i) },

    { key: "name", header: "الاسم" },

    { key: "phone", header: "الجوال", value: (c) => c.phone || "—", render: (c) => c.phone || "—" },

    { key: "balance", header: "الرصيد", align: "left", className: "num", value: (c) => ils(c.balance), render: (c) => <span className={c.balance > 0 ? "negative" : "positive"}>{ils(c.balance)}</span> },

    { key: "credit_limit", header: "حد الائتمان", align: "left", className: "num", value: (c) => (c.credit_limit > 0 ? ils(c.credit_limit) : "—"), render: (c) => (c.credit_limit > 0 ? ils(c.credit_limit) : "—") },

  ];



  const activeGroupTotals = useMemo(() => {

    if (!balances?.group_totals || !activeGroup) return null;

    return balances.group_totals.find((g) => g.id === activeGroup.id) || null;

  }, [balances, activeGroup]);



  const reportConfig = useMemo(() => {

    const groupLabel = activeGroup?.label_ar || "العملاء";

    if (tab === "balances" && balances) {

      return {

        title: `تقرير أرصدة — ${groupLabel}`,

        columns: pickExportColumns(balanceColumns),

        rows: balances.customers || [],

        filename: `customer-balances-${activeGroup?.slug || "all"}`,

        summary: [

          { label: "إجمالي المستحق", value: ils(balances.total_due) },

          { label: "إجمالي الرصيد الدائن", value: ils(balances.total_credit) },

        ],

      };

    }

    return {

      title: groupLabel,

      columns: pickExportColumns(columns),

      rows: customers,

      filename: `customers-${activeGroup?.slug || "all"}`,

    };

  }, [tab, customers, balances, activeGroup, columns, balanceColumns]);



  const uploadQuery = activeGroup ? `balance_group_id=${activeGroup.id}` : "";



  return (

    <div className="office-page" dir="rtl" lang="ar">

      <PageHeader

        icon="customers"

        title="إدارة العملاء"

        subtitle="أرصدة الزبون، المشغلين، العمارة — وفئات إضافية"

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



      {balanceGroups.length > 0 && (

        <Tabs

          active={activeGroup?.slug || ""}

          onChange={(slug) => {

            const g = balanceGroups.find((gr) => gr.slug === slug);

            if (g) selectGroup(g);

          }}

          tabs={balanceGroups.map((g) => ({ id: g.slug, label: g.label_ar }))}

          action={

            <button

              type="button"

              className="ui-tab ui-tab--action"

              onClick={() => setShowAddGroup(true)}

              title="فئة جديدة"

            >

              <Icon name="plus" size={16} />

              فئة جديدة

            </button>

          }

        />

      )}



      {tab === "list" && (

        <>

          <HesabatiImportCard

            title={`استيراد أرصدة — ${activeGroup?.label_ar || "العملاء"}`}

            description="ارفع ملف Excel من حساباتي — يُربط بالفئة المحددة أعلاه."

            uploadUrl="/api/admin/customers/upload"

            uploadQuery={uploadQuery}

            apiPost={(url, fd, config) => api.post(url, fd, config)}

            getAuthHeaders={getAuthHeaders}

            onSuccess={() => load(search, activeGroup?.id)}

          />



          <div className="ui-toolbar">

            <SearchInput

              placeholder="بحث بالاسم أو الجوال أو الرقم…"

              value={search}

              onChange={(e) => setSearch(e.target.value)}

            />

          </div>

          <DataTable

            columns={columns}

            rows={customers}

            loading={loading}

            emptyIcon="customers"

            empty="لا يوجد عملاء في هذه الفئة"

            emptyHint="أضف عميلاً أو استورد أرصدة من حساباتي"

          />

        </>

      )}



      {tab === "balances" && balances && (

        <>

          <div className="ui-stat-grid">

            <div className="ui-stat">

              <div className="ui-stat__icon ui-stat__icon--red"><Icon name="finance" /></div>

              <div>

                <div className="ui-stat__label">إجمالي المستحق — {activeGroup?.label_ar}</div>

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

            {activeGroupTotals ? (

              <div className="ui-stat">

                <div className="ui-stat__icon ui-stat__icon--blue"><Icon name="customers" /></div>

                <div>

                  <div className="ui-stat__label">عدد العملاء</div>

                  <div className="ui-stat__value">{activeGroupTotals.customer_count}</div>

                </div>

              </div>

            ) : null}

          </div>

          <DataTable

            columns={balanceColumns}

            rows={balances.customers}

            emptyIcon="check"

            empty="لا توجد أرصدة مفتوحة في هذه الفئة"

          />

        </>

      )}



      <Modal

        open={showAddGroup}

        title="فئة أرصدة جديدة"

        onClose={() => { setShowAddGroup(false); setNewGroupLabel(""); }}

        footer={

          <>

            <Button onClick={saveGroup} disabled={savingGroup || !newGroupLabel.trim()}>

              {savingGroup ? "جاري الحفظ…" : "إضافة"}

            </Button>

            <Button variant="secondary" onClick={() => { setShowAddGroup(false); setNewGroupLabel(""); }}>إلغاء</Button>

          </>

        }

      >

        <form onSubmit={saveGroup}>

          <FormField label="اسم الفئة" required hint="مثال: أرصدة الجملة">

            <Input

              required

              value={newGroupLabel}

              onChange={(e) => setNewGroupLabel(e.target.value)}

              placeholder="أرصدة …"

              autoFocus

            />

          </FormField>

        </form>

      </Modal>



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

            <FormField label="رقم العميل"><Input value={form.customer_code} onChange={f("customer_code")} placeholder="يُولَّد تلقائياً إن تُرك فارغاً" /></FormField>

            <FormField label="الاسم" required><Input required value={form.name} onChange={f("name")} /></FormField>

            <FormField label="الجوال"><Input value={form.phone} onChange={f("phone")} /></FormField>

            <FormField label="جوال 2"><Input value={form.phone2} onChange={f("phone2")} /></FormField>

            <FormField label="العنوان"><Input value={form.address} onChange={f("address")} /></FormField>

            <FormField label="المدينة"><Input value={form.city} onChange={f("city")} /></FormField>

            <FormField label="فئة الأرصدة">

              <Select value={form.balance_group_id} onChange={f("balance_group_id")}>

                <option value="">— اختر —</option>

                {balanceGroups.map((g) => (

                  <option key={g.id} value={g.id}>{g.label_ar}</option>

                ))}

              </Select>

            </FormField>

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



      <Modal

        open={!!ledgerCustomer}

        title={ledgerCustomer ? `حركات النظام: ${ledgerCustomer.name}` : ""}

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

      <HesabatiStatementModal
        open={!!statementCustomer}
        partyType="customer"
        party={statementCustomer}
        onClose={() => setStatementCustomer(null)}
      />

      <StatementHistoryImportModal
        open={!!historyImportCustomer}
        partyType="customer"
        party={historyImportCustomer}
        onClose={() => setHistoryImportCustomer(null)}
        onSuccess={() => load(search, activeGroup?.id)}
      />
    </div>

  );

}

