import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../apiClient";
import ReceiptPreviewModal from "../components/ReceiptPreviewModal";
import { getAuthHeaders } from "../utils/auth";
import { ils } from "../utils/format";
import { firstOfCurrentMonthYmd, todayYmd } from "../utils/reportDates";
import { printEmployeeHistoryStatement } from "../utils/employeeHistoryPrint";
import { reconcileStaffEmployees } from "../utils/reconcileStaffEmployees";
import {
  PageHeader,
  Button,
  Card,
  CardHeader,
  CardBody,
  DataTable,
  FilterBar,
  FormField,
  FormGrid,
  HelpTip,
  Input,
  Select,
  StatCard,
  useToast,
} from "../components/ui";
import { apiErrorMessage } from "../utils/apiError";

export default function EmployeeHistoryStatement() {
  const toast = useToast();
  const [employees, setEmployees] = useState([]);
  const [employeeId, setEmployeeId] = useState("");
  const [from, setFrom] = useState(firstOfCurrentMonthYmd());
  const [to, setTo] = useState(todayYmd());
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState("cash");
  const [payNote, setPayNote] = useState("");
  const [savingPay, setSavingPay] = useState(false);
  const [receiptInvoice, setReceiptInvoice] = useState(null);

  const invoiceLabel = (row) => row.invoice_no || (row.source_id != null ? `#${row.source_id}` : "—");

  const renderInvoiceNo = (row) =>
    row.source_type && row.source_id ? (
      <button
        type="button"
        className="ui-link-btn"
        style={{ textDecoration: "underline" }}
        onClick={() => setReceiptInvoice(row)}
      >
        {invoiceLabel(row)}
      </button>
    ) : (
      invoiceLabel(row)
    );

  const loadEmployees = useCallback(async () => {
    try {
      await reconcileStaffEmployees();
      const { data } = await api.get("/api/employees", { headers: getAuthHeaders() });
      setEmployees(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل تحميل الموظفين"));
    }
  }, [toast]);

  useEffect(() => {
    loadEmployees();
  }, [loadEmployees]);

  const loadReport = useCallback(async () => {
    if (!employeeId) {
      setReport(null);
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.get(`/api/employees/${employeeId}/history`, {
        headers: getAuthHeaders(),
        params: { from, to },
      });
      setReport(data);
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشل تحميل الكشف"));
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [employeeId, from, to, toast]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title="كشف حساب الموظفين"
        subtitle="حركات الرواتب والسلف والذمم حسب الفترة"
        icon="vouchers"
        actions={
          <>
            <Button variant="secondary" onClick={() => printEmployeeHistoryStatement(report)} disabled={!report}>
              طباعة
            </Button>
            <Button variant="secondary" onClick={loadReport} disabled={loading || !employeeId}>
              تحديث
            </Button>
          </>
        }
      />

      <FilterBar>
      <FormGrid>
        <FormField label="الموظف" required>
          <Select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">— اختر موظفاً —</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.name}
                {emp.kind === "cashier" ? " · كاشير" : ""}
                {emp.user_username ? ` (${emp.user_username})` : ""}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="من">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </FormField>
        <FormField label="إلى">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </FormField>
      </FormGrid>
      </FilterBar>
      <p className="ui-text-muted ui-mt-sm">
        القائم يُعرض حتى لو تاريخه خارج الفلتر.{" "}
        <HelpTip>هذه الشاشة ليست محرّر راتب — استخدم رواتب الموظفين للتسوية.</HelpTip>
      </p>
      <p className="ui-text-muted">
        <Link to="/employee-salaries">رواتب الموظفين</Link>
      </p>

      {report ? (
        <>
          {report.debts?.linked ? (
            <Card className="ui-mt-md">
              <CardHeader title="تسجيل تسديد ذمة" />
              <CardBody>
                <p className="ui-text-muted">
                  سند قبض على نفس حساب الذمة. القائم حالياً: {ils(report.debts.customer_balance ?? report.debts.outstanding_as_of ?? 0)}
                </p>
                <FormGrid>
                  <FormField label="المبلغ (₪)" required>
                    <Input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={payAmount}
                      onChange={(e) => setPayAmount(e.target.value)}
                    />
                  </FormField>
                  <FormField label="طريقة الدفع" required>
                    <Select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                      <option value="cash">نقد</option>
                      <option value="transfer">تحويل</option>
                      <option value="check">شيك</option>
                      <option value="other">أخرى</option>
                    </Select>
                  </FormField>
                  <FormField label="ملاحظة" className="ui-field--full">
                    <Input value={payNote} onChange={(e) => setPayNote(e.target.value)} />
                  </FormField>
                </FormGrid>
                <Button
                  onClick={async () => {
                    if (!employeeId) return;
                    const amount = Number(payAmount);
                    if (!Number.isFinite(amount) || amount <= 0) {
                      toast.error("أدخل مبلغاً أكبر من صفر");
                      return;
                    }
                    setSavingPay(true);
                    try {
                      await api.post(
                        `/api/employees/${employeeId}/debt-payments`,
                        {
                          amount,
                          payment_method: payMethod,
                          reference_note: payNote || null,
                          occurred_on: to || undefined,
                        },
                        { headers: getAuthHeaders() }
                      );
                      toast.success("سُجّل تسديد الذمة");
                      setPayAmount("");
                      setPayNote("");
                      await loadReport();
                    } catch (e) {
                      toast.error(apiErrorMessage(e, "فشل تسجيل التسديد"));
                    } finally {
                      setSavingPay(false);
                    }
                  }}
                  disabled={savingPay || loading}
                >
                  تسجيل تسديد ذمة
                </Button>
              </CardBody>
            </Card>
          ) : null}
          <Card className="ui-mt-md">
            <CardHeader title="الرواتب" />
            <CardBody>
              <div className="ui-stat-grid">
                <StatCard label="إجمالي الفترة" value={ils(report.salaries?.period_total || 0)} icon="finance" />
              </div>
              <DataTable
                loading={loading}
                columns={[
                  { key: "date", header: "التاريخ" },
                  { key: "amount", header: "المبلغ", render: (r) => ils(r.amount), className: "num" },
                  { key: "payment_method_label", header: "الطريقة", render: (r) => r.payment_method_label || "—" },
                  { key: "reference", header: "مرجع", render: (r) => r.reference || "—" },
                ]}
                rows={report.salaries?.items || []}
                empty="لا توجد دفعات راتب في الفترة"
              />
            </CardBody>
          </Card>

          <Card className="ui-mt-md">
            <CardHeader title="السلف" />
            <CardBody>
              <div className="ui-stat-grid">
                <StatCard label="إجمالي الفترة" value={ils(report.advances?.period_total || 0)} icon="finance" />
                <StatCard label="المسوّى في الفترة" value={ils(report.advances?.period_settled || 0)} icon="check" tone="green" />
                <StatCard label="القائم حتى نهاية الفلتر" value={ils(report.advances?.outstanding_as_of || 0)} icon="alert" tone="orange" />
              </div>
              <DataTable
                loading={loading}
                columns={[
                  { key: "date", header: "التاريخ" },
                  { key: "amount", header: "المبلغ", render: (r) => ils(r.amount), className: "num" },
                  { key: "settled", header: "المسوّى", render: (r) => ils(r.settled), className: "num" },
                  { key: "remaining", header: "المتبقي", render: (r) => ils(r.remaining), className: "num" },
                  { key: "reason", header: "السبب", render: (r) => r.reason || "—" },
                ]}
                rows={report.advances?.items || []}
                empty="لا توجد سلف في الفترة"
              />
              {(report.advances?.outstanding_items || []).filter(
                (row) => !from || row.date < from || (to && row.date > to)
              ).length ? (
                <>
                  <p className="ui-text-muted">سلف قائمة خارج أيام الفترة — تبقى حتى تُسوّى، وليست ضمن إجمالي الفترة:</p>
                  <DataTable
                    columns={[
                      { key: "date", header: "التاريخ" },
                      { key: "amount", header: "الأصل", render: (r) => ils(r.amount), className: "num" },
                      { key: "remaining", header: "المتبقي", render: (r) => ils(r.remaining), className: "num" },
                      { key: "reason", header: "السبب", render: (r) => r.reason || "—" },
                    ]}
                    rows={(report.advances?.outstanding_items || []).filter(
                      (row) => !from || row.date < from || (to && row.date > to)
                    )}
                    empty="—"
                  />
                </>
              ) : null}
            </CardBody>
          </Card>

          <Card className="ui-mt-md">
            <CardHeader title="الذمم" />
            <CardBody>
              {report.debts?.linked ? (
                <>
                  <div className="ui-stat-grid">
                    <StatCard label="إجمالي فواتير الفترة" value={ils(report.debts?.period_total || 0)} icon="finance" />
                    <StatCard
                      label="القائم حتى نهاية الفلتر"
                      value={ils(report.debts?.outstanding_as_of || 0)}
                      hint={report.debts.customer_name ? `الحساب: ${report.debts.customer_name}` : ""}
                      icon="alert"
                      tone="orange"
                    />
                  </div>
                  <DataTable
                    loading={loading}
                    columns={[
                      { key: "date", header: "التاريخ" },
                      {
                        key: "invoice_no",
                        header: "الفاتورة",
                        render: renderInvoiceNo,
                      },
                      { key: "description", header: "الأصناف", render: (r) => r.description || "—" },
                      {
                        key: "notes",
                        header: "ملاحظات",
                        render: (r) => (
                          <span style={{ whiteSpace: "pre-wrap" }}>{r.notes || "—"}</span>
                        ),
                      },
                      { key: "original", header: "الأصل", render: (r) => ils(r.original), className: "num" },
                      { key: "settled", header: "المسوّى", render: (r) => ils(r.settled), className: "num" },
                      { key: "remaining", header: "المتبقي", render: (r) => ils(r.remaining), className: "num" },
                    ]}
                    rows={report.debts?.items || []}
                    empty="لا توجد فواتير ذمة في الفترة"
                  />
                  {(report.debts?.outstanding_items || []).filter(
                    (row) => !from || row.date < from || (to && row.date > to)
                  ).length ? (
                    <>
                      <p className="ui-text-muted">ذمم قائمة خارج أيام الفترة — تبقى حتى تُسوّى:</p>
                      <DataTable
                        columns={[
                          { key: "date", header: "التاريخ" },
                          {
                            key: "invoice_no",
                            header: "الفاتورة",
                            render: renderInvoiceNo,
                          },
                          { key: "remaining", header: "المتبقي", render: (r) => ils(r.remaining), className: "num" },
                        ]}
                        rows={(report.debts?.outstanding_items || []).filter(
                          (row) => !from || row.date < from || (to && row.date > to)
                        )}
                        empty="—"
                      />
                    </>
                  ) : null}
                </>
              ) : (
                <p className="ui-text-muted">لا توجد ذمم لهذا الموظف.</p>
              )}
            </CardBody>
          </Card>

          <Card className="ui-mt-md">
            <CardHeader title="تسديدات الذمة (سندات قبض)" />
            <CardBody>
              <div className="ui-stat-grid">
                <StatCard label="إجمالي الفترة" value={ils(report.repayments?.period_total || 0)} icon="finance" />
              </div>
              <DataTable
                loading={loading}
                columns={[
                  { key: "date", header: "التاريخ" },
                  { key: "amount", header: "المبلغ", render: (r) => ils(r.amount), className: "num" },
                  { key: "payment_method_label", header: "الطريقة", render: (r) => r.payment_method_label || "—" },
                  { key: "voucher_no", header: "سند", render: (r) => (r.voucher_no != null ? String(r.voucher_no) : "—") },
                  { key: "notes", header: "ملاحظة", render: (r) => r.notes || "—" },
                ]}
                rows={report.repayments?.items || []}
                empty="لا توجد تسديدات ذمة في الفترة"
              />
            </CardBody>
          </Card>
        </>
      ) : (
        <p className="ui-text-muted">{employeeId ? "" : "اختر موظفاً لعرض الكشف."}</p>
      )}

      <ReceiptPreviewModal
        open={!!receiptInvoice}
        employeeId={employeeId}
        invoice={receiptInvoice}
        onClose={() => setReceiptInvoice(null)}
      />
    </div>
  );
}
