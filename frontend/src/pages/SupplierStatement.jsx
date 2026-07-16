import { useCallback, useEffect, useMemo, useState } from "react";
import { todayISO } from "../utils/format";
import { useNavigate, useParams } from "react-router-dom";
import api from "../apiClient";
import { getUser } from "../utils/auth";
import { num, dateOnly } from "../utils/format";
import { exportToCsv } from "../utils/reportExport";
import {
  printSupplierStatement,
  downloadSupplierStatementExcel,
  movementTypeLabel,
  balanceLabel,
} from "../utils/supplierStatementPrint";
import {
  PageHeader,
  Card,
  CardBody,
  StatCard,
  DataTable,
  Button,
  SecondaryButton,
  FormField,
  FormGrid,
  Input,
  Select,
  Textarea,
  SearchInput,
  Modal,
  PrimaryButton,
  useToast,
} from "../components/ui";

const todayIso = () => todayISO();

const TYPE_OPTIONS = [
  { value: "", label: "كل الحركات" },
  { value: "opening_balance", label: "رصيد افتتاحي" },
  { value: "purchase_invoice", label: "فاتورة مشتريات" },
  { value: "supplier_payment", label: "سند دفع" },
  { value: "purchase_return", label: "مرتجع مشتريات" },
  { value: "adjustment", label: "تسوية يدوية" },
];

function amount(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) < 0.009) return "—";
  return num(v);
}

