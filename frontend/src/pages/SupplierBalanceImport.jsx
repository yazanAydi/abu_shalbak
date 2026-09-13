import { useRef, useState } from "react";
import { todayISO } from "../utils/format";
import { Link } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import {
  PageHeader,
  Card,
  CardBody,
  Button,
  FormField,
  Input,
  useToast,
} from "../components/ui";
import SupplierBalanceImportPreview from "../components/SupplierBalanceImportPreview";
import ImportSummaryModal from "./productDashboard/ImportSummaryModal";

function todayIso() {
  return todayISO();
}

function isSystemSupplierListFilename(name) {
  return /suppliers-\d{4}-\d{2}-\d{2}/i.test(name || "")
    || /supplier-balances-\d{4}-\d{2}-\d{2}/i.test(name || "");
}

export default function SupplierBalanceImport() {
  const toast = useToast();
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [openingDate, setOpeningDate] = useState(todayIso());
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [includeTestRows, setIncludeTestRows] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState(null);
  const [summary, setSummary] = useState(null);
  const recoveryFileRef = useRef(null);
  const [recoveryFile, setRecoveryFile] = useState(null);
  const [recoveryPreview, setRecoveryPreview] = useState(null);
  const [recoverySummary, setRecoverySummary] = useState(null);
  const [deleteMistakenCustomers, setDeleteMistakenCustomers] = useState(false);
  const [recoveryPreviewing, setRecoveryPreviewing] = useState(false);
  const [recoveryConfirming, setRecoveryConfirming] = useState(false);

  function onFileChange(ev) {
    const f = ev.target.files?.[0] || null;
    setFile(f);
    setPreview(null);
  }

  const transferFile = Boolean(
    isSystemSupplierListFilename(file?.name)
    || preview?.type === "abu_shalbak_supplier_list"
    || preview?.overwriteIgnored
  );

  function buildQueryParams() {
    const params = new URLSearchParams();
    if (!transferFile && overwriteExisting) params.set("overwrite_existing_opening_balances", "1");
    if (openingDate) params.set("opening_balance_date", openingDate);
    if (transferFile && includeTestRows) params.set("include_test_rows", "1");
    return params.toString();
  }

  async function onPreview() {
    if (!file) {
      toast.error("اختر ملفاً أولاً");
      return;
    }
    setPreviewing(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const qs = buildQueryParams();
      const url = `/api/admin/import/supplier-balances/preview${qs ? `?${qs}` : ""}`;
      const { data } = await api.post(url, fd, { headers: getAuthHeaders() });
      const payload = data?.data ?? data;
      setPreview(payload);
      toast.success("تمت المعاينة — راجع النتائج ثم أكّد الاستيراد");
    } catch (e) {
      const msg = e.response?.data?.detail || e.response?.data?.error || e.message || "فشلت المعاينة";
      toast.error(msg);
    } finally {
      setPreviewing(false);
    }
  }

  async function onRecoveryPreview() {
    if (!recoveryFile) {
      toast.error("اختر ملفاً أولاً");
      return;
    }
    setRecoveryPreviewing(true);
    try {
      const fd = new FormData();
      fd.append("file", recoveryFile);
      const { data } = await api.post("/api/admin/import/supplier-recovery/preview", fd, {
        headers: getAuthHeaders(),
      });
      setRecoveryPreview(data?.data ?? data);
      toast.success("تمت معاينة الاسترداد — راجع الصفوف ثم أكّد");
    } catch (e) {
      const msg = e.response?.data?.detail || e.response?.data?.error || e.message || "فشلت المعاينة";
      toast.error(msg);
    } finally {
      setRecoveryPreviewing(false);
    }
  }

  async function onRecoveryConfirm() {
    if (!recoveryFile || !recoveryPreview) {
      toast.error("نفّذ معاينة الاسترداد أولاً");
      return;
    }
    setRecoveryConfirming(true);
    try {
      const fd = new FormData();
      fd.append("file", recoveryFile);
      const qs = new URLSearchParams();
      if (deleteMistakenCustomers) qs.set("delete_customers", "1");
      if (openingDate) qs.set("opening_balance_date", openingDate);
      const url = `/api/admin/import/supplier-recovery/confirm${qs.toString() ? `?${qs}` : ""}`;
      const { data } = await api.post(url, fd, { headers: getAuthHeaders() });
      const payload = data?.data ?? data;
      setRecoverySummary(payload);
      setRecoveryPreview(null);
      setRecoveryFile(null);
      if (recoveryFileRef.current) recoveryFileRef.current.value = "";
      toast.success(payload.message || "تم الاسترداد");
    } catch (e) {
      const msg = e.response?.data?.detail || e.response?.data?.error || e.message || "فشل الاسترداد";
      toast.error(msg);
    } finally {
      setRecoveryConfirming(false);
    }
  }

  async function onConfirm() {
    if (!file) {
      toast.error("اختر ملفاً أولاً");
      return;
    }
    if (!preview) {
      toast.error("نفّذ المعاينة أولاً");
      return;
    }
    if (!openingDate) {
      toast.error("حدّد تاريخ الرصيد الافتتاحي");
      return;
    }
    setConfirming(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const qs = buildQueryParams();
      const url = `/api/admin/import/supplier-balances/confirm${qs ? `?${qs}` : ""}`;
      const { data } = await api.post(url, fd, { headers: getAuthHeaders() });
      const payload = data?.data ?? data;
      setSummary(payload);
      setPreview(null);
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      toast.success(payload.message || "تم الاستيراد بنجاح");
    } catch (e) {
      const msg = e.response?.data?.detail || e.response?.data?.error || e.message || "فشل الاستيراد";
      toast.error(msg);
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="ui-page">
      <PageHeader
        title="استيراد أرصدة الموردين"
        subtitle="ينشئ بطاقات في إدارة الموردين فقط — ليس زبائن. يقبل ملف حساباتي أو تصدير CSV موقّع من إدارة الموردين"
        actions={
          <Link to="/suppliers" className="ui-link">
            ← العودة للموردين
          </Link>
        }
      />

      <Card>
        <CardBody>
          <p style={{ color: "var(--office-text-muted)", marginTop: 0 }}>
            لنقل الموردين بين جهازين (تطوير → متجر): لا تُنسَخ قاعدة البيانات. صدّر CSV جديداً بعد
            هذا التحديث — الملفات القديمة بعلامة ₪ مرفوضة لأنها لا تفرّق بين مستحق ودائن.
          </p>
          <ol style={{ color: "var(--office-text-muted)", paddingInlineStart: "1.25rem" }}>
            <li>على جهاز التطوير: إدارة الموردين → تصدير CSV (ملف suppliers-YYYY-MM-DD.csv موقّع).</li>
            <li>انسخ الملف إلى جهاز المتجر (USB أو الشبكة). لا تنسخ supermarket.db.</li>
            <li>على جهاز المتجر: انسخ احتياطياً ./data/supermarket.db ثم npm run store:up بعد إعادة بناء الصورة.</li>
            <li>ارفع الملف هنا. اترك «تجاوز الأرصدة» مطفأ. اترك «تضمين صفوف تجريبية» مطفأ إلا إذا أردت oo / test.</li>
            <li>راجع المعاينة (جديد / موجود / تعارض رقم / مرفوض) ثم أكّد. إعادة الرفع لا تضيف شيئاً.</li>
          </ol>

          <FormField label="ملف حساباتي Excel أو تصدير قائمة الموردين (suppliers-YYYY-MM-DD.csv)">
            <Input
              ref={fileRef}
              type="file"
              accept=".xlsx,.csv"
              onChange={onFileChange}
            />
          </FormField>

          <FormField label="تاريخ الرصيد الافتتاحي">
            <Input
              type="date"
              value={openingDate}
              onChange={(e) => setOpeningDate(e.target.value)}
            />
          </FormField>

          {!transferFile && (
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1rem" }}>
            <input
              type="checkbox"
              checked={overwriteExisting}
              onChange={(e) => setOverwriteExisting(e.target.checked)}
            />
            تجاوز الأرصدة الافتتاحية المستوردة سابقاً من حساباتي
          </label>
          )}

          {transferFile && (
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1rem" }}>
            <input
              type="checkbox"
              checked={includeTestRows}
              onChange={(e) => setIncludeTestRows(e.target.checked)}
            />
            تضمين صفوف تجريبية (الاسم oo أو الرقم test)
          </label>
          )}

          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            <Button type="button" onClick={onPreview} disabled={!file || previewing}>
              {previewing ? "جاري المعاينة…" : "معاينة"}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={onConfirm}
              disabled={!file || !preview || confirming}
            >
              {confirming ? "جاري الاستيراد…" : "تأكيد الاستيراد"}
            </Button>
          </div>

          {file && (
            <p style={{ marginTop: "0.75rem", color: "var(--office-text-muted)", fontSize: "0.9rem" }}>
              الملف المحدد: {file.name}
            </p>
          )}
        </CardBody>
      </Card>

      <div style={{ marginTop: "1rem" }}>
        <SupplierBalanceImportPreview preview={preview} />
      </div>

      <Card style={{ marginTop: "1.5rem" }}>
        <CardBody>
          <h3 style={{ marginTop: 0 }}>استرداد موردين استُوردوا كزبائن</h3>
          <p style={{ color: "var(--office-text-muted)" }}>
            ارفع ملف Excel من حساباتي أو missing-suppliers.xlsx. لنقل قائمة الموردين بين الأجهزة
            ارفع suppliers-YYYY-MM-DD.csv من القسم أعلاه — ليس هنا. يُنشئ الموردين الناقصين.
            يحذف زبائن «عميل آجل» برصيد صفر فقط إذا طابقت بصمة الاستيراد ولم تكن لها حركات.
            رقم Excel ليس رقم الزبون.
          </p>
          <FormField label="ملف Excel">
            <Input
              ref={recoveryFileRef}
              type="file"
              accept=".xlsx,.csv"
              onChange={(e) => {
                setRecoveryFile(e.target.files?.[0] || null);
                setRecoveryPreview(null);
              }}
            />
          </FormField>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1rem" }}>
            <input
              type="checkbox"
              checked={deleteMistakenCustomers}
              onChange={(e) => setDeleteMistakenCustomers(e.target.checked)}
            />
            حذف الزبائن الآمنين فقط بعد إنشاء الموردين (المرتبطون يبقون للمراجعة)
          </label>
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            <Button type="button" onClick={onRecoveryPreview} disabled={!recoveryFile || recoveryPreviewing}>
              {recoveryPreviewing ? "جاري المعاينة…" : "معاينة الاسترداد"}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={onRecoveryConfirm}
              disabled={!recoveryFile || !recoveryPreview || recoveryConfirming}
            >
              {recoveryConfirming ? "جاري التنفيذ…" : "تأكيد الاسترداد"}
            </Button>
          </div>
        </CardBody>
      </Card>

      {recoveryPreview && (
        <Card style={{ marginTop: "1rem" }}>
          <CardBody>
            <h3 style={{ marginTop: 0 }}>معاينة الاسترداد</h3>
            <p>
              موردون جدد: {recoveryPreview.stats?.suppliersToCreate ?? 0} — موجودون:{" "}
              {recoveryPreview.stats?.suppliersExisting ?? 0} — زبائن يمكن حذفهم:{" "}
              {recoveryPreview.stats?.customersSafeToDelete ?? 0} — للمراجعة:{" "}
              {recoveryPreview.stats?.customersReview ?? 0}
            </p>
            {(recoveryPreview.review || []).length > 0 && (
              <details open>
                <summary>صفوف للمراجعة ({recoveryPreview.review.length})</summary>
                <ul>
                  {recoveryPreview.review.map((r, i) => (
                    <li key={`${r.excelRow}-${i}`}>
                      صف {r.excelRow} — {r.name} — {r.reason}
                      {r.customerId ? ` (زبون #${r.customerId}، كود ${r.customerCode || "—"})` : ""}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </CardBody>
        </Card>
      )}

      <ImportSummaryModal
        open={Boolean(summary)}
        onClose={() => setSummary(null)}
        data={summary}
      />
      <ImportSummaryModal
        open={Boolean(recoverySummary)}
        onClose={() => setRecoverySummary(null)}
        data={recoverySummary}
      />
    </div>
  );
}
