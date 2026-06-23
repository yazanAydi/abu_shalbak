import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils, dateOnly, todayISO } from "../utils/format";
import {
  PageHeader, Button, DataTable, Modal, Tabs, StatusPill,
  FormField, FormGrid, Input, Select, Icon, useToast, ReportToolbar,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";

const PAY_LABELS = { cash: "نقد", transfer: "تحويل", check: "شيك", other: "أخرى" };

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
  const [form, setForm] = useState({ category_id: "", amount: "", paid_on: todayISO(), payment_method: "cash", reference_note: "" });
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
    } catch { toast.error("تعذّر التحميل"); } finally { setLoading(false); }
  }, [from, to, toast]);

  useEffect(() => { loadCategories(); }, [loadCategories]);
  useEffect(() => { loadData(); }, [loadData]);

  async function save() {
    if (!form.category_id) { toast.error("اختر فئة"); return; }
    try {
      await api.post("/api/expenses", { ...form, amount: Number(form.amount) }, { headers: getAuthHeaders() });
      toast.success("تم تسجيل المصروف");
      setShow(false);
      setForm({ category_id: "", amount: "", paid_on: todayISO(), payment_method: "cash", reference_note: "" });
      loadData();
    } catch (e) { toast.error(e.response?.data?.error || "فشل الحفظ"); }
  }

  async function remove(id) {
    if (!window.confirm("حذف المصروف؟")) return;
    try { await api.delete(`/api/expenses/${id}`, { headers: getAuthHeaders() }); toast.success("تم الحذف"); loadData(); }
    catch (e) { toast.error(e.response?.data?.error || "فشل"); }
  }

  async function saveCat() {
    if (!catForm.name.trim()) { toast.error("اسم الفئة مطلوب"); return; }
    try {
      await api.post("/api/expenses/categories", catForm, { headers: getAuthHeaders() });
      toast.success("تمت الإضافة"); setShowCat(false); setCatForm({ name: "", name_ar: "" }); loadCategories();
    } catch (e) { toast.error(e.response?.data?.error || "فشل"); }
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
    { key: "amount", header: "المبلغ", align: "left", className: "num", value: (r) => ils(r.amount), render: (r) => ils(r.amount) },
    { key: "payment_method", header: "طريقة الدفع", value: (r) => PAY_LABELS[r.payment_method] || r.payment_method, render: (r) => <StatusPill tone="neutral" noDot>{PAY_LABELS[r.payment_method] || r.payment_method}</StatusPill> },
    { key: "reference_note", header: "ملاحظة", value: (r) => r.reference_note || "—", render: (r) => r.reference_note || "—" },
    { key: "actions", header: "", render: (r) => <Button variant="ghost" size="sm" icon="trash" onClick={() => remove(r.id)} /> },
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
    { key: "actions", header: "", render: (c) => <Button variant="ghost" size="sm" icon="trash" onClick={() => removeCat(c.id)} /> },
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
            <Button icon="plus" onClick={() => setShow(true)}>مصروف جديد</Button>
          </>
        } />

      <Tabs active={tab} onChange={setTab} tabs={[
        { id: "vouchers", label: "السندات", icon: "vouchers" },
        { id: "reports", label: "التقارير", icon: "finance" },
        { id: "categories", label: "الفئات", icon: "settings" },
      ]} />

      {(tab === "vouchers" || tab === "reports") && (
        <div className="ui-toolbar">
          <FormField label="من"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></FormField>
          <FormField label="إلى"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></FormField>
        </div>
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
              <div className="ui-stat">
                <div className="ui-stat__icon ui-stat__icon--red"><Icon name="expenses" /></div>
                <div><div className="ui-stat__label">إجمالي المصروفات</div><div className="ui-stat__value">{ils(summary.total)}</div></div>
              </div>
              <div className="ui-stat">
                <div className="ui-stat__icon"><Icon name="vouchers" /></div>
                <div><div className="ui-stat__label">عدد السندات</div><div className="ui-stat__value">{summary.count}</div></div>
              </div>
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
            <Select value={form.category_id} onChange={(e) => setForm((f) => ({ ...f, category_id: e.target.value }))}>
              <option value="">— اختر —</option>
              {categories.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{catLabel(c)}</option>)}
            </Select>
          </FormField>
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
