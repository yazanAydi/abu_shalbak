import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import {
  PageHeader,
  DataTable,
  Button,
  StatusPill,
  useToast,
} from "../components/ui";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

const formatDt = (v) => (v ? String(v).replace("T", " ").slice(0, 16) : "—");

function statusLabel(status) {
  if (status === "approved") return "موافَق";
  if (status === "rejected") return "مرفوض";
  if (status === "pending") return "قيد المراجعة";
  return status || "—";
}

const STATUS_TONE = { approved: "green", rejected: "red", pending: "orange" };

export default function MyRefundRequests() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/api/refund-requests/mine", {
        headers: getAuthHeaders(),
      });
      const payload = data?.data ?? data;
      setRows(Array.isArray(payload) ? payload : []);
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "تعذّر التحميل");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 7000);
    return () => clearInterval(timer);
  }, [load]);

  async function acknowledge(id) {
    try {
      await api.post(`/api/refund-requests/${id}/acknowledge`, {}, { headers: getAuthHeaders() });
      await load();
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "فشل");
    }
  }

  const columns = [
    { key: "id", header: "#", className: "num" },
    { key: "transaction_id", header: "الفاتورة", render: (r) => `#${r.transaction_id}` },
    { key: "total_amount", header: "المبلغ", className: "num", render: (r) => ils(r.total_amount ?? 0) },
    {
      key: "status",
      header: "الحالة",
      render: (r) => (
        <StatusPill tone={STATUS_TONE[r.status] || "neutral"}>{statusLabel(r.status)}</StatusPill>
      ),
    },
    {
      key: "created_at",
      header: "التاريخ",
      render: (r) => formatDt(r.approved_at || r.rejected_at || r.created_at),
    },
    {
      key: "actions",
      header: "",
      render: (r) => {
        const unread =
          (r.status === "approved" || r.status === "rejected") && !r.cashier_acknowledged_at;
        return unread ? (
          <Button variant="ghost" size="sm" onClick={() => acknowledge(r.id)}>
            تمّت المطالعة
          </Button>
        ) : null;
      },
    },
  ];

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title="طلباتي للاسترجاع"
        subtitle="متابعة طلبات الاسترجاع المرسلة للمدير"
        icon="refunds"
        actions={
          <Link to="/checkout" className="nav-pill">
            العودة للكاشير
          </Link>
        }
      />

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        empty="لا توجد طلبات استرجاع"
        emptyIcon="refunds"
        rowClassName={(r) =>
          (r.status === "approved" || r.status === "rejected") && !r.cashier_acknowledged_at
            ? "expiring-soon"
            : ""
        }
      />

      {!loading && rows.length === 0 ? null : (
        <p className="ui-field__hint ui-mt-sm">
          يتم تحديث القائمة تلقائياً كل 7 ثوانٍ
        </p>
      )}
    </div>
  );
}
