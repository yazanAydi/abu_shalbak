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
  PrimaryButton,
  SecondaryButton,
  ReportToolbar,
  Tabs,
  Notice,
  useToast,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";
import { apiErrorMessage } from "../utils/apiError";
import { printReceipt } from "../utils/printReceipt";

function formatDt(value) {
  return value ? dateTime(value) : "—";
}

function statusLabel(status) {
  if (status === "approved") return "موافَق";
  if (status === "rejected") return "مرفوض";
  if (status === "pending") return "قيد المراجعة";
  return status || "—";
}

function sourceLabel(source) {
  if (source === "telegram") return "تيليجرام";
  if (source === "admin") return "لوحة الإدارة";
  return "—";
}

function ItemsList({ row }) {
  const items = Array.isArray(row?.items) ? row.items : [];
  if (!items.length) return "—";
  return (
    <ul style={{ margin: "0.2rem 0 0", padding: 0, listStyle: "none", lineHeight: 1.55 }}>
      {items.map((item, index) => (
        <li key={`${item.name}-${index}`}>
          {item.name} × {item.quantity}
          {item.unit_name ? ` ${item.unit_name}` : ""}
          {item.line_cost != null ? ` — ${ils(item.line_cost)}` : ""}
        </li>
      ))}
    </ul>
  );
}

