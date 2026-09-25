import { useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { apiErrorMessage } from "../utils/apiError";
import { ils } from "../utils/format";
import { FormField, Select, PrimaryButton, SecondaryButton, Notice } from "./ui";

const REVIEW_PATH = {
  refund: "/api/refund-requests",
  zimma: "/api/on-account-requests",
  cash_debt: "/api/customer-cash-debt-requests",
  advance: "/api/advance-requests",
};

function goodsText(goods) {
  if (!Array.isArray(goods) || goods.length === 0) return "";
  return goods
    .map((line) => `${line.name}${line.unit_name ? ` (${line.unit_name})` : ""} × ${line.quantity}`)
    .join("، ");
}

export default function CountPendingDecisions({
  pendingRequests = [],
  discrepancies = [],
  balanced = true,
  onChanged,
}) {
  const [busyId, setBusyId] = useState("");
  const [rejectChoice, setRejectChoice] = useState({});
  const [error, setError] = useState("");

  async function decide(row, status) {
    const path = REVIEW_PATH[row.kind];
    if (!path) return;
    const disposition = rejectChoice[`${row.kind}:${row.request_id}`];
    if (status === "rejected" && disposition !== "returned" && disposition !== "outstanding") {
      setError("حدد هل أُعيد النقد أو البضاعة");
      return;
    }
    setError("");
    setBusyId(`${row.kind}:${row.request_id}`);
    try {
      await api.put(
        `${path}/${row.request_id}`,
        {
          status,
          review_notes: null,
          ...(status === "rejected" ? { handover_disposition: disposition } : {}),
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      await onChanged?.();
    } catch (e) {
      setError(apiErrorMessage(e, "تعذّر حفظ القرار"));
    } finally {
      setBusyId("");
    }
  }

  async function followUp(row, disposition) {
    const path = REVIEW_PATH[row.kind];
    if (!path) return;
    setError("");
    setBusyId(`fix:${row.kind}:${row.request_id}`);
    try {
      await api.post(
        `${path}/${row.request_id}/handover`,
        { disposition },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      await onChanged?.();
    } catch (e) {
      setError(apiErrorMessage(e, "تعذّر تحديث حالة الإعادة"));
    } finally {
      setBusyId("");
    }
  }

  return (
    <div style={{ marginBottom: "1rem" }}>
      {balanced ? null : (
        <Notice tone="warn">
          الوردية غير متوازنة: يوجد نقد أو بضاعة سُلّمت ولم تُسجَّل كحركة، أو قُبل عجزها دون عكس القيد.
        </Notice>
      )}
      {error ? <Notice tone="warn">{error}</Notice> : null}

      <h3 className="dashboard-subtitle">طلبات معلّقة على هذه الوردية</h3>
      {pendingRequests.length === 0 ? (
        <p className="shift-section-empty">لا توجد طلبات معلّقة</p>
      ) : (
        <ul className="dashboard-stock-list">
          {pendingRequests.map((row) => {
            const key = `${row.kind}:${row.request_id}`;
            return (
              <li key={key} style={{ display: "block", marginBottom: "0.75rem" }}>
                <div>
                  {row.label} — <span className="num">{ils(row.amount)}</span>
                </div>
                {row.can_decide ? (
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.35rem" }}>
                    <PrimaryButton
                      size="sm"
                      type="button"
                      disabled={busyId === key}
                      onClick={() => decide(row, "approved")}
                    >
                      موافقة
                    </PrimaryButton>
                    <Select
                      value={rejectChoice[key] || ""}
                      onChange={(e) =>
                        setRejectChoice((prev) => ({ ...prev, [key]: e.target.value }))
                      }
                    >
                      <option value="">هل أُعيد؟</option>
                      <option value="returned">نعم، أُعيد</option>
                      <option value="outstanding">لا، لم يُعد</option>
                    </Select>
                    <SecondaryButton
                      size="sm"
                      type="button"
                      disabled={busyId === key}
                      onClick={() => decide(row, "rejected")}
                    >
                      رفض
                    </SecondaryButton>
                  </div>
                ) : (
                  <p className="ui-hint">العرض فقط. قرار هذا الطلب يحتاج صلاحية الموافقة الخاصة به.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {discrepancies.length === 0 ? null : (
        <>
          <h3 className="dashboard-subtitle">نقد أو بضاعة لم تُسوَّ</h3>
          <ul className="dashboard-stock-list">
            {discrepancies.map((row) => {
              const key = `fix:${row.kind}:${row.request_id}`;
              const goods = goodsText(row.goods);
              return (
                <li key={`${row.kind}:${row.request_id}`} style={{ display: "block", marginBottom: "0.75rem" }}>
                  <div>
                    {row.label}
                    {row.cash_amount != null ? ` — نقد ${ils(row.cash_amount)}` : ""}
                    {goods ? ` — بضاعة: ${goods}` : ""}
                    {row.disposition === "loss_accepted" ? " — عجز مقبول" : " — لم يُعد"}
                  </div>
                  {row.blocks_count && row.can_decide ? (
                    <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.35rem" }}>
                      <SecondaryButton size="sm" type="button" disabled={busyId === key} onClick={() => followUp(row, "returned")}>
                        سُجّل أنّها أُعيدت
                      </SecondaryButton>
                      <SecondaryButton size="sm" type="button" disabled={busyId === key} onClick={() => followUp(row, "loss_accepted")}>
                        قبول العجز
                      </SecondaryButton>
                    </div>
                  ) : null}
                  {row.blocks_count && !row.can_decide ? (
                    <p className="ui-hint">العرض فقط. تسجيل الإعادة أو قبول العجز يحتاج صلاحية الموافقة.</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

export function HandoverRejectField({ value, onChange }) {
  return (
    <FormField label="هل أُعيد النقد أو البضاعة؟">
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">اختر</option>
        <option value="returned">نعم، أُعيد</option>
        <option value="outstanding">لا، لم يُعد</option>
      </Select>
    </FormField>
  );
}
