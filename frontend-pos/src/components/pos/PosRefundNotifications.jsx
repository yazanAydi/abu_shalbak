import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import api from "../../apiClient";
import { getAuthHeaders } from "../../utils/auth";
import { useVisiblePoll } from "../../hooks/useVisiblePoll";
import { useAuthEventSource } from "../../hooks/useAuthEventSource";
import { playApprovalDecision } from "../../utils/posSounds";
import "../ShiftModal.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

const ACK_PATH = {
  refund: "/api/refund-requests",
  advance: "/api/advance-requests",
  on_account: "/api/on-account-requests",
  cash_debt: "/api/customer-cash-debt-requests",
  supplier: "/api/supplier-payment-requests",
  shop: "/api/shop-consumption-requests",
};

/** Oldest terminal decision first so the cashier clears the queue in order. */
function sortUnreadFifo(items) {
  return [...items].sort((a, b) => {
    const ta = a.approved_at || a.rejected_at || a.created_at || "";
    const tb = b.approved_at || b.rejected_at || b.created_at || "";
    return String(ta).localeCompare(String(tb));
  });
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.data)) return value.data;
  return [];
}

function tagKind(kind, rows) {
  return asList(rows).map((row) => ({ ...row, kind }));
}

function mergeSnapshot(snapshot) {
  const src = snapshot && !Array.isArray(snapshot) ? snapshot : {};
  return sortUnreadFifo([
    ...tagKind("refund", src.refunds),
    ...tagKind("advance", src.advances),
    ...tagKind("on_account", src.on_account),
    ...tagKind("cash_debt", src.cash_debts),
    ...tagKind("supplier", src.supplier_payments),
    ...tagKind("shop", src.shop_consumption),
  ]);
}

function settledList(result) {
  if (result.status !== "fulfilled") return [];
  return asList(result.value.data?.data ?? result.value.data);
}

function applySuppress(list, suppressIds) {
  if (!suppressIds) return list;
  return list.filter((item) => {
    const skip = suppressIds[item.kind];
    return skip == null || Number(skip) !== Number(item.id);
  });
}

function titleFor(item) {
  const approved = item.status === "approved";
  if (item.kind === "advance") {
    return approved ? "تمت الموافقة على السلف" : "تم رفض طلب السلف";
  }
  if (item.kind === "on_account") {
    return approved ? "تمت الموافقة — اكتمل البيع" : "تم رفض البيع على الذمة";
  }
  if (item.kind === "cash_debt") {
    return approved ? "تمت الموافقة على الذمة النقدية" : "تم رفض طلب الذمة النقدية";
  }
  if (item.kind === "supplier") {
    return approved ? "تمت الموافقة — سُجّلت الدفعة" : "تم رفض طلب الدفع للمورد";
  }
  if (item.kind === "shop") {
    return approved ? "تمت الموافقة — خُصم المخزون بالتكلفة" : "تم رفض مصاريف المحل";
  }
  return approved ? "تمت الموافقة على الاسترجاع" : "تم رفض طلب الاسترجاع";
}

function headingFor(item) {
  if (item.kind === "advance") return `طلب سلف #${item.id}`;
  if (item.kind === "on_account") return `طلب ذمة #${item.id}`;
  if (item.kind === "cash_debt") return `طلب ذمة نقدية #${item.id}`;
  if (item.kind === "supplier") return `طلب دفع لمورد #${item.id}`;
  if (item.kind === "shop") return `مصاريف محل #${item.id}`;
  return `طلب استرجاع #${item.id}`;
}

function detailFor(item) {
  if (item.kind === "advance") {
    const name = item.employee_name ? `${item.employee_name} — ` : "";
    return `${name}${ils(item.amount ?? 0)}`;
  }
  if (item.kind === "cash_debt") {
    const name = item.customer_name ? `${item.customer_name} — ` : "";
    return `${name}${ils(item.amount ?? item.on_account_amount ?? 0)}`;
  }
  if (item.kind === "on_account") {
    const name = item.customer_name ? `${item.customer_name} — ` : "";
    return `${name}ذمة ${ils(item.on_account_amount ?? item.total_amount ?? 0)}`;
  }
  if (item.kind === "supplier") {
    const name = item.supplier_name ? `${item.supplier_name} — ` : "";
    return `${name}${ils(item.amount ?? 0)}`;
  }
  if (item.kind === "shop") return item.reason || "مصاريف محل";
  return `فاتورة #${item.transaction_id} — ${ils(item.total_amount ?? 0)}`;
}

/**
 * Polls unread refund / سلف / ذمة decisions and shows ONE modal at a time (FIFO).
 * Cashier taps "تمّ" to acknowledge; the next unread item appears automatically.
 */
