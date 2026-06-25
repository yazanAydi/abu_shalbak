import { useState } from "react";
import { Card, CardBody } from "./ui";
import ImportSummaryModal from "../pages/productDashboard/ImportSummaryModal";

/**
 * @param {{
 *   title: string,
 *   description: string,
 *   uploadUrl: string,
 *   uploadQuery?: string,
 *   onSuccess?: () => void | Promise<void>,
 *   getAuthHeaders?: () => Record<string, string>,
 *   apiPost: (url: string, fd: FormData, config?: object) => Promise<{ data: object }>,
 * }} props
 */
export default function HesabatiImportCard({
  title,
  description,
  uploadUrl,
  uploadQuery = "",
  importZeroBalancesDefault = false,
  onSuccess,
  getAuthHeaders,
  apiPost,
}) {
  const [uploading, setUploading] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [summary, setSummary] = useState(null);
  const [importZeroBalances, setImportZeroBalances] = useState(importZeroBalancesDefault);

  async function onUpload(ev) {
    const file = ev.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setFeedback(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const config = getAuthHeaders ? { headers: getAuthHeaders() } : {};
      const params = new URLSearchParams(uploadQuery.replace(/^\?/, ""));
      if (importZeroBalances) params.set("import_zero_balances", "1");
      const qs = params.toString();
      const url = qs
        ? `${uploadUrl}${uploadUrl.includes("?") ? "&" : "?"}${qs}`
        : uploadUrl;
      const { data } = await apiPost(url, fd, config);
      const payload = data?.data ?? data;
      setFeedback({ ok: true, text: payload.message || "تم الاستيراد بنجاح" });
      setSummary(payload);
      if (onSuccess) await onSuccess();
    } catch (e) {
      if (e.response?.status === 404) {
        setFeedback({
          ok: false,
          text: "المسار غير موجود على الخادم — أعد تشغيل الخادم (backend) ثم حدّث الصفحة.",
        });
        return;
      }
      if (e.response?.status === 401) {
        setFeedback({
          ok: false,
          text: "انتهت الجلسة — سجّل الدخول كمسؤول وأعد المحاولة.",
        });
        return;
      }
      const text =
        e.response?.data?.detail ||
        e.response?.data?.error ||
        e.message ||
        "فشل الرفع";
      setFeedback({ ok: false, text });
    } finally {
      setUploading(false);
      ev.target.value = "";
    }
  }

  return (
    <>
      <Card>
        <CardBody>
          <h2 className="dashboard-section-title">{title}</h2>
          <p style={{ color: "var(--office-text-muted)", fontSize: "0.9rem" }}>{description}</p>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.75rem" }}>
            <input
              type="checkbox"
              checked={importZeroBalances}
              onChange={(e) => setImportZeroBalances(e.target.checked)}
              disabled={uploading}
            />
            <span>استيراد الموردين/الزبائن برصيد صفر أيضاً</span>
          </label>
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={onUpload}
            disabled={uploading}
            style={{ marginTop: "0.75rem" }}
          />
          {uploading ? <p>جاري الرفع…</p> : null}
          {feedback ? (
            <p style={{ color: feedback.ok ? "var(--office-success)" : "var(--office-danger)" }}>
              {feedback.text}
            </p>
          ) : null}
        </CardBody>
      </Card>
      <ImportSummaryModal open={!!summary} onClose={() => setSummary(null)} data={summary} />
    </>
  );
}