function GroupApprovalQueue({
  title,
  subtitle,
  apiBase,
  filename,
  partyHeader,
  partyValue,
  showOrigin = false,
}) {
  const toast = useToast();
  const [tab, setTab] = useState("pending");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [staleMessage, setStaleMessage] = useState(null);
  const pollBusy = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (pollBusy.current) return;
    pollBusy.current = true;
    if (!silent) setLoading(true);
    try {
      const { data } = await api.get(apiBase, {
        headers: getAuthHeaders(),
        params: { status: tab },
      });
      const payload = data?.data ?? data;
      setRows(Array.isArray(payload) ? payload : []);
    } catch (e) {
      if (!silent) toast.error(apiErrorMessage(e, "تعذّر التحميل"));
      if (!silent) setRows([]);
    } finally {
      pollBusy.current = false;
      if (!silent) setLoading(false);
    }
  }, [apiBase, tab, toast]);

  useEffect(() => {
    load();
  }, [load]);

  useVisiblePoll(() => load(true), 7000, {
    enabled: tab === "pending",
    hiddenIntervalMs: 20_000,
  });

  async function openDetail(row) {
    setStaleMessage(null);
    setDetailLoading(true);
    setDetail(row);
    try {
      const { data } = await api.get(`${apiBase}/${row.id}`, { headers: getAuthHeaders() });
      setDetail(data?.data ?? data);
    } catch (e) {
      toast.error(apiErrorMessage(e, "تعذّر فتح الطلب"));
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    setDetail(null);
    setStaleMessage(null);
  }

  async function decide(action) {
    if (!detail || detail.status !== "pending") return;
    setActionLoading(true);
    setStaleMessage(null);
    try {
      await api.post(`${apiBase}/${detail.id}/${action}`, {}, {
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      });
      toast.success(action === "approve" ? "تمت الموافقة" : "تم الرفض");
      closeDetail();
      load();
    } catch (e) {
      const code = e.response?.data?.code;
      if (code === "ALREADY_HANDLED" || e.response?.status === 409) {
        setStaleMessage("تمت معالجة هذا الطلب من قناة أخرى — لن تُرحَّل العملية مرة ثانية.");
        load(true);
        try {
          const { data } = await api.get(`${apiBase}/${detail.id}`, { headers: getAuthHeaders() });
          setDetail(data?.data ?? data);
        } catch {
          /* the list refresh still shows the new state */
        }
      } else {
        toast.error(apiErrorMessage(e, "فشل"));
      }
    } finally {
      setActionLoading(false);
    }
  }

  async function reprint() {
    if (!detail?.can_reprint) return;
    setPrinting(true);
    try {
      const { data } = await api.post(`${apiBase}/${detail.id}/reprint`, {}, {
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      });
      const payload = data?.data ?? data;
      if (payload?.receipt_html) printReceipt(payload);
      else toast.error("لم يُرجَع إيصال");
    } catch (e) {
      toast.error(apiErrorMessage(e, "فشلت إعادة الطباعة"));
    } finally {
      setPrinting(false);
    }
  }

  const columns = [
    { key: "id", header: "#", value: (row) => row.id, render: (row) => row.id },
    {
      key: "created",
      header: "التاريخ",
      value: (row) => formatDt(row.created_at),
      render: (row) => formatDt(row.created_at),
    },
    {
      key: "cashier",
      header: "الكاشير",
      value: (row) => row.cashier_username || row.cashier_id,
      render: (row) => row.cashier_username || row.cashier_id,
    },
    {
      key: "shift",
      header: "الوردية",
      value: (row) => (row.shift_id ? `#${row.shift_id}` : "—"),
      render: (row) => (row.shift_id ? `#${row.shift_id}` : "—"),
    },
    ...(showOrigin
      ? [{
          key: "origin",
          header: "المصدر",
          value: (row) => row.origin_label || "—",
          render: (row) => row.origin_label || "—",
        }]
      : []),
    {
      key: "party",
      header: partyHeader,
      wrap: !showOrigin,
      value: (row) => partyValue(row),
      render: (row) => (showOrigin ? partyValue(row) : <ItemsList row={row} />),
    },
    {
      key: "amount",
      header: "المبلغ",
      className: "num",
      value: (row) => (row.amount == null ? "—" : ils(row.amount)),
      render: (row) => (row.amount == null ? "—" : ils(row.amount)),
    },
    {
      key: "notes",
      header: "ملاحظة",
      value: (row) => row.notes || row.reason || "—",
      render: (row) => row.notes || row.reason || "—",
    },
    ...(tab === "pending"
      ? []
      : [
          {
            key: "status",
            header: "الحالة",
            value: (row) => statusLabel(row.status),
            render: (row) => statusLabel(row.status),
          },
          {
            key: "decision",
            header: "القرار",
            value: (row) =>
              [sourceLabel(row.decision_source), row.decision_actor, formatDt(row.decision_at)]
                .filter((part) => part && part !== "—")
                .join(" · ") || "—",
            render: (row) => (
              <>
                {sourceLabel(row.decision_source)}
                {row.decision_actor ? ` · ${row.decision_actor}` : ""}
                <div>{formatDt(row.decision_at)}</div>
              </>
            ),
          },
        ]),
    {
      key: "actions",
      header: "",
      render: (row) => (
        <SecondaryButton size="sm" type="button" onClick={() => openDetail(row)}>
          التفاصيل
        </SecondaryButton>
      ),
    },
  ];

  const pending = detail?.status === "pending";

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title={title}
        subtitle={subtitle}
        icon="vouchers"
        actions={
          <ReportToolbar
            title={title}
            columns={pickExportColumns(columns)}
            rows={rows}
            filename={`${filename}-${tab}`}
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
        ]}
      />

      <Card>
        <CardBody flush>
          <DataTable
            columns={columns}
            rows={rows}
            loading={loading}
            empty={tab === "pending" ? "لا توجد طلبات بانتظار الموافقة" : "لا توجد طلبات في هذا السجل"}
            emptyIcon="vouchers"
          />
        </CardBody>
      </Card>

      <Modal
        open={!!detail}
        onClose={closeDetail}
        title={detail ? `${title} #${detail.id}` : ""}
        footer={
          <>
            {pending ? (
              <>
                <PrimaryButton type="button" disabled={actionLoading || detailLoading} onClick={() => decide("approve")}>
                  {actionLoading ? "جاري الحفظ…" : "موافقة"}
                </PrimaryButton>
                <SecondaryButton type="button" disabled={actionLoading || detailLoading} onClick={() => decide("reject")}>
                  رفض
                </SecondaryButton>
              </>
            ) : null}
            {detail?.can_reprint ? (
              <SecondaryButton type="button" disabled={printing} onClick={reprint}>
                {printing ? "…" : "إعادة طباعة"}
              </SecondaryButton>
            ) : null}
            <SecondaryButton type="button" onClick={closeDetail}>
              إغلاق
            </SecondaryButton>
          </>
        }
      >
        {detail ? (
          <div className="ui-hint">
            {staleMessage ? <Notice tone="warn">{staleMessage}</Notice> : null}
            {detailLoading ? <p>جاري تحميل التفاصيل…</p> : null}
            <p>الطلب #{detail.id} — {statusLabel(detail.status)}</p>
            <p>التاريخ: {formatDt(detail.created_at)}</p>
            <p>الكاشير: {detail.cashier_username || detail.cashier_id || "—"}</p>
            <p>الوردية: {detail.shift_id ? `#${detail.shift_id}` : "—"}</p>
            {showOrigin ? <p>المصدر: {detail.origin_label || "—"}</p> : null}
            {detail.already_paid ? <p>هذه دفعة مُبلّغ أنها دُفعت مسبقاً، وليست تعليمات بدفع جديد.</p> : null}
            {detail.recorded_by_username ? <p>سجّلها: {detail.recorded_by_username}</p> : null}
            <p>
              {partyHeader}: {showOrigin ? partyValue(detail) : null}
            </p>
            {!showOrigin ? <ItemsList row={detail} /> : null}
            <p>المبلغ: {detail.amount == null ? "—" : ils(detail.amount)}</p>
            <p>ملاحظة: {detail.notes || detail.reason || "—"}</p>
            {detail.status !== "pending" ? (
              <>
                <p>مصدر القرار: {sourceLabel(detail.decision_source)}</p>
                <p>صاحب القرار: {detail.decision_actor || "—"}</p>
                <p>وقت القرار: {formatDt(detail.decision_at)}</p>
              </>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

export default GroupApprovalQueue;