export default function PosRefundNotifications({
  suppressIds,
  onApprovedOnAccount,
}) {
  const [unread, setUnread] = useState([]);
  const [ackLoading, setAckLoading] = useState(false);
  const [err, setErr] = useState("");
  const onApprovedRef = useRef(onApprovedOnAccount);
  onApprovedRef.current = onApprovedOnAccount;
  const finalizedOnAccountRef = useRef(new Set());

  const poll = useCallback(async () => {
    try {
      const results = await Promise.allSettled([
        api.get("/api/refund-requests/mine/unread", { headers: getAuthHeaders() }),
        api.get("/api/advance-requests/mine/unread", { headers: getAuthHeaders() }),
        api.get("/api/on-account-requests/mine/unread", { headers: getAuthHeaders() }),
        api.get("/api/customer-cash-debt-requests/mine/unread", { headers: getAuthHeaders() }),
        api.get("/api/supplier-payment-requests/mine/unread", { headers: getAuthHeaders() }),
        api.get("/api/shop-consumption-requests/mine/unread", { headers: getAuthHeaders() }),
      ]);
      setUnread(
        mergeSnapshot({
          refunds: settledList(results[0]),
          advances: settledList(results[1]),
          on_account: settledList(results[2]),
          cash_debts: settledList(results[3]),
          supplier_payments: settledList(results[4]),
          shop_consumption: settledList(results[5]),
        })
      );
    } catch {
      /* offline-safe: keep current queue */
    }
  }, []);

  useEffect(() => {
    poll();
  }, [poll]);

  const [sseLive, setSseLive] = useState(false);
  useAuthEventSource("/api/v1/pos/events", (event, data) => {
    setSseLive(true);
    if (event === "decisions") {
      setUnread(mergeSnapshot(data));
      return;
    }
    if (event === "refunds" && Array.isArray(data)) {
      setUnread((prev) =>
        sortUnreadFifo([
          ...prev.filter((x) => x.kind !== "refund"),
          ...tagKind("refund", data),
        ])
      );
    }
  });
  useVisiblePoll(poll, 8000, { enabled: !sseLive, hiddenIntervalMs: 8000 });

  const visible = applySuppress(unread, suppressIds);
  const current = visible[0] ?? null;
  const approvedOnAccountId =
    current?.kind === "on_account" && current.status === "approved" ? current.id : null;

  useEffect(() => {
    if (!current?.id || !current.kind) return;
    playApprovalDecision(current.kind, current.id);
  }, [current?.kind, current?.id]);

  useEffect(() => {
    if (!approvedOnAccountId) return;
    if (finalizedOnAccountRef.current.has(approvedOnAccountId)) return;
    finalizedOnAccountRef.current.add(approvedOnAccountId);
    (async () => {
      try {
        const { data } = await api.get(`/api/on-account-requests/${approvedOnAccountId}`, {
          headers: getAuthHeaders(),
          params: { _: Date.now() },
        });
        onApprovedRef.current?.(data?.data ?? data);
      } catch {
        finalizedOnAccountRef.current.delete(approvedOnAccountId);
      }
    })();
  }, [approvedOnAccountId]);

  async function acknowledge() {
    if (!current || ackLoading) return;
    const path = ACK_PATH[current.kind] || ACK_PATH.refund;
    setAckLoading(true);
    setErr("");
    try {
      await api.post(`${path}/${current.id}/acknowledge`, {}, { headers: getAuthHeaders() });
      setUnread((prev) => prev.filter((x) => !(x.kind === current.kind && x.id === current.id)));
      await poll();
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "تعذّر التأكيد");
    } finally {
      setAckLoading(false);
    }
  }

  if (!current) return null;

  const approved = current.status === "approved";
  const statusClass = approved ? "shift-modal-success" : "shift-modal-err";

  return (
    <div className="shift-modal-overlay" role="dialog" aria-modal="true" dir="rtl" lang="ar">
      <div className="shift-modal-backdrop" aria-hidden />
      <div className="shift-modal-panel">
        <h2 className="shift-modal-title">{headingFor(current)}</h2>
        <p className={`shift-modal-meta ${statusClass}`}>{titleFor(current)}</p>
        <p className="shift-modal-meta">{detailFor(current)}</p>
        {visible.length > 1 ? (
          <p className="shift-modal-hint">
            {visible.length} إشعار/إشعارات — اضغط «تمّ» للانتقال إلى التالي
          </p>
        ) : null}
        {err ? <div className="shift-modal-err">{err}</div> : null}
        <div className="shift-modal-actions">
          <button
            type="button"
            className="shift-modal-primary"
            onClick={acknowledge}
            disabled={ackLoading}
          >
            {ackLoading ? "جاري الحفظ…" : "تمّ"}
          </button>
          {current.kind === "refund" ? (
            <Link to="/my-refunds" className="shift-modal-secondary" style={{ textAlign: "center", textDecoration: "none" }}>
              كل الطلبات
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}
