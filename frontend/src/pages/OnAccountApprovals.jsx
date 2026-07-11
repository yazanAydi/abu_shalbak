import { useCallback, useEffect, useRef, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils } from "../utils/format";
import {
  PageHeader,
  Card,
  CardBody,
  DataTable,
  Modal,
  FormField,
  Input,
  PrimaryButton,
  SecondaryButton,
  ReportToolbar,
  Tabs,
  useToast,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";

function formatDt(v) {
  return v ? String(v).replace("T", " ").slice(0, 16) : "—";
}

function statusLabel(status) {
  if (status === "approved") return "موافَق";
  if (status === "rejected") return "مرفوض";
  if (status === "pending") return "قيد المراجعة";
  return status || "—";
}

export default function OnAccountApprovals() {
  const toast = useToast();
  const [tab, setTab] = useState("pending");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reviewTarget, setReviewTarget] = useState(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [reviewLoading, setReviewLoading] = useState(false);
  const [staleMessage, setStaleMessage] = useState(null);
  const pollBusy = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (pollBusy.current) return;
    pollBusy.current = true;
    if (!silent) setLoading(true);
    try {
      const path =
        tab === "pending"
          ? "/api/on-account-requests/pending"
          : `/api/on-account-requests/history?status=${tab === "all" ? "all" : tab}`;
      const { data } = await api.get(path, { headers: getAuthHeaders() });
      const payload = data?.data ?? data;
      setRows(Array.isArray(payload) ? payload : []);
    } catch (e) {
      if (!silent) toast.error(e.response?.data?.error || e.message || "تعذّر التحميل");
      if (!silent) setRows([]);
    } finally {
      pollBusy.current = false;
      if (!silent) setLoading(false);
    }
  }, [tab, toast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (tab !== "pending") return undefined;
    const timer = setInterval(() => load(true), 7000);
    return () => clearInterval(timer);
  }, [tab, load]);

  async function openReview(row, action) {
    setStaleMessage(null);
    try {
      const { data } = await api.get(`/api/on-account-requests/${row.id}`, {
        headers: getAuthHeaders(),
      });
      const fresh = data?.data ?? data;
      if (fresh.status !== "pending") {
        setReviewTarget({ ...row, ...fresh, readOnly: true });
        setStaleMessage("هذا الطلب لم يعد قيد المراجعة — العرض للقراءة فقط.");
        setReviewNotes(fresh.review_notes || "");
        return;
      }
      setReviewTarget({ ...row, ...fresh, action, readOnly: false });
      setReviewNotes("");
    } catch (e) {
      toast.error(e.response?.data?.error || "تعذّر فتح الطلب");
    }
  }

  function closeReview() {
    setReviewTarget(null);
    setReviewNotes("");
    setStaleMessage(null);
  }

  async function submitReview(e) {
    e.preventDefault();
    if (!reviewTarget || reviewTarget.readOnly) return;
    setReviewLoading(true);
    try {
      await api.put(
        `/api/on-account-requests/${reviewTarget.id}`,
        { status: reviewTarget.action, review_notes: reviewNotes.trim() || null },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      toast.success(reviewTarget.action === "approved" ? "تمت الموافقة" : "تم الرفض");
      closeReview();
      load();
    } catch (e2) {
      const code = e2.response?.data?.code;
      if (code === "NOT_PENDING") {
        setStaleMessage("تمت معالجة هذا الطلب من قناة أخرى — العرض للقراءة فقط.");
        setReviewTarget((prev) => (prev ? { ...prev, readOnly: true } : prev));
        load(true);
      } else {
        toast.error(e2.response?.data?.error || e2.message || "فشل");
      }
    } finally {
      setReviewLoading(false);
    }
  }

  const baseColumns = [
    { key: "id", header: "#", value: (r) => r.id, render: (r) => r.id },
    {
      key: "cashier",
      header: "الكاشير",
      value: (r) => r.cashier_username || r.cashier_id,
      render: (r) => r.cashier_username || r.cashier_id,
    },
    {
      key: "customer",
      header: "العميل",
      value: (r) => r.customer_name || "—",
      render: (r) => r.customer_name || "—",
    },
    {
      key: "on_account",
      header: "الذمة",
      className: "num",
      value: (r) => ils(r.on_account_amount ?? 0),
      render: (r) => ils(r.on_account_amount ?? 0),
    },
    {
      key: "total",
      header: "الإجمالي",
      className: "num",
      value: (r) => ils(r.total_amount ?? 0),
      render: (r) => ils(r.total_amount ?? 0),
    },
    {
      key: "created",
      header: "التاريخ",
      value: (r) => formatDt(r.created_at),
      render: (r) => formatDt(r.created_at),
    },
  ];

  const columns =
    tab === "pending"
      ? [
          ...baseColumns,
          {
            key: "actions",
            header: "",
            render: (r) => (
              <>
                <PrimaryButton
                  size="sm"
                  type="button"
                  onClick={() => openReview(r, "approved")}
                  style={{ marginLeft: "0.35rem" }}
                >
                  موافقة
                </PrimaryButton>
                <SecondaryButton size="sm" type="button" onClick={() => openReview(r, "rejected")}>
                  رفض
                </SecondaryButton>
              </>
            ),
          },
        ]
      : [
          ...baseColumns,
          {
            key: "status",
            header: "الحالة",
            value: (r) => statusLabel(r.status),
            render: (r) => statusLabel(r.status),
          },
          {
            key: "tx",
            header: "الفاتورة",
            value: (r) => (r.transaction_id ? `#${r.transaction_id}` : "—"),
            render: (r) => (r.transaction_id ? `#${r.transaction_id}` : "—"),
          },
          {
            key: "source",
            header: "المصدر",
            value: (r) =>
              r.decision_source === "telegram"
                ? "تيليجرام"
                : r.decision_source === "admin"
                  ? "لوحة الإدارة"
                  : "—",
            render: (r) =>
              r.decision_source === "telegram"
                ? "تيليجرام"
                : r.decision_source === "admin"
                  ? "لوحة الإدارة"
                  : "—",
          },
          {
            key: "manager",
            header: "المعتمد",
            value: (r) => r.manager_username || "—",
            render: (r) => r.manager_username || "—",
          },
        ];

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title="موافقات الذمة"
        subtitle="مبيعات على الذمة بانتظار الموافقة — تتحدّث تلقائياً كل 7 ثوانٍ"
        icon="vouchers"
        actions={
          <ReportToolbar
            title="موافقات الذمة"
            columns={pickExportColumns(columns)}
            rows={rows}
            filename={`on-account-approvals-${tab}`}
            disabled={loading}
          />
        }
      />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "pending", label: "قيد المراجعة", icon: "vouchers" },
          { id: "approved", label: "موافَق", icon: "check" },
          { id: "rejected", label: "مرفوض", icon: "close" },
          { id: "all", label: "الكل", icon: "list" },
        ]}
      />

      <Card>
        <CardBody flush>
          <DataTable
            columns={columns}
            rows={rows}
            loading={loading}
            empty={
              tab === "pending"
                ? "لا توجد طلبات ذمة بانتظار الموافقة"
                : "لا توجد طلبات في هذا السجل"
            }
            emptyIcon="vouchers"
          />
        </CardBody>
      </Card>

      <Modal
        open={!!reviewTarget}
        onClose={closeReview}
        title={
          reviewTarget
            ? reviewTarget.readOnly
              ? `طلب ذمة #${reviewTarget.id} — للقراءة فقط`
              : reviewTarget.action === "approved"
                ? `موافقة على ذمة #${reviewTarget.id}`
                : `رفض ذمة #${reviewTarget.id}`
            : ""
        }
        footer={
          reviewTarget?.readOnly ? (
            <SecondaryButton type="button" onClick={closeReview}>
              إغلاق
            </SecondaryButton>
          ) : (
            <>
              <PrimaryButton type="submit" form="on-account-review-form" disabled={reviewLoading}>
                {reviewLoading ? "جاري الحفظ…" : "تأكيد"}
              </PrimaryButton>
              <SecondaryButton type="button" onClick={closeReview}>
                إلغاء
              </SecondaryButton>
            </>
          )
        }
      >
        {reviewTarget ? (
          <>
            {staleMessage ? (
              <p style={{ color: "var(--office-warning, #b45309)", marginBottom: "0.75rem" }}>
                {staleMessage}
              </p>
            ) : null}
            <form id="on-account-review-form" onSubmit={submitReview}>
              <p style={{ color: "var(--office-text-muted)", lineHeight: 1.6 }}>
                {reviewTarget.cashier_username} — {reviewTarget.customer_name} — ذمة{" "}
                {ils(reviewTarget.on_account_amount ?? 0)} — إجمالي{" "}
                {ils(reviewTarget.total_amount ?? 0)}
                {reviewTarget.readOnly ? ` — ${statusLabel(reviewTarget.status)}` : null}
              </p>
              {!reviewTarget.readOnly ? (
                <FormField label="ملاحظات (اختياري)">
                  <Input value={reviewNotes} onChange={(e) => setReviewNotes(e.target.value)} />
                </FormField>
              ) : reviewTarget.review_notes ? (
                <p style={{ marginTop: "0.75rem" }}>
                  <strong>ملاحظات:</strong> {reviewTarget.review_notes}
                </p>
              ) : null}
            </form>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
