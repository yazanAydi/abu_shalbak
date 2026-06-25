import { useRef, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import {
  Button,
  Modal,
  SecondaryButton,
  FormField,
  Input,
  useToast,
} from "./ui";

function formatAmount(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `-${abs}` : abs;
}

/**
 * @param {{
 *   partyType: "supplier" | "customer",
 *   party: { id: number, name: string, supplier_code?: string, customer_code?: string } | null,
 *   open: boolean,
 *   onClose: () => void,
 *   onSuccess?: () => void,
 * }} props
 */
export default function StatementHistoryImportModal({
  partyType,
  party,
  open,
  onClose,
  onSuccess,
}) {
  const toast = useToast();
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState(null);

  function resetState() {
    setFile(null);
    setPreview(null);
    setOverwriteExisting(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  function handleClose() {
    resetState();
    onClose();
  }

  function onFileChange(ev) {
    setFile(ev.target.files?.[0] || null);
    setPreview(null);
  }

  function buildQueryParams() {
    const params = new URLSearchParams();
    if (overwriteExisting) params.set("overwrite_existing", "1");
    return params.toString();
  }

  function apiBase() {
    return partyType === "supplier" ? "/api/suppliers" : "/api/customers";
  }

  async function onPreview() {
    if (!party?.id) return;
    if (!file) {
      toast.error("اختر ملف Excel أو CSV أو PDF أولاً");
      return;
    }
    setPreviewing(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const qs = buildQueryParams();
      const url = `${apiBase()}/${party.id}/statement-history/preview${qs ? `?${qs}` : ""}`;
      const { data } = await api.post(url, fd, { headers: getAuthHeaders() });
      const payload = data?.data ?? data;
      setPreview(payload);
      if (payload.blocked) {
        toast.error(payload.blockReason || "الاستيراد محظور");
      } else {
        toast.success("تمت المعاينة — راجع النتائج ثم أكّد الاستيراد");
      }
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "فشلت المعاينة");
    } finally {
      setPreviewing(false);
    }
  }

  async function onConfirm() {
    if (!party?.id) return;
    if (!file) {
      toast.error("اختر ملف Excel أو CSV أو PDF أولاً");
      return;
    }
    if (!preview || preview.blocked) {
      toast.error("نفّذ المعاينة أولاً أو أصلح أسباب الحظر");
      return;
    }
    setConfirming(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const qs = buildQueryParams();
      const url = `${apiBase()}/${party.id}/statement-history/confirm${qs ? `?${qs}` : ""}`;
      await api.post(url, fd, { headers: getAuthHeaders() });
      toast.success("تم استيراد كشف الحساب القديم بنجاح");
      resetState();
      onSuccess?.();
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "فشل الاستيراد");
    } finally {
      setConfirming(false);
    }
  }

  const stats = preview?.stats || {};
  const sampleRows = preview?.rows || [];
  const warnings = preview?.balanceWarnings || [];

  return (
    <Modal
      open={open}
      title={party ? `استيراد كشف حساب قديم: ${party.name}` : "استيراد كشف حساب قديم"}
      onClose={handleClose}
      size="lg"
      footer={
        <>
          <SecondaryButton type="button" onClick={onPreview} disabled={previewing || !file}>
            {previewing ? "جاري المعاينة…" : "معاينة"}
          </SecondaryButton>
          <Button
            type="button"
            onClick={onConfirm}
            disabled={confirming || !preview || preview.blocked}
          >
            {confirming ? "جاري الاستيراد…" : "تأكيد الاستيراد"}
          </Button>
          <SecondaryButton type="button" onClick={handleClose}>إلغاء</SecondaryButton>
        </>
      }
    >
      <p style={{ marginTop: 0, color: "var(--office-muted)" }}>
        ارفع ملف كشف حساب من حساباتي (Excel / CSV / PDF) لهذا {partyType === "supplier" ? "المورد" : "العميل"} فقط.
        لا يُنشئ فواتير أو حركات مخزون.
      </p>

      <FormField label="ملف كشف الحساب (Excel / CSV / PDF)">
        <Input
          ref={fileRef}
          type="file"
          accept=".xlsx,.csv,.pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,application/pdf"
          onChange={onFileChange}
        />
      </FormField>

      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1rem" }}>
        <input
          type="checkbox"
          checked={overwriteExisting}
          onChange={(e) => {
            setOverwriteExisting(e.target.checked);
            setPreview(null);
          }}
        />
        تجاوز السجل المستورد سابقاً
      </label>

      {preview ? (
        <div>
          {preview.blocked ? (
            <p style={{ color: "var(--office-danger)" }}>{preview.blockReason}</p>
          ) : null}

          <div className="import-summary-stats" style={{ marginBottom: "1rem" }}>
            {[
              { label: "إجمالي الصفوف", value: stats.totalRows ?? 0 },
              { label: "من تاريخ", value: stats.firstDate || "—" },
              { label: "إلى تاريخ", value: stats.lastDate || "—" },
              { label: "إجمالي مدين", value: formatAmount(stats.totalDebit) },
              { label: "إجمالي دائن", value: formatAmount(stats.totalCredit) },
              { label: "الرصيد النهائي", value: formatAmount(stats.finalBalance) },
              { label: "سجل سابق", value: stats.existingHistoryCount ?? 0 },
            ].map((s) => (
              <div key={s.label} className="import-summary-stat">
                <span className="import-summary-stat__value">{s.value}</span>
                <span className="import-summary-stat__label">{s.label}</span>
              </div>
            ))}
          </div>

          {warnings.length > 0 ? (
            <div className="import-preview-warnings" style={{ marginBottom: "1rem" }}>
              <strong>تحذير — اختلاف في الرصيد التراكمي ({warnings.length}):</strong>
              <ul>
                {warnings.slice(0, 5).map((w) => (
                  <li key={`${w.row}-${w.description}`}>
                    صف {w.row}: متوقع {formatAmount(w.expected)} — في الملف {formatAmount(w.fileBalance)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="hesabati-statement__table-wrap" style={{ maxHeight: "320px" }}>
            <table className="hesabati-statement-table data-table">
              <thead>
                <tr>
                  <th>الرقم</th>
                  <th>البيان</th>
                  <th>التاريخ</th>
                  <th>مدين</th>
                  <th>دائن</th>
                  <th>الرصيد</th>
                </tr>
              </thead>
              <tbody>
                {sampleRows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.legacy_reference_number || "—"}</td>
                    <td>{r.description}</td>
                    <td>{r.entry_date || "—"}</td>
                    <td className="num">{formatAmount(r.debit)}</td>
                    <td className="num">{formatAmount(r.credit)}</td>
                    <td className="num">{formatAmount(r.running_balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
