import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils } from "../utils/format";
import {
  PageHeader, Card, CardBody, Button, DataTable, Modal, Tabs,
  FormField, FormGrid, Input, Textarea, Icon, SearchInput, ReportToolbar, useToast,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";
import { displayEntityCode, displayListRowNumber } from "../utils/entityCodeDisplay";
import { supplierBalanceView, SUPPLIER_BALANCE_SUMMARY_LABELS } from "../utils/supplierBalanceDisplay";
import HesabatiStatementModal from "../components/HesabatiStatementModal";
import StatementHistoryImportModal from "../components/StatementHistoryImportModal";
import useAuthUser from "../hooks/useAuthUser";
import { isAdminRole } from "../utils/roles";
import { userHasOfficePermission } from "../utils/accountantPermissions";
import { supplierAsVoucherParty, voucherDraftPath } from "../utils/voucherDraft";
import SupplierPurchaseItemsView from "../components/SupplierPurchaseItemsView";

function renderSupplierBalance(systemBalance) {
  const { displayAmount, className } = supplierBalanceView(systemBalance);
  return <span className={className}>{ils(displayAmount)}</span>;
}

/** Signed system balance for CSV transfer: positive = we owe, negative = supplier credit. */
function supplierBalanceExportValue(systemBalance) {
  const n = Number(systemBalance);
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(2);
}

function supplierExportCode(supplier) {
  const code = supplier?.supplier_code != null ? String(supplier.supplier_code).trim() : "";
  return code ? displayEntityCode(code) : "";
}

const emptyForm = {
  supplier_code: "", name: "", contact_phone: "", contact_email: "",
  address: "", payment_terms: "", opening_balance: 0, notes: "",
};

export default function SupplierManagement() {
  const toast = useToast();
  const navigate = useNavigate();
  const user = useAuthUser();
  // Statement-history imports write history and stay admin-only.
  const canImport = isAdminRole(user?.role);
  const canVouchers = userHasOfficePermission(user, "vouchers");
  const [tab, setTab] = useState("list");
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statementSupplier, setStatementSupplier] = useState(null);
  const [purchasesSupplier, setPurchasesSupplier] = useState(null);
  const [historyImportSupplier, setHistoryImportSupplier] = useState(null);
  const [balances, setBalances] = useState(null);

  const load = useCallback(async (q) => {
    setLoading(true);
    try {
      const { data } = await api.get(
        q ? `/api/suppliers?q=${encodeURIComponent(q)}` : "/api/suppliers",
        { headers: getAuthHeaders() }
      );
      setSuppliers(data);
    } catch { toast.error("تعذّر تحميل الموردين"); }
    finally { setLoading(false); }
  }, [toast]);

  const loadBalances = useCallback(async () => {
    try {
      const { data } = await api.get("/api/suppliers/balances?only_open=1", { headers: getAuthHeaders() });
      setBalances(data);
    } catch { toast.error("تعذّر تحميل الأرصدة"); }
  }, [toast]);

  // Debounced so typing a name costs one request instead of one per keystroke;
  // an empty box loads immediately so the first paint is not delayed.
  useEffect(() => {
    const term = search.trim();
    if (!term) {
      load("");
      return undefined;
    }
    const timer = window.setTimeout(() => load(term), 300);
    return () => window.clearTimeout(timer);
  }, [search, load]);

  useEffect(() => { if (tab === "balances") loadBalances(); }, [tab, loadBalances]);

  function startNew() { setEditing(null); setForm(emptyForm); setShowForm(true); }
  function startEdit(s) {
    setEditing(s);
    setForm({
      supplier_code: s.supplier_code || "", name: s.name || "", contact_phone: s.contact_phone || "",
      contact_email: s.contact_email || "", address: s.address || "", payment_terms: s.payment_terms || "",
      opening_balance: s.opening_balance || 0, notes: s.notes || "",
    });
    setShowForm(true);
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/api/suppliers/${editing.id}`, form, { headers: getAuthHeaders() });
        toast.success("تم تحديث المورد");
      } else {
        await api.post("/api/suppliers", form, { headers: getAuthHeaders() });
        toast.success("تمت إضافة المورد");
      }
      setShowForm(false);
      load(search);
    } catch (e2) { toast.error(e2.response?.data?.error || "فشل الحفظ"); }
    finally { setSaving(false); }
  }

  async function remove(s) {
    if (!window.confirm(`حذف المورد "${s.name}"؟`)) return;
    try {
      await api.delete(`/api/suppliers/${s.id}`, { headers: getAuthHeaders() });
      toast.success("تم الحذف");
      load(search);
    } catch (e) { toast.error(e.response?.data?.error || "فشل الحذف"); }
  }

  function openStatementReport(s) {
    setStatementSupplier(s);
  }

  const f = (key) => (e) => setForm((p) => ({ ...p, [key]: e.target.value }));

  const columns = [
    { key: "supplier_code", header: "الرقم", className: "num", hideOnMobile: true, value: (s) => supplierExportCode(s), render: (s, i) => displayListRowNumber(0, 0, i) },
    { key: "name", header: "الاسم", value: (s) => s.name, render: (s) => <strong>{s.name}</strong> },
    { key: "contact_phone", header: "الهاتف", value: (s) => s.contact_phone || "", render: (s) => s.contact_phone || "—" },
    { key: "payment_terms", header: "شروط الدفع", hideOnMobile: true, value: (s) => s.payment_terms || "", render: (s) => s.payment_terms || "—" },
    { key: "balance", header: "الرصيد (مستحق)", align: "left", className: "num", value: (s) => supplierBalanceExportValue(s.balance), render: (s) => renderSupplierBalance(s.balance) },
    {
      key: "actions", header: "إجراءات", className: "ui-table__actions-cell",
      render: (s) => (
        <div className="ui-table__actions ui-table__actions--split">
          <div className="ui-table__actions-cluster">
            <Button variant="ghost" size="sm" icon="finance" onClick={() => openStatementReport(s)}>عرض التقرير</Button>
            <Button variant="ghost" size="sm" icon="products" onClick={() => setPurchasesSupplier(s)}>المنتجات المشتراة</Button>
            {canImport ? (
              <Button variant="ghost" size="sm" icon="download" onClick={() => setHistoryImportSupplier(s)}>استيراد كشف قديم</Button>
            ) : null}
            <Button variant="ghost" size="sm" icon="edit" onClick={() => startEdit(s)}>تعديل</Button>
            <Button variant="ghost" size="sm" icon="trash" onClick={() => remove(s)} />
          </div>
          {canVouchers ? (
            <div className="ui-table__actions-cluster ui-table__actions-cluster--end">
              <Button
                variant="ghost"
                size="sm"
                icon="voucherPayment"
                onClick={() => navigate(voucherDraftPath("payment", supplierAsVoucherParty(s)))}
              >
                سند صرف
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon="voucherReceipt"
                onClick={() => navigate(voucherDraftPath("receipt", supplierAsVoucherParty(s)))}
              >
                سند قبض
              </Button>
            </div>
          ) : null}
        </div>
      ),
    },
  ];

  const balanceColumns = [
    { key: "supplier_code", header: "الرقم", className: "num", hideOnMobile: true, value: (s) => supplierExportCode(s), render: (s, i) => displayListRowNumber(0, 0, i) },
    { key: "name", header: "الاسم" },
    { key: "contact_phone", header: "الهاتف", value: (s) => s.contact_phone || "", render: (s) => s.contact_phone || "—" },
    { key: "balance", header: "الرصيد", align: "left", className: "num", value: (s) => supplierBalanceExportValue(s.balance), render: (s) => renderSupplierBalance(s.balance) },
  ];

  const reportConfig = useMemo(() => {
    if (tab === "balances" && balances) {
      return {
        title: "تقرير أرصدة الموردين",
        columns: pickExportColumns(balanceColumns),
        rows: balances.suppliers || [],
        filename: "supplier-balances",
        summary: [
          { label: SUPPLIER_BALANCE_SUMMARY_LABELS.payable, value: ils(balances.total_payable) },
          { label: SUPPLIER_BALANCE_SUMMARY_LABELS.receivable, value: ils(balances.total_advance) },
        ],
      };
    }
    return {
      title: "إدارة الموردين",
      columns: pickExportColumns(columns),
      rows: suppliers,
      filename: "suppliers",
    };
  }, [tab, suppliers, balances]);

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        icon="suppliers"
        title="إدارة الموردين"
        subtitle="بطاقات الموردين، الأرصدة وكشوف الحسابات"
        actions={
          <>
            <ReportToolbar
              title={reportConfig.title}
              columns={reportConfig.columns}
              rows={reportConfig.rows}
              filename={reportConfig.filename}
              summary={reportConfig.summary}
              disabled={loading}
              getExportRows={
                tab === "list"
                  ? async () => {
                      const { data } = await api.get("/api/suppliers", {
                        params: { all: 1 },
                        headers: getAuthHeaders(),
                      });
                      return Array.isArray(data) ? data : [];
                    }
                  : undefined
              }
            />
            <Button icon="plus" onClick={startNew}>مورد جديد</Button>
          </>
        }
      />

      {canImport ? (
      <Card>
        <CardBody>
          <h3 style={{ marginTop: 0 }}>استيراد أرصدة الموردين</h3>
          <p style={{ color: "var(--office-text-muted)" }}>
            ملف حساباتي Excel، أو تصدير CSV موقّع من هذه الشاشة لنقل الموردين إلى جهاز آخر.
            صدّر بعد هذا التحديث — الملفات القديمة بعلامة ₪ لا تفرّق بين مستحق ودائن.
          </p>
          <Link to="/import-supplier-balances">
            <Button icon="suppliers">فتح صفحة الاستيراد</Button>
          </Link>
        </CardBody>
      </Card>
      ) : null}

      <Tabs active={tab} onChange={setTab} tabs={[
        { id: "list", label: "الموردون", icon: "suppliers" },
        { id: "balances", label: "تقرير الأرصدة", icon: "finance" },
      ]} />

      {tab === "list" && (
        <>
          <div className="ui-toolbar">
            <SearchInput
              placeholder="بحث بالاسم أو الهاتف أو الرقم…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <DataTable columns={columns} rows={suppliers} loading={loading} emptyIcon="suppliers" empty="لا يوجد موردون" />
        </>
      )}

      {tab === "balances" && balances && (
        <>
          <div className="ui-stat-grid">
            <div className="ui-stat">
              <div className="ui-stat__icon ui-stat__icon--red"><Icon name="finance" /></div>
              <div><div className="ui-stat__label">{SUPPLIER_BALANCE_SUMMARY_LABELS.payable}</div><div className="ui-stat__value">{ils(balances.total_payable)}</div></div>
            </div>
            <div className="ui-stat">
              <div className="ui-stat__icon ui-stat__icon--green"><Icon name="finance" /></div>
              <div><div className="ui-stat__label">{SUPPLIER_BALANCE_SUMMARY_LABELS.receivable}</div><div className="ui-stat__value">{ils(balances.total_advance)}</div></div>
            </div>
          </div>
          <DataTable
            columns={balanceColumns}
            rows={balances.suppliers}
            empty="لا توجد أرصدة مفتوحة"
            emptyIcon="check"
          />
        </>
      )}

      <Modal
        open={showForm}
        title={editing ? "تعديل مورد" : "مورد جديد"}
        onClose={() => setShowForm(false)}
        size="lg"
        footer={<>
          <Button onClick={save} disabled={saving}>{saving ? "جاري الحفظ…" : "حفظ"}</Button>
          <Button variant="secondary" onClick={() => setShowForm(false)}>إلغاء</Button>
        </>}
      >
        <form onSubmit={save}>
          <FormGrid>
            <FormField label="رقم المورد"><Input value={form.supplier_code} onChange={f("supplier_code")} placeholder="يُولَّد تلقائياً إن تُرك فارغاً" /></FormField>
            <FormField label="الاسم" required><Input required value={form.name} onChange={f("name")} /></FormField>
            <FormField label="الهاتف"><Input value={form.contact_phone} onChange={f("contact_phone")} /></FormField>
            <FormField label="البريد الإلكتروني"><Input value={form.contact_email} onChange={f("contact_email")} /></FormField>
            <FormField label="العنوان"><Input value={form.address} onChange={f("address")} /></FormField>
            <FormField label="شروط الدفع" hint="مثال: صافي 30 يوم"><Input value={form.payment_terms} onChange={f("payment_terms")} /></FormField>
            {!editing && <FormField label="رصيد افتتاحي (₪)" hint="موجب = مستحق للمورد"><Input type="number" step="0.01" value={form.opening_balance} onChange={f("opening_balance")} /></FormField>}
            <FormField label="ملاحظات" className="ui-field--full"><Textarea value={form.notes} onChange={f("notes")} /></FormField>
          </FormGrid>
        </form>
      </Modal>

      <HesabatiStatementModal
        open={!!statementSupplier}
        partyType="supplier"
        party={statementSupplier}
        onClose={() => setStatementSupplier(null)}
      />

      <Modal
        open={!!purchasesSupplier}
        title={purchasesSupplier ? `المنتجات المشتراة: ${purchasesSupplier.name}` : ""}
        onClose={() => setPurchasesSupplier(null)}
        size="lg"
        footer={<Button onClick={() => setPurchasesSupplier(null)}>إغلاق</Button>}
      >
        {purchasesSupplier && <SupplierPurchaseItemsView supplierId={purchasesSupplier.id} />}
      </Modal>

      <StatementHistoryImportModal
        open={!!historyImportSupplier}
        partyType="supplier"
        party={historyImportSupplier}
        onClose={() => setHistoryImportSupplier(null)}
        onSuccess={() => load(search)}
      />
    </div>
  );
}
