import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils, dateOnly, todayISO } from "../utils/format";
import {
  PageHeader, Button, DataTable, Modal, Tabs, StatusPill, FilterBar, StatCard,
  FormField, FormGrid, Input, Select, useToast, ReportToolbar,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";
import { apiErrorMessage } from "../utils/apiError";

const PAY_LABELS = { cash: "نقد", transfer: "تحويل", check: "شيك", other: "أخرى" };

function paymentLabel(row) {
  if (row?.source === "shop_consumption") return "غير نقدي — استهلاك محل";
  return PAY_LABELS[row?.payment_method] || row?.payment_method;
}

function isSalaryCategory(c) {
  if (!c) return false;
  const name = String(c.name || "").toLowerCase();
  const ar = String(c.name_ar || "");
  return name === "salaries" || name === "salary_advance" || ar.includes("رواتب") || ar.includes("سلف");
}

export default function Expenses() {
  const toast = useToast();
  const [tab, setTab] = useState("vouchers");
  const [categories, setCategories] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [byCat, setByCat] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({
    category_id: "",
    amount: "",
    paid_on: todayISO(),
    payment_method: "cash",
    reference_note: "",
    employee_id: "",
    purpose: "salary_payment",
  });
  const [employees, setEmployees] = useState([]);
  const [showCat, setShowCat] = useState(false);
  const [catForm, setCatForm] = useState({ name: "", name_ar: "" });

  const loadCategories = useCallback(async () => {
    try { const { data } = await api.get("/api/expenses/categories", { headers: getAuthHeaders() }); setCategories(data); }
    catch { /* */ }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const [ex, bc, sm] = await Promise.all([
        api.get(`/api/expenses?${params}`, { headers: getAuthHeaders() }),
        api.get(`/api/expenses/by-category?${params}`, { headers: getAuthHeaders() }),
        api.get(`/api/expenses/summary?${params}`, { headers: getAuthHeaders() }),
      ]);
      setExpenses(ex.data); setByCat(bc.data); setSummary(sm.data);
    } catch (e) { toast.error(apiErrorMessage(e, "تعذّر التحميل")); } finally { setLoading(false); }
  }, [from, to, toast]);

  const loadEmployees = useCallback(async () => {
    try {
      const { data } = await api.get("/api/employees", { headers: getAuthHeaders(), params: { active: "1" } });
      setEmployees(Array.isArray(data) ? data : []);
    } catch {
      setEmployees([]);
    }
  }, []);

  useEffect(() => { loadCategories(); }, [loadCategories]);
  useEffect(() => { loadData(); }, [loadData]);

  const selectedCat = categories.find((c) => String(c.id) === String(form.category_id));
  const salaryLike = isSalaryCategory(selectedCat);
  const advanceCategory = selectedCat && (String(selectedCat.name).toLowerCase() === "salary_advance" || String(selectedCat.name_ar || "").includes("سلف"));

  function emptyForm() {
    return {
      category_id: "",
      amount: "",
      paid_on: todayISO(),
      payment_method: "cash",
      reference_note: "",
      employee_id: "",
      purpose: "salary_payment",
    };
  }

  function openNew() {
    setForm(emptyForm());
    setShow(true);
    loadEmployees();
  }

  async function save() {
    if (!form.category_id) { toast.error("اختر فئة"); return; }
    if (salaryLike && !form.employee_id) {
      toast.error("يجب اختيار موظف لرواتب أو سلفة على الراتب");
      return;
    }
    try {
      const payload = { ...form, amount: Number(form.amount) };
      if (salaryLike) {
        payload.employee_id = Number(form.employee_id);
        payload.purpose = advanceCategory ? "salary_advance" : form.purpose;
      } else {
        delete payload.employee_id;
        delete payload.purpose;
      }
      await api.post("/api/expenses", payload, { headers: getAuthHeaders() });
      toast.success(salaryLike ? "سُجّلت دفعة الموظف عبر المصروفات" : "تم تسجيل المصروف");
      setShow(false);
      setForm(emptyForm());
      loadData();
    } catch (e) { toast.error(apiErrorMessage(e, "فشل الحفظ")); }
  }

  async function remove(id) {
    if (!window.confirm("حذف المصروف؟")) return;
    try { await api.delete(`/api/expenses/${id}`, { headers: getAuthHeaders() }); toast.success("تم الحذف"); loadData(); }
    catch (e) { toast.error(apiErrorMessage(e, "فشل")); }
  }

  async function saveCat() {
    if (!catForm.name.trim()) { toast.error("اسم الفئة مطلوب"); return; }
    try {
      await api.post("/api/expenses/categories", catForm, { headers: getAuthHeaders() });
      toast.success("تمت الإضافة"); setShowCat(false); setCatForm({ name: "", name_ar: "" }); loadCategories();
    } catch (e) { toast.error(apiErrorMessage(e, "فشل")); }
  }
  async function removeCat(id) {
    if (!window.confirm("حذف/تعطيل الفئة؟")) return;
    try { await api.delete(`/api/expenses/categories/${id}`, { headers: getAuthHeaders() }); toast.success("تم"); loadCategories(); }
    catch { toast.error("فشل"); }
  }

  const catLabel = (c) => c.name_ar || c.name;

  const voucherColumns = [
    { key: "paid_on", header: "التاريخ", value: (r) => dateOnly(r.paid_on), render: (r) => dateOnly(r.paid_on) },
    { key: "category", header: "الفئة", value: (r) => r.category_name_ar || r.category_name || r.category || "—", render: (r) => r.category_name_ar || r.category_name || r.category || "—" },
    { key: "employee", header: "الموظف", value: (r) => r.employee_name || "—", render: (r) => r.employee_name || (r.source ? "—" : "بدون موظف") },
    { key: "amount", header: "المبلغ", align: "left", className: "num", value: (r) => ils(r.amount), render: (r) => ils(r.amount) },
    { key: "payment_method", header: "طريقة الدفع", value: (r) => paymentLabel(r), render: (r) => <StatusPill tone="neutral" noDot>{paymentLabel(r)}</StatusPill> },
    { key: "reference_note", header: "ملاحظة", value: (r) => r.reference_note || "—", render: (r) => r.reference_note || "—" },
    { key: "actions", header: "", render: (r) => r.source || r.employee_ledger_id ? null : <Button variant="ghost" size="sm" icon="trash" iconOnly aria-label="حذف" onClick={() => remove(r.id)} /> },
  ];

  const reportColumns = [
    { key: "category_label", header: "الفئة" },
    { key: "count", header: "العدد" },
    { key: "total", header: "الإجمالي", value: (r) => ils(r.total), render: (r) => ils(r.total) },
  ];

  const categoryColumns = [
    { key: "name_ar", header: "الاسم", value: (c) => catLabel(c), render: (c) => catLabel(c) },
    { key: "name", header: "المعرّف" },
    { key: "active", header: "الحالة", value: (c) => (c.active ? "مفعّلة" : "معطّلة"), render: (c) => <StatusPill tone={c.active ? "green" : "neutral"}>{c.active ? "مفعّلة" : "معطّلة"}</StatusPill> },
    { key: "actions", header: "", render: (c) => <Button variant="ghost" size="sm" icon="trash" iconOnly aria-label="حذف" onClick={() => removeCat(c.id)} /> },
  ];

  const reportConfig = useMemo(() => {
    const range = from || to ? `${from || "—"} إلى ${to || "—"}` : undefined;
    if (tab === "reports") {
      return {
        title: "تقرير المصروفات حسب الفئة",
        subtitle: range,
        columns: pickExportColumns(reportColumns),
        rows: byCat,
        filename: "expenses-by-category",
        summary: summary
          ? [
              { label: "إجمالي المصروفات", value: ils(summary.total) },
              { label: "عدد السندات", value: String(summary.count) },
            ]
          : undefined,
      };
    }
    if (tab === "categories") {
      return {
        title: "فئات المصروفات",
        columns: pickExportColumns(categoryColumns),
        rows: categories,
        filename: "expense-categories",
      };
    }
    return {
      title: "سندات المصروفات",
      subtitle: range,
      columns: pickExportColumns(voucherColumns),
      rows: expenses,
      filename: "expense-vouchers",
    };
  }, [tab, from, to, expenses, byCat, categories, summary]);

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader icon="expenses" title="المصروفات" subtitle="سندات المصروفات والفئات والتقارير"
        actions={
          <>
            <ReportToolbar
              title={reportConfig.title}
              subtitle={reportConfig.subtitle}
              columns={reportConfig.columns}
              rows={reportConfig.rows}
              filename={reportConfig.filename}
              summary={reportConfig.summary}
              disabled={loading && tab !== "categories"}
            />
            <Button icon="plus" onClick={openNew}>مصروف جديد</Button>
          </>
        } />

      <Tabs active={tab} onChange={setTab} tabs={[
        { id: "vouchers", label: "السندات", icon: "vouchers" },
        { id: "reports", label: "التقارير", icon: "finance" },
        { id: "categories", label: "الفئات", icon: "settings" },
      ]} />

      {(tab === "vouchers" || tab === "reports") && (
        <FilterBar>
          <FormField label="من" className="ui-field--date"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></FormField>
          <FormField label="إلى" className="ui-field--date"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></FormField>
        </FilterBar>
      )}

      {tab === "vouchers" && (
        <DataTable
          loading={loading}
          columns={voucherColumns}
          rows={expenses}
          emptyIcon="expenses"
          empty="لا توجد مصروفات"
        />
      )}

      {tab === "reports" && (
        <>
          {summary && (
            <div className="ui-stat-grid">
              <StatCard label="إجمالي المصروفات" value={ils(summary.total)} icon="expenses" tone="red" />
              <StatCard label="عدد السندات" value={summary.count} icon="vouchers" />
            </div>
          )}
          <DataTable
            loading={loading}
            columns={reportColumns}
            rows={byCat}
            emptyIcon="finance"
            empty="لا توجد بيانات"
          />
        </>
      )}

      {tab === "categories" && (
        <>
          <div className="ui-toolbar"><Button icon="plus" onClick={() => setShowCat(true)}>فئة جديدة</Button></div>
          <DataTable
            columns={categoryColumns}
            rows={categories}
            emptyIcon="settings"
            empty="لا توجد فئات"
          />
        </>
      )}

      <Modal open={show} title="مصروف جديد" onClose={() => setShow(false)}
        footer={<><Button onClick={save}>حفظ</Button><Button variant="secondary" onClick={() => setShow(false)}>إلغاء</Button></>}>
        <FormGrid>
          <FormField label="الفئة" required>
            <Select value={form.category_id} onChange={(e) => setForm((f) => ({ ...f, category_id: e.target.value, employee_id: f.employee_id, purpose: f.purpose }))}>
              <option value="">— اختر —</option>
              {categories.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{catLabel(c)}</option>)}
            </Select>
          </FormField>
          {salaryLike ? (
            <>
              <FormField label="الموظف" required hint="يُسجَّل كدفعة للموظف">
                <Select value={form.employee_id} onChange={(e) => setForm((f) => ({ ...f, employee_id: e.target.value }))}>
                  <option value="">— اختر موظفاً —</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name}{emp.kind === "cashier" ? " (كاشير)" : ""}
                    </option>
                  ))}
                </Select>
              </FormField>
              {!advanceCategory ? (
                <FormField label="نوع الدفعة" required>
                  <Select value={form.purpose} onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))}>
                    <option value="salary_payment">دفعة راتب</option>
                    <option value="salary_advance">سلفة على الراتب</option>
                  </Select>
                </FormField>
              ) : null}
            </>
          ) : null}
          <FormField label="المبلغ (₪)" required><Input type="number" step="0.01" min="0" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} /></FormField>
          <FormField label="التاريخ"><Input type="date" value={form.paid_on} onChange={(e) => setForm((f) => ({ ...f, paid_on: e.target.value }))} /></FormField>
          <FormField label="طريقة الدفع">
            <Select value={form.payment_method} onChange={(e) => setForm((f) => ({ ...f, payment_method: e.target.value }))}>
              {Object.entries(PAY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </FormField>
          <FormField label="ملاحظة" className="ui-field--full"><Input value={form.reference_note} onChange={(e) => setForm((f) => ({ ...f, reference_note: e.target.value }))} /></FormField>
        </FormGrid>
      </Modal>

      <Modal open={showCat} title="فئة مصروف جديدة" onClose={() => setShowCat(false)}
        footer={<><Button onClick={saveCat}>حفظ</Button><Button variant="secondary" onClick={() => setShowCat(false)}>إلغاء</Button></>}>
        <FormGrid>
          <FormField label="الاسم بالعربية" required><Input value={catForm.name_ar} onChange={(e) => setCatForm((f) => ({ ...f, name_ar: e.target.value }))} /></FormField>
          <FormField label="المعرّف (إنجليزي)" required hint="بدون مسافات، مثل: marketing"><Input value={catForm.name} onChange={(e) => setCatForm((f) => ({ ...f, name: e.target.value }))} /></FormField>
        </FormGrid>
      </Modal>
    </div>
  );
}
