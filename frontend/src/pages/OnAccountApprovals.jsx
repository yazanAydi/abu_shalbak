import { useCallback, useEffect, useRef, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { useVisiblePoll } from "../hooks/useVisiblePoll";
import { ils, dateTime } from "../utils/format";
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
  Notice,
  useToast,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";
import { apiErrorMessage } from "../utils/apiError";
import { HandoverRejectField } from "../components/CountPendingDecisions";

function formatDt(v) {
  return dateTime(v);
}

function formatQty(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n)) return String(qty ?? "");
  return String(n);
}

function requestItems(row) {
  return Array.isArray(row?.items) ? row.items.filter((it) => it && it.name) : [];
}

function itemsText(row) {
  const items = requestItems(row);
  if (!items.length) return "—";
  return items
    .map((it) => {
      const unit = it.unit_name ? ` ${it.unit_name}` : "";
      return `${it.name} × ${formatQty(it.quantity)}${unit} — ${ils(it.line_total)}`;
    })
    .join("\n");
}

function ItemsList({ row }) {
  const items = requestItems(row);
  if (!items.length) return "—";
  return (
    <ul style={{ margin: "0.2rem 0 0", padding: 0, listStyle: "none", lineHeight: 1.5 }}>
      {items.map((it, i) => (
        <li key={`${it.name}-${i}`}>
          {it.name} × {formatQty(it.quantity)}
          {it.unit_name ? ` ${it.unit_name}` : ""} — {ils(it.line_total)}
        </li>
      ))}
    </ul>
  );
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
  const [handoverChoice, setHandoverChoice] = useState("");
  const [reviewLoading, setReviewLoading] = useState(false);
  const [staleMessage, setStaleMessage] = useState(null);
  const [overrideCredit, setOverrideCredit] = useState(false);
  const pollBusy = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (pollBusy.current) return;
    pollBusy.current = true;
    if (!silent) setLoading(true);
    try {
      const salePath =
        tab === "pending"
          ? "/api/on-account-requests/pending"
          : `/api/on-account-requests/history?status=${tab === "all" ? "all" : tab}`;
      const cashPath =
        tab === "pending"
          ? "/api/customer-cash-debt-requests/pending"
          : `/api/customer-cash-debt-requests/history?status=${tab === "all" ? "all" : tab}`;
      const [salesRes, cashRes] = await Promise.all([
        api.get(salePath, { headers: getAuthHeaders() }),
        api.get(cashPath, { headers: getAuthHeaders() }),
      ]);
      const sales = salesRes.data?.data ?? salesRes.data;
      const cash = cashRes.data?.data ?? cashRes.data;
      const tagged = [
        ...(Array.isArray(sales) ? sales : []).map((row) => ({ ...row, request_kind: "sale" })),
        ...(Array.isArray(cash) ? cash : []).map((row) => ({
          ...row,
          request_kind: "cash_debt",
          on_account_amount: row.on_account_amount ?? row.amount,
        })),
      ];
      tagged.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
      setRows(tagged);
    } catch (e) {
      if (!silent) toast.error(apiErrorMessage(e, "تعذّر التحميل"));
      if (!silent) setRows([]);
    } finally {
      pollBusy.current = false;
      if (!silent) setLoading(false);
    }
  }, [tab, toast]);

  useEffect(() => {
    load();
  }, [load]);

  // Polls only while the tab is visible, backing off rather than stopping when
  // hidden so a manager watching in a background tab still sees new requests.
  useVisiblePoll(() => load(true), 7000, {
    enabled: tab === "pending",
    hiddenIntervalMs: 20_000,
  });

  async function openReview(row, action) {
    setStaleMessage(null);
    try {
      const base =
        row.request_kind === "cash_debt"
          ? "/api/customer-cash-debt-requests"
          : "/api/on-account-requests";
      const { data } = await api.get(`${base}/${row.id}`, {
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
      setHandoverChoice("");
      setOverrideCredit(false);
    } catch (e) {
      toast.error(apiErrorMessage(e, "تعذّر فتح الطلب"));
    }
  }

  function closeReview() {
    setReviewTarget(null);
    setReviewNotes("");
    setHandoverChoice("");
    setOverrideCredit(false);
    setStaleMessage(null);
  }

  async function submitReview(e) {
    e.preventDefault();
    if (!reviewTarget || reviewTarget.readOnly) return;
    const needsHandover =
      reviewTarget.action === "rejected" && reviewTarget.shift_status === "pending_count";
    if (needsHandover && handoverChoice !== "returned" && handoverChoice !== "outstanding") {
      toast.error("حدد هل أُعيد النقد أو البضاعة");
      return;
    }
    setReviewLoading(true);
    try {
      const base =
        reviewTarget.request_kind === "cash_debt"
          ? "/api/customer-cash-debt-requests"
          : "/api/on-account-requests";
      await api.put(
        `${base}/${reviewTarget.id}`,
        {
          status: reviewTarget.action,
          review_notes: reviewNotes.trim() || null,
          override_credit_limit:
            reviewTarget.action === "approved" && overrideCredit ? true : undefined,
          ...(needsHandover ? { handover_disposition: handoverChoice } : {}),
        },
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
      key: "kind",
      header: "النوع",
      value: (r) => (r.request_kind === "cash_debt" ? "ذمة نقدية" : "بيع على الذمة"),
      render: (r) => (r.request_kind === "cash_debt" ? "ذمة نقدية" : "بيع على الذمة"),
    },
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
      key: "employee",
      header: "الموظف",
      value: (r) => r.employee_name || "—",
      render: (r) => r.employee_name || "—",
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
    {
      key: "items",
      header: "الأصناف",
      wrap: true,
      value: (r) => itemsText(r),
      render: (r) => <ItemsList row={r} />,
    },
    {
      key: "notes",
      header: "ملاحظات",
      value: (r) => r.notes || "—",
      render: (r) => (
        <span style={{ whiteSpace: "pre-wrap", display: "inline-block", maxWidth: "16rem" }}>
          {r.notes || "—"}
        </span>
      ),
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
        subtitle="مبيعات على الذمة وطلبات الذمة النقدية — تتحدّث تلقائياً كل 7 ثوانٍ"
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
              ? `${reviewTarget.request_kind === "cash_debt" ? "ذمة نقدية" : "طلب ذمة"} #${reviewTarget.id} — للقراءة فقط`
              : reviewTarget.action === "approved"
                ? `موافقة على ${reviewTarget.request_kind === "cash_debt" ? "ذمة نقدية" : "ذمة"} #${reviewTarget.id}`
                : `رفض ${reviewTarget.request_kind === "cash_debt" ? "ذمة نقدية" : "ذمة"} #${reviewTarget.id}`
            : ""
        }
        footer={
          reviewTarget?.readOnly ? (
            <SecondaryButton type="button" onClick={closeReview}>
              إغلاق
            </SecondaryButton>
          ) : (
            <>
              <PrimaryButton
                type="submit"
                form="on-account-review-form"
                disabled={
                  reviewLoading ||
                  (reviewTarget?.action === "approved" &&
                    reviewTarget?.credit?.exceeds_limit &&
                    !overrideCredit)
                }
              >
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
              <Notice tone="warn">{staleMessage}</Notice>
            ) : null}
            <form id="on-account-review-form" onSubmit={submitReview}>
              <p className="ui-hint">
                {reviewTarget.cashier_username} — {reviewTarget.employee_name || reviewTarget.customer_name || "ذمة"} — ذمة{" "}
                {ils(reviewTarget.on_account_amount ?? 0)} — إجمالي{" "}
                {ils(reviewTarget.total_amount ?? 0)}
                {reviewTarget.rounding_adjustment != null &&
                reviewTarget.rounding_adjustment !== "" &&
                Number(reviewTarget.rounding_adjustment) !== 0
                  ? ` — تقريب ${ils(reviewTarget.rounding_adjustment)}`
                  : ""}
                {reviewTarget.readOnly ? ` — ${statusLabel(reviewTarget.status)}` : null}
              </p>
              {reviewTarget.credit ? (
                <p className="ui-mt-md">
                  الرصيد الحالي {ils(reviewTarget.credit.current_balance)} — المطلوب{" "}
                  {ils(reviewTarget.credit.requested_amount)} — الحد{" "}
                  {ils(reviewTarget.credit.credit_limit)} — بعد الموافقة{" "}
                  {ils(reviewTarget.credit.projected_balance)}
                </p>
              ) : null}
              {reviewTarget.action === "approved" && reviewTarget.credit?.exceeds_limit && !reviewTarget.readOnly ? (
                <FormField label="استثناء فوق حد الائتمان">
                  <label>
                    <input
                      type="checkbox"
                      checked={overrideCredit}
                      onChange={(e) => setOverrideCredit(e.target.checked)}
                    />{" "}
                    أوافق على هذه العملية فوق الحد. حد العميل لا يتغير.
                  </label>
                </FormField>
              ) : null}
              <div className="ui-mt-md">
                <strong>الأصناف:</strong>
                <ItemsList row={reviewTarget} />
              </div>
              {reviewTarget.notes ? (
                <p className="ui-mt-md">
                  <strong>ملاحظات العملية:</strong> {reviewTarget.notes}
                </p>
              ) : null}
              {!reviewTarget.readOnly &&
              reviewTarget.action === "rejected" &&
              reviewTarget.shift_status === "pending_count" ? (
                <HandoverRejectField value={handoverChoice} onChange={setHandoverChoice} />
              ) : null}
              {!reviewTarget.readOnly ? (
                <FormField label="ملاحظات المراجعة" optional>
                  <Input value={reviewNotes} onChange={(e) => setReviewNotes(e.target.value)} />
                </FormField>
              ) : reviewTarget.review_notes ? (
                <p className="ui-mt-md">
                  <strong>ملاحظات المراجعة:</strong> {reviewTarget.review_notes}
                </p>
              ) : null}
            </form>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