export default function SupplierStatement() {
  const { supplierId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState(null);

  const isAdmin = getUser()?.role === "admin";
  const [adjOpen, setAdjOpen] = useState(false);
  const [adjSaving, setAdjSaving] = useState(false);
  const [adjForm, setAdjForm] = useState({
    entry_date: todayIso(),
    direction: "credit",
    amount: "",
    notes: "",
  });

  const load = useCallback(async () => {
    if (!supplierId) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      if (typeFilter) qs.set("type", typeFilter);
      if (search) qs.set("search", search);
      const { data } = await api.get(
        `/api/suppliers/${supplierId}/statement-ledger?${qs}`
      );
      setReport(data);
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "تعذّر تحميل كشف الحساب");
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [supplierId, from, to, typeFilter, search, toast]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplierId]);

  const supplier = report?.supplier;
  const summary = report?.summary;
  const movements = report?.movements || [];
  const finalBalance = Number(summary?.finalBalance) || 0;
  const finalIsNeg = finalBalance < 0;

  function openSource(row) {
    if (!row?.sourceRoute) return;
    navigate(row.sourceRoute);
  }

  function handlePrint() {
    if (!report) return;
    printSupplierStatement(report);
  }

  async function handleExcel() {
    if (!supplierId) return;
    try {
      await downloadSupplierStatementExcel(api, supplierId, { from, to, type: typeFilter, search });
    } catch (e) {
      toast.error(e.response?.data?.error || "تعذّر تصدير Excel");
    }
  }

  function handleCsv() {
    if (!report) return;
    const rows = movements.map((m) => ({
      date: m.date ? dateOnly(m.date) : "",
      type: movementTypeLabel(m.type),
      documentNo: m.documentNo || "",
      description: m.description || "",
      debit: Number(m.debit) || 0,
      credit: Number(m.credit) || 0,
      runningBalance: Number(m.runningBalance) || 0,
      paymentMethod: m.paymentMethod || "",
      createdBy: m.createdBy || "",
    }));
    exportToCsv(`supplier-statement-${supplierId}`, [
      { key: "date", header: "التاريخ" },
      { key: "type", header: "نوع الحركة" },
      { key: "documentNo", header: "رقم المستند" },
      { key: "description", header: "البيان" },
      { key: "debit", header: "مدين" },
      { key: "credit", header: "دائن" },
      { key: "runningBalance", header: "الرصيد" },
      { key: "paymentMethod", header: "طريقة الدفع" },
      { key: "createdBy", header: "المستخدم" },
    ], rows);
  }

  function openAdjustment() {
    setAdjForm({ entry_date: todayIso(), direction: "credit", amount: "", notes: "" });
    setAdjOpen(true);
  }

  async function submitAdjustment(e) {
    e.preventDefault();
    const amount = Number(adjForm.amount);
    if (!(amount > 0)) {
      toast.error("أدخل مبلغًا أكبر من صفر");
      return;
    }
    setAdjSaving(true);
    try {
      await api.post(`/api/suppliers/${supplierId}/adjustments`, {
        entry_date: adjForm.entry_date || undefined,
        direction: adjForm.direction,
        amount,
        notes: adjForm.notes || undefined,
      });
      toast.success("تمت إضافة التسوية");
      setAdjOpen(false);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.error || "تعذّر حفظ التسوية");
    } finally {
      setAdjSaving(false);
    }
  }

  const columns = useMemo(
    () => [
      { key: "date", header: "التاريخ", render: (m) => (m.date ? dateOnly(m.date) : "—") },
      { key: "type", header: "نوع الحركة", render: (m) => movementTypeLabel(m.type) },
      { key: "documentNo", header: "رقم المستند", className: "num", render: (m) => m.documentNo || "—" },
      { key: "description", header: "البيان", render: (m) => m.description || "—" },
      {
        key: "debit",
        header: "مدين",
        align: "left",
        className: "num statement-debit",
        render: (m) => amount(m.debit),
      },
      {
        key: "credit",
        header: "دائن",
        align: "left",
        className: "num statement-credit",
        render: (m) => amount(m.credit),
      },
      {
        key: "runningBalance",
        header: "الرصيد",
        align: "left",
        className: "num",
        render: (m) => (
          <span className={Number(m.runningBalance) < 0 ? "negative" : ""}>
            {amount(m.runningBalance)}
          </span>
        ),
      },
      { key: "paymentMethod", header: "طريقة الدفع", render: (m) => m.paymentMethod || "—" },
      { key: "createdBy", header: "المستخدم", render: (m) => m.createdBy || "—" },
      {
        key: "actions",
        header: "الإجراءات",
        render: (m) =>
          m.sourceRoute ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                openSource(m);
              }}
            >
              عرض
            </Button>
          ) : (
            "—"
          ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        icon="finance"
        title="كشف حساب المورد"
        subtitle={supplier ? supplier.name : "حركات المورد المالية"}
        actions={
          <>
            <SecondaryButton type="button" onClick={() => navigate("/suppliers")}>
              رجوع للموردين
            </SecondaryButton>
            {isAdmin ? (
              <Button type="button" onClick={openAdjustment} disabled={!report}>
                إضافة تسوية
              </Button>
            ) : null}
            <SecondaryButton type="button" onClick={handlePrint} disabled={!report}>طباعة</SecondaryButton>
            <SecondaryButton type="button" onClick={handlePrint} disabled={!report}>PDF</SecondaryButton>
            <SecondaryButton type="button" onClick={handleExcel} disabled={!report}>Excel</SecondaryButton>
            <SecondaryButton type="button" onClick={handleCsv} disabled={!report}>CSV</SecondaryButton>
          </>
        }
      />

      {supplier ? (
        <Card>
          <CardBody>
            <div className="statement-info">
              <div><strong>المورد:</strong> {supplier.name}</div>
              <div><strong>الهاتف:</strong> {supplier.phone || "—"}</div>
              <div><strong>العنوان:</strong> {supplier.address || "—"}</div>
              <div>
                <strong>الرصيد الحالي:</strong>{" "}
                <span className={Number(supplier.currentBalance) < 0 ? "negative" : ""}>
                  {amount(supplier.currentBalance)}
                </span>{" "}
                ({balanceLabel(supplier.currentBalance)})
              </div>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <div className="ui-stat-grid" style={{ marginTop: 16 }}>
        <StatCard label="الرصيد الافتتاحي" value={amount(summary?.openingBalance)} icon="finance" tone="teal" />
        <StatCard label="إجمالي الفواتير" value={amount(summary?.totalInvoices)} icon="products" tone="orange" />
        <StatCard label="إجمالي الدفعات" value={amount(summary?.totalPayments)} icon="vouchers" tone="green" />
        <StatCard
          label={`الرصيد النهائي — ${balanceLabel(finalBalance)}`}
          value={amount(summary?.finalBalance)}
          icon="finance"
          tone={finalIsNeg ? "red" : "teal"}
        />
      </div>

      <Card style={{ marginTop: 16 }}>
        <CardBody>
          <FormGrid columns={2}>
            <FormField label="من تاريخ">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </FormField>
            <FormField label="إلى تاريخ">
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </FormField>
            <FormField label="نوع الحركة">
              <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                {TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </Select>
            </FormField>
            <FormField label="بحث برقم المستند">
              <SearchInput
                placeholder="رقم فاتورة أو سند…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </FormField>
          </FormGrid>
          <div className="ui-toolbar" style={{ marginTop: 16, gap: 8, flexWrap: "wrap" }}>
            <Button type="button" onClick={load} disabled={loading}>
              {loading ? "جاري التحميل…" : "تطبيق الفلاتر"}
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card style={{ marginTop: 16 }}>
        <CardBody>
          <DataTable
            columns={columns}
            rows={movements}
            loading={loading}
            rowKey={(m) => m.id}
            rowClassName={(m) => (m.sourceRoute ? "row-clickable" : undefined)}
            onRowClick={(m) => m.sourceRoute && openSource(m)}
            emptyIcon="finance"
            empty="لا توجد حركات في الفترة المحددة"
          />
        </CardBody>
      </Card>

      <Modal
        open={adjOpen}
        title="إضافة تسوية يدوية"
        onClose={() => setAdjOpen(false)}
        footer={
          <>
            <SecondaryButton type="button" onClick={() => setAdjOpen(false)} disabled={adjSaving}>
              إلغاء
            </SecondaryButton>
            <PrimaryButton type="submit" form="supplier-adjustment-form" disabled={adjSaving}>
              {adjSaving ? "جاري الحفظ…" : "حفظ"}
            </PrimaryButton>
          </>
        }
      >
        <form id="supplier-adjustment-form" onSubmit={submitAdjustment}>
          <FormGrid columns={2}>
            <FormField label="التاريخ">
              <Input
                type="date"
                value={adjForm.entry_date}
                onChange={(e) => setAdjForm((f) => ({ ...f, entry_date: e.target.value }))}
              />
            </FormField>
            <FormField label="نوع التسوية">
              <Select
                value={adjForm.direction}
                onChange={(e) => setAdjForm((f) => ({ ...f, direction: e.target.value }))}
              >
                <option value="credit">دائن (نزيد ما علينا للمورد)</option>
                <option value="debit">مدين (ننقص ما علينا للمورد)</option>
              </Select>
            </FormField>
            <FormField label="المبلغ">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={adjForm.amount}
                onChange={(e) => setAdjForm((f) => ({ ...f, amount: e.target.value }))}
              />
            </FormField>
            <FormField label="ملاحظات">
              <Textarea
                rows={2}
                value={adjForm.notes}
                onChange={(e) => setAdjForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </FormField>
          </FormGrid>
        </form>
      </Modal>
    </div>
  );
}
