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

export default function SupplierBalanceImport() {
  const toast = useToast();
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [openingDate, setOpeningDate] = useState(todayIso());
  const [importZeroBalances, setImportZeroBalances] = useState(true);
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState(null);
  const [summary, setSummary] = useState(null);

  function onFileChange(ev) {
    const f = ev.target.files?.[0] || null;
    setFile(f);
    setPreview(null);
  }

  function buildQueryParams() {
    const params = new URLSearchParams();
    if (importZeroBalances) params.set("import_zero_balances", "1");
    if (overwriteExisting) params.set("overwrite_existing_opening_balances", "1");
    if (openingDate) params.set("opening_balance_date", openingDate);
    return params.toString();
  }

  async function onPreview() {
    if (!file) {
      toast.error("اختر ملف Excel أولاً");
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

  async function onConfirm() {
    if (!file) {
      toast.error("اختر ملف Excel أولاً");
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
        subtitle="استيراد الرصيد الافتتاحي من ملف «أرصدة الموردين» في حساباتي — لا يُنشئ فواتير مشتريات"
        actions={
          <Link to="/suppliers" className="ui-link">
            ← العودة للموردين
          </Link>
        }
      />

      <Card>
        <CardBody>
          <FormField label="ملف Excel (الرقم، الاسم، الرصيد)">
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

          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
            <input
              type="checkbox"
              checked={importZeroBalances}
              onChange={(e) => setImportZeroBalances(e.target.checked)}
            />
            استيراد موردين جدد برصيد صفر
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1rem" }}>
            <input
              type="checkbox"
              checked={overwriteExisting}
              onChange={(e) => setOverwriteExisting(e.target.checked)}
            />
            تجاوز الأرصدة الافتتاحية المستوردة سابقاً من حساباتي
          </label>

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

      <ImportSummaryModal
        open={Boolean(summary)}
        onClose={() => setSummary(null)}
        data={summary}
      />
    </div>
  );
}
