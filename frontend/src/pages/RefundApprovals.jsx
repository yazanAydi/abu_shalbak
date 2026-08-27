import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
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
  useToast,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";

function formatDt(v) {
  return dateTime(v);
}

function statusLabel(status) {
  if (status === "approved") return "Ù…ÙˆØ§ÙÙŽÙ‚";
  if (status === "rejected") return "Ù…Ø±ÙÙˆØ¶";
  if (status === "pending") return "Ù‚ÙŠØ¯ Ø§Ù„Ù…Ø±Ø§Ø¬Ø¹Ø©";
  return status || "â€”";
}

export default function RefundApprovals() {
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
          ? "/api/refund-requests/pending"
          : `/api/refund-requests/history?status=${tab === "all" ? "all" : tab}`;
      const { data } = await api.get(path, { headers: getAuthHeaders() });
      const payload = data?.data ?? data;
      setRows(Array.isArray(payload) ? payload : []);
    } catch (e) {
      if (!silent) toast.error(e.response?.data?.error || e.message || "ØªØ¹Ø°Ù‘Ø± Ø§Ù„ØªØ­Ù…ÙŠÙ„");
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
      const { data } = await api.get(`/api/refund-requests/${row.id}`, {
        headers: getAuthHeaders(),
      });
      const fresh = data?.data ?? data;
      if (fresh.status !== "pending") {
        setReviewTarget({ ...row, ...fresh, readOnly: true });
        setStaleMessage("Ù‡Ø°Ø§ Ø§Ù„Ø·Ù„Ø¨ Ù„Ù… ÙŠØ¹Ø¯ Ù‚ÙŠØ¯ Ø§Ù„Ù…Ø±Ø§Ø¬Ø¹Ø© â€” Ø§Ù„Ø¹Ø±Ø¶ Ù„Ù„Ù‚Ø±Ø§Ø¡Ø© ÙÙ‚Ø·.");
        setReviewNotes(fresh.review_notes || "");
        return;
      }
      setReviewTarget({ ...row, ...fresh, action, readOnly: false });
      setReviewNotes("");
    } catch (e) {
      toast.error(e.response?.data?.error || "ØªØ¹Ø°Ù‘Ø± ÙØªØ­ Ø§Ù„Ø·Ù„Ø¨");
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
        `/api/refund-requests/${reviewTarget.id}`,
        { status: reviewTarget.action, review_notes: reviewNotes.trim() || null },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      toast.success(reviewTarget.action === "approved" ? "ØªÙ…Øª Ø§Ù„Ù…ÙˆØ§ÙÙ‚Ø©" : "ØªÙ… Ø§Ù„Ø±ÙØ¶");
      closeReview();
      load();
    } catch (e2) {
      const code = e2.response?.data?.code;
      if (code === "NOT_PENDING") {
        setStaleMessage("ØªÙ…Øª Ù…Ø¹Ø§Ù„Ø¬Ø© Ù‡Ø°Ø§ Ø§Ù„Ø·Ù„Ø¨ Ù…Ù† Ù‚Ù†Ø§Ø© Ø£Ø®Ø±Ù‰ â€” Ø§Ù„Ø¹Ø±Ø¶ Ù„Ù„Ù‚Ø±Ø§Ø¡Ø© ÙÙ‚Ø·.");
        setReviewTarget((prev) => (prev ? { ...prev, readOnly: true } : prev));
        load(true);
      } else {
        toast.error(e2.response?.data?.error || e2.message || "ÙØ´Ù„");
      }
    } finally {
      setReviewLoading(false);
    }
  }

  const baseColumns = [
    { key: "id", header: "#", value: (r) => r.id, render: (r) => r.id },
    {
      key: "cashier",
      header: "Ø§Ù„ÙƒØ§Ø´ÙŠØ±",
      value: (r) => r.cashier_username || r.cashier_id,
      render: (r) => r.cashier_username || r.cashier_id,
    },
    {
      key: "tx",
      header: "Ø§Ù„ÙØ§ØªÙˆØ±Ø©",
      value: (r) => `#${r.transaction_id}`,
      render: (r) => `#${r.transaction_id}`,
    },
    {
      key: "amount",
      header: "Ø§Ù„Ù…Ø¨Ù„Øº",
      className: "num",
      value: (r) => ils(r.total_amount ?? 0),
      render: (r) => ils(r.total_amount ?? 0),
    },
    {
      key: "pm",
      header: "Ø§Ù„Ø±Ø¯",
      value: (r) => (r.payment_method === "cash" ? "Ù†Ù‚Ø¯" : "Ø¨Ø·Ø§Ù‚Ø©"),
      render: (r) => (r.payment_method === "cash" ? "Ù†Ù‚Ø¯" : "Ø¨Ø·Ø§Ù‚Ø©"),
    },
    {
      key: "created",
      header: "Ø§Ù„ØªØ§Ø±ÙŠØ®",
      value: (r) => formatDt(r.created_at),
      render: (r) => formatDt(r.created_at),
    },
    {
      key: "reason",
      header: "Ø§Ù„Ø³Ø¨Ø¨",
      value: (r) => r.reason || "â€”",
      render: (r) => r.reason || "â€”",
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
                  Ù…ÙˆØ§ÙÙ‚Ø©
                </PrimaryButton>
                <SecondaryButton size="sm" type="button" onClick={() => openReview(r, "rejected")}>
                  Ø±ÙØ¶
                </SecondaryButton>
              </>
            ),
          },
        ]
      : [
          ...baseColumns,
          {
            key: "status",
            header: "Ø§Ù„Ø­Ø§Ù„Ø©",
            value: (r) => statusLabel(r.status),
            render: (r) => statusLabel(r.status),
          },
          {
            key: "source",
            header: "Ø§Ù„Ù…ØµØ¯Ø±",
            value: (r) =>
              r.decision_source === "telegram"
                ? "ØªÙŠÙ„ÙŠØ¬Ø±Ø§Ù…"
                : r.decision_source === "admin"
                  ? "Ù„ÙˆØ­Ø© Ø§Ù„Ø¥Ø¯Ø§Ø±Ø©"
                  : "â€”",
            render: (r) =>
              r.decision_source === "telegram"
                ? "ØªÙŠÙ„ÙŠØ¬Ø±Ø§Ù…"
                : r.decision_source === "admin"
                  ? "Ù„ÙˆØ­Ø© Ø§Ù„Ø¥Ø¯Ø§Ø±Ø©"
                  : "â€”",
          },
          {
            key: "manager",
            header: "Ø§Ù„Ù…Ø¹ØªÙ…Ø¯",
            value: (r) => r.manager_username || "â€”",
            render: (r) => r.manager_username || "â€”",
          },
        ];

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title="Ù…ÙˆØ§ÙÙ‚Ø§Øª Ø§Ù„Ø§Ø³ØªØ±Ø¬Ø§Ø¹"
        subtitle="Ø·Ù„Ø¨Ø§Øª Ø¨Ø§Ù†ØªØ¸Ø§Ø± Ø§Ù„Ù…ÙˆØ§ÙÙ‚Ø© ÙˆØ³Ø¬Ù„ Ø§Ù„Ù‚Ø±Ø§Ø±Ø§Øª â€” ØªØªØ­Ø¯Ù‘Ø« ØªÙ„Ù‚Ø§Ø¦ÙŠØ§Ù‹ ÙƒÙ„ 7 Ø«ÙˆØ§Ù†Ù"
        icon="refunds"
        actions={
          <ReportToolbar
            title="Ù…ÙˆØ§ÙÙ‚Ø§Øª Ø§Ù„Ø§Ø³ØªØ±Ø¬Ø§Ø¹"
            columns={pickExportColumns(columns)}
            rows={rows}
            filename={`refund-approvals-${tab}`}
            disabled={loading}
          />
        }
      />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "pending", label: "Ù‚ÙŠØ¯ Ø§Ù„Ù…Ø±Ø§Ø¬Ø¹Ø©", icon: "refunds" },
          { id: "approved", label: "Ù…ÙˆØ§ÙÙŽÙ‚", icon: "check" },
          { id: "rejected", label: "Ù…Ø±ÙÙˆØ¶", icon: "close" },
          { id: "all", label: "Ø§Ù„ÙƒÙ„", icon: "list" },
        ]}
      />

      {tab === "pending" && rows.length > 0 ? (
        <p className="rf-muted" style={{ marginBottom: "1rem" }}>
          {rows.length} Ø·Ù„Ø¨/Ø·Ù„Ø¨Ø§Øª Ø¨Ø§Ù†ØªØ¸Ø§Ø± Ø§Ù„Ù…ÙˆØ§ÙÙ‚Ø©.{" "}
          <Link to="/refunds">Ø¹Ø±Ø¶ Ø³Ø¬Ù„ Ø§Ù„Ø§Ø³ØªØ±Ø¬Ø§Ø¹Ø§Øª Ø§Ù„Ù…ÙƒØªÙ…Ù„Ø©</Link>
        </p>
      ) : null}

      <Card>
        <CardBody flush>
          <DataTable
            columns={columns}
            rows={rows}
            loading={loading}
            empty={
              tab === "pending"
                ? "Ù„Ø§ ØªÙˆØ¬Ø¯ Ø·Ù„Ø¨Ø§Øª Ø¨Ø§Ù†ØªØ¸Ø§Ø± Ø§Ù„Ù…ÙˆØ§ÙÙ‚Ø©"
                : "Ù„Ø§ ØªÙˆØ¬Ø¯ Ø·Ù„Ø¨Ø§Øª ÙÙŠ Ù‡Ø°Ø§ Ø§Ù„Ø³Ø¬Ù„"
            }
            emptyIcon="refunds"
          />
        </CardBody>
      </Card>

      <Modal
        open={!!reviewTarget}
        onClose={closeReview}
        title={
          reviewTarget
            ? reviewTarget.readOnly
              ? `Ø·Ù„Ø¨ #${reviewTarget.id} â€” Ù„Ù„Ù‚Ø±Ø§Ø¡Ø© ÙÙ‚Ø·`
              : reviewTarget.action === "approved"
                ? `Ù…ÙˆØ§ÙÙ‚Ø© Ø¹Ù„Ù‰ Ø·Ù„Ø¨ #${reviewTarget.id}`
                : `Ø±ÙØ¶ Ø·Ù„Ø¨ #${reviewTarget.id}`
            : ""
        }
        footer={
          reviewTarget?.readOnly ? (
            <SecondaryButton type="button" onClick={closeReview}>
              Ø¥ØºÙ„Ø§Ù‚
            </SecondaryButton>
          ) : (
            <>
              <PrimaryButton type="submit" form="refund-review-form" disabled={reviewLoading}>
                {reviewLoading ? "Ø¬Ø§Ø±ÙŠ Ø§Ù„Ø­ÙØ¸â€¦" : "ØªØ£ÙƒÙŠØ¯"}
              </PrimaryButton>
              <SecondaryButton type="button" onClick={closeReview}>
                Ø¥Ù„ØºØ§Ø¡
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
            <form id="refund-review-form" onSubmit={submitReview}>
              <p style={{ color: "var(--office-text-muted)", lineHeight: 1.6 }}>
                {reviewTarget.cashier_username} â€” ÙØ§ØªÙˆØ±Ø© #{reviewTarget.transaction_id} â€”{" "}
                {ils(reviewTarget.total_amount ?? 0)}
                {reviewTarget.readOnly ? ` â€” ${statusLabel(reviewTarget.status)}` : null}
              </p>
              {!reviewTarget.readOnly ? (
                <FormField label="Ù…Ù„Ø§Ø­Ø¸Ø§Øª (Ø§Ø®ØªÙŠØ§Ø±ÙŠ)">
                  <Input value={reviewNotes} onChange={(e) => setReviewNotes(e.target.value)} />
                </FormField>
              ) : reviewTarget.review_notes ? (
                <p style={{ marginTop: "0.75rem" }}>
                  <strong>Ù…Ù„Ø§Ø­Ø¸Ø§Øª:</strong> {reviewTarget.review_notes}
                </p>
              ) : null}
            </form>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
