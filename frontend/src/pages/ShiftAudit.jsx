import { useCallback, useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils } from "../utils/format";
import { SHIFT_VARIANCE_WARNING } from "../components/ShiftEnd";
import {
  PageHeader,
  Card,
  CardBody,
  DataTable,
  Modal,
  FormField,
  FormGrid,
  Input,
  Select,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
  ReportToolbar,
  useToast,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";

const PM = { cash: "نقد", visa: "بطاقة" };

function movementLabel(t) {
  const ar = {
    opening: "افتتاح",
    payment: "بيع نقدي",
    refund: "استرجاع",
    adjustment: "تسوية",
    closing: "إغلاق",
  };
  return ar[t] || t;
}

function shiftStatusBadge(status) {
  if (status === "open") {
    return <StatusBadge tone="green">مفتوحة</StatusBadge>;
  }
  if (status === "pending_count") {
    return <StatusBadge tone="orange">بانتظار العد</StatusBadge>;
  }
  return <StatusBadge tone="neutral">مغلقة</StatusBadge>;
}

function formatDt(v) {
  return v ? v.replace("T", " ").slice(0, 16) : "—";
}

export default function ShiftAudit() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [pendingRows, setPendingRows] = useState([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [cashierId, setCashierId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reconcileTarget, setReconcileTarget] = useState(null);
  const [closingCash, setClosingCash] = useState("");
  const [reconcileNotes, setReconcileNotes] = useState("");
  const [reconcileLoading, setReconcileLoading] = useState(false);

  const loadPending = useCallback(async () => {
    setPendingLoading(true);
    try {
      const { data } = await api.get("/api/shifts/pending", { headers: getAuthHeaders() });
      setPendingRows(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "تعذّر تحميل الورديات المعلقة");
      setPendingRows([]);
    } finally {
      setPendingLoading(false);
    }
  }, [toast]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (["open", "pending_count", "closed"].includes(status)) params.set("status", status);
      if (String(cashierId).trim() !== "") params.set("cashier_id", String(cashierId).trim());
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);
      const q = params.toString();
      const { data } = await api.get(`/api/shifts${q ? `?${q}` : ""}`, {
        headers: getAuthHeaders(),
      });
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "تعذّر التحميل");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [status, cashierId, dateFrom, dateTo, toast]);

  useEffect(() => {
    loadPending();
    load();
  }, [loadPending, load]);

  async function openDetail(id) {
    setDetail(null);
    setDetailLoading(true);
    try {
      const { data } = await api.get(`/api/shifts/${id}`, { headers: getAuthHeaders() });
      setDetail(data);
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "تعذّر فتح التفاصيل");
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    setDetail(null);
  }

  function openReconcile(row) {
    setReconcileTarget(row);
    setClosingCash("");
    setReconcileNotes("");
  }

  function closeReconcile() {
    setReconcileTarget(null);
    setClosingCash("");
    setReconcileNotes("");
  }

  async function submitReconcile(e) {
    e.preventDefault();
    if (!reconcileTarget?.id) return;
    const v = Number(String(closingCash).replace(",", "."));
    if (Number.isNaN(v) || v < 0) {
      toast.error("أدخل مبلغاً صالحاً");
      return;
    }
    setReconcileLoading(true);
    const shiftId = reconcileTarget.id;
    try {
      const { data } = await api.post(
        `/api/shifts/${shiftId}/reconcile`,
        { closing_cash: v, notes: reconcileNotes.trim() || null },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      if (data.requires_approval) {
        toast.info(data.warning || "تم الإغلاق — الفارق يتجاوز الحد");
      } else {
        toast.success("تم عد النقد وإغلاق الوردية");
      }
      closeReconcile();
      loadPending();
      load();
      if (detail?.shift?.id === shiftId) {
        openDetail(shiftId);
      }
    } catch (e2) {
      toast.error(e2.response?.data?.error || e2.message || "فشل التسوية");
    } finally {
      setReconcileLoading(false);
    }
  }

  async function downloadCsv(shiftId) {
    try {
      const res = await api.get(`/api/shifts/${shiftId}/export.csv`, {
        headers: getAuthHeaders(),
        responseType: "blob",
      });
      const blob = new Blob([res.data], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `shift-${shiftId}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "فشل التصدير");
    }
  }

  const varianceWarn = (v) =>
    v != null && !Number.isNaN(Number(v)) && Math.abs(Number(v)) > SHIFT_VARIANCE_WARNING;

  const pendingColumns = [
    { key: "cashier", header: "الكاشير", value: (r) => r.cashier_name || r.cashier_id, render: (r) => r.cashier_name || r.cashier_id },
    { key: "start", header: "البداية", value: (r) => formatDt(r.start_time), render: (r) => formatDt(r.start_time) },
    { key: "end", header: "نهاية الوردية", value: (r) => formatDt(r.end_time), render: (r) => formatDt(r.end_time) },
    {
      key: "expected",
      header: "النقد المتوقع",
      className: "num",
      value: (r) => (r.expected_cash != null ? ils(r.expected_cash) : "—"),
      render: (r) => (r.expected_cash != null ? ils(r.expected_cash) : "—"),
    },
    {
      key: "actions",
      header: "",
      render: (r) => (
        <>
          <PrimaryButton size="sm" type="button" onClick={() => openReconcile(r)} style={{ marginLeft: "0.35rem" }}>
            عد النقد
          </PrimaryButton>
          <SecondaryButton size="sm" type="button" onClick={() => openDetail(r.id)}>
            تفاصيل
          </SecondaryButton>
        </>
      ),
    },
  ];

  const columns = [
    { key: "cashier", header: "الكاشير", value: (r) => r.cashier_name || r.cashier_id, render: (r) => r.cashier_name || r.cashier_id },
    { key: "start", header: "البداية", value: (r) => formatDt(r.start_time), render: (r) => formatDt(r.start_time) },
    { key: "end", header: "النهاية", value: (r) => formatDt(r.end_time), render: (r) => formatDt(r.end_time) },
    {
      key: "opening",
      header: "افتتاح",
      className: "num",
      value: (r) => ils(r.opening_cash ?? 0),
      render: (r) => ils(r.opening_cash ?? 0),
    },
    {
      key: "closing",
      header: "إغلاق",
      className: "num",
      value: (r) => (r.closing_cash != null ? ils(r.closing_cash) : "—"),
      render: (r) => (r.closing_cash != null ? ils(r.closing_cash) : "—"),
    },
    {
      key: "expected",
      header: "متوقع",
      className: "num",
      value: (r) => (r.expected_cash != null ? ils(r.expected_cash) : "—"),
      render: (r) => (r.expected_cash != null ? ils(r.expected_cash) : "—"),
    },
    {
      key: "variance",
      header: "الفرق",
      className: "num",
      value: (r) =>
        r.variance != null ? `${r.variance >= 0 ? "+" : ""}${ils(r.variance)}` : "—",
      render: (r) =>
        r.variance != null ? (
          <span className={varianceWarn(r.variance) ? "negative" : ""}>
            {r.variance >= 0 ? "+" : ""}
            {ils(r.variance)}
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "status",
      header: "الحالة",
      value: (r) => {
        if (r.status === "open") return "مفتوحة";
        if (r.status === "pending_count") return "بانتظار العد";
        return "مغلقة";
      },
      render: (r) => shiftStatusBadge(r.status),
    },
    {
      key: "view",
      header: "",
      render: (r) => (
        <SecondaryButton size="sm" type="button" onClick={() => openDetail(r.id)}>
          تفاصيل
        </SecondaryButton>
      ),
    },
  ];

  const reconcilePreview =
    reconcileTarget?.expected_cash != null && closingCash !== ""
      ? Number(closingCash) - Number(reconcileTarget.expected_cash)
      : null;

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title="تدقيق الورديات"
        subtitle="مراجعة الورديات والفروقات النقدية"
        icon="shifts"
        actions={
          <ReportToolbar
            title="تدقيق الورديات"
            subtitle="سجل الورديات"
            columns={pickExportColumns(columns)}
            rows={rows}
            filename="shift-audit"
            disabled={loading}
          />
        }
      />

      <Card>
        <CardBody flush>
          <h2 className="dashboard-subtitle" style={{ padding: "1rem 1rem 0" }}>
            ورديات بانتظار العد ({pendingRows.length})
          </h2>
          <DataTable
            columns={pendingColumns}
            rows={pendingRows}
            loading={pendingLoading}
            empty="لا توجد ورديات بانتظار العد"
            emptyIcon="shifts"
          />
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <FormGrid>
            <FormField label="الحالة">
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">الكل</option>
                <option value="open">مفتوحة</option>
                <option value="pending_count">بانتظار العد</option>
                <option value="closed">مغلقة</option>
              </Select>
            </FormField>
            <FormField label="رقم الكاشير">
              <Input
                type="number"
                min="1"
                placeholder="اختياري"
                value={cashierId}
                onChange={(e) => setCashierId(e.target.value)}
              />
            </FormField>
            <FormField label="من تاريخ">
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </FormField>
            <FormField label="إلى تاريخ">
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </FormField>
          </FormGrid>
          <PrimaryButton type="button" onClick={load} disabled={loading} style={{ marginTop: "1rem" }}>
            بحث
          </PrimaryButton>
        </CardBody>
      </Card>

      <Card>
        <CardBody flush>
          <DataTable
            columns={columns}
            rows={rows}
            loading={loading}
            empty="لا توجد ورديات"
            emptyIcon="shifts"
          />
        </CardBody>
      </Card>

      <Modal
        open={!!reconcileTarget}
        onClose={closeReconcile}
        title={reconcileTarget ? `عد النقد — وردية #${reconcileTarget.id}` : ""}
        footer={
          <>
            <PrimaryButton type="submit" form="reconcile-form" disabled={reconcileLoading}>
              {reconcileLoading ? "جاري الحفظ…" : "تأكيد وإغلاق"}
            </PrimaryButton>
            <SecondaryButton type="button" onClick={closeReconcile}>
              إلغاء
            </SecondaryButton>
          </>
        }
      >
        {reconcileTarget ? (
          <form id="reconcile-form" onSubmit={submitReconcile}>
            <p style={{ color: "var(--office-text-muted)", lineHeight: 1.6 }}>
              {reconcileTarget.cashier_name} — النقد المتوقع:{" "}
              {reconcileTarget.expected_cash != null ? ils(reconcileTarget.expected_cash) : "—"}
            </p>
            <FormField label="النقد الفعلي في الدرج">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={closingCash}
                onChange={(e) => setClosingCash(e.target.value)}
                required
                autoFocus
              />
            </FormField>
            {reconcilePreview != null && !Number.isNaN(reconcilePreview) ? (
              <p style={{ marginBottom: "0.75rem" }}>
                الفارق (معاينة):{" "}
                <span className={varianceWarn(reconcilePreview) ? "negative" : ""}>
                  {reconcilePreview >= 0 ? "+" : ""}
                  {ils(reconcilePreview)}
                </span>
              </p>
            ) : null}
            <FormField label="ملاحظات (اختياري)">
              <Input value={reconcileNotes} onChange={(e) => setReconcileNotes(e.target.value)} />
            </FormField>
          </form>
        ) : null}
      </Modal>

      <Modal
        open={!!detail || detailLoading}
        onClose={closeDetail}
        title={detailLoading ? "جاري التحميل…" : `وردية #${detail?.shift?.id}`}
        size="lg"
        footer={
          <>
            {detail?.shift?.status === "pending_count" ? (
              <PrimaryButton type="button" onClick={() => openReconcile(detail.shift)}>
                عد النقد
              </PrimaryButton>
            ) : null}
            <PrimaryButton type="button" onClick={() => downloadCsv(detail?.shift?.id)}>
              تصدير CSV
            </PrimaryButton>
            <SecondaryButton type="button" onClick={closeDetail}>
              إغلاق
            </SecondaryButton>
          </>
        }
      >
        {detailLoading ? (
          <p style={{ color: "var(--office-text-muted)" }}>جاري تحميل تفاصيل الوردية…</p>
        ) : detail ? (
          <>
            <p style={{ color: "var(--office-text-muted)", lineHeight: 1.6 }}>
              {detail.shift?.cashier_name} — افتتاح {ils(detail.shift?.opening_cash ?? 0)}
              {detail.shift?.status === "closed" ? (
                <>
                  {" "}
                  — إغلاق {ils(detail.shift?.closing_cash ?? 0)} — متوقع{" "}
                  {ils(detail.shift?.expected_cash ?? 0)} — فرق{" "}
                  <span className={varianceWarn(detail.shift?.variance) ? "negative" : ""}>
                    {detail.shift?.variance != null
                      ? `${detail.shift.variance >= 0 ? "+" : ""}${ils(detail.shift.variance)}`
                      : "—"}
                  </span>
                </>
              ) : detail.shift?.status === "pending_count" ? (
                <>
                  {" "}
                  — بانتظار العد — متوقع{" "}
                  {detail.summary?.expected != null ? ils(detail.summary.expected) : "—"}
                </>
              ) : (
                <>
                  {" "}
                  — متوقع حالياً{" "}
                  {detail.summary?.expected != null ? ils(detail.summary.expected) : "—"}
                </>
              )}
            </p>

            <h3 className="dashboard-subtitle">حركة النقد (زمنياً)</h3>
            <ul className="dashboard-stock-list">
              {(detail.cash_movements || []).map((m) => (
                <li key={m.id}>
                  <span>
                    {m.created_at} — {movementLabel(m.movement_type)} — {m.description || ""}
                  </span>
                  <span className="num">{ils(m.amount)}</span>
                </li>
              ))}
            </ul>

            <h3 className="dashboard-subtitle">المبيعات</h3>
            <ul className="dashboard-stock-list">
              {(detail.transactions || []).map((t) => (
                <li key={t.id}>
                  <span>
                    {t.created_at} — بيع #{t.id} — {PM[t.payment_method] || t.payment_method}
                  </span>
                  <span className="num">{ils(t.total)}</span>
                </li>
              ))}
            </ul>

            <h3 className="dashboard-subtitle">الاسترجاعات</h3>
            <ul className="dashboard-stock-list">
              {(detail.refunds || []).map((r) => (
                <li key={r.id}>
                  <span>
                    {r.created_at} — استرجاع #{r.id} — {PM[r.payment_method] || r.payment_method}
                  </span>
                  <span className="num">{ils(r.total)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
