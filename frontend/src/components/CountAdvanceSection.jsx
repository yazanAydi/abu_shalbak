import { useEffect, useRef, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { apiErrorMessage } from "../utils/apiError";
import { ils } from "../utils/format";
import { FormField, Input, Select, PrimaryButton, SecondaryButton } from "./ui";
import { sanitizeCountAmount } from "./CashCountFields";
import {
  newPaymentIdempotencyKey,
  advancePayloadSignature,
} from "../utils/shiftCountSupplierPayment";

/**
 * Forgotten سلف already handed out during the selected shift.
 */
export default function CountAdvanceSection({
  shiftId,
  advances = [],
  advancesTotal = 0,
  onPosted,
  onBusyChange,
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [employees, setEmployees] = useState([]);
  const [listLoading, setListLoading] = useState(false);
  const [employeeId, setEmployeeId] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const keyRef = useRef(null);
  const lastSentSigRef = useRef(null);

  useEffect(() => {
    onBusyChange?.(saving);
  }, [saving, onBusyChange]);

  useEffect(() => {
    if (!formOpen) return undefined;
    keyRef.current = newPaymentIdempotencyKey();
    lastSentSigRef.current = null;
    setEmployeeId("");
    setAmount("");
    setNotes("");
    setError("");
    let cancelled = false;
    setListLoading(true);
    api
      .get("/api/shifts/employee-options", { headers: getAuthHeaders() })
      .then(({ data }) => {
        if (!cancelled) setEmployees(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        if (!cancelled) setError(apiErrorMessage(err, "فشل تحميل الموظفين"));
      })
      .finally(() => {
        if (!cancelled) setListLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [formOpen]);

  function closeForm() {
    setFormOpen(false);
    setError("");
    keyRef.current = null;
    lastSentSigRef.current = null;
  }

  async function saveAdvance() {
    if (saving) return;
    setError("");
    const eid = Number(employeeId);
    if (!eid) {
      setError("اختر الموظف");
      return;
    }
    const parsed = Number(String(amount).replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("أدخل مبلغاً صالحاً");
      return;
    }
    const sig = advancePayloadSignature(eid, amount, notes);
    if (lastSentSigRef.current && lastSentSigRef.current !== sig) {
      keyRef.current = newPaymentIdempotencyKey();
    }
    if (!keyRef.current) keyRef.current = newPaymentIdempotencyKey();
    setSaving(true);
    onBusyChange?.(true);
    try {
      await api.post(
        `/api/shifts/${shiftId}/advances`,
        {
          employee_id: eid,
          amount: parsed,
          notes: notes.trim() || null,
          idempotency_key: keyRef.current,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      lastSentSigRef.current = sig;
      closeForm();
      await onPosted?.();
    } catch (err) {
      lastSentSigRef.current = sig;
      setError(apiErrorMessage(err, "فشل تسجيل السلف"));
    } finally {
      setSaving(false);
      onBusyChange?.(false);
    }
  }

  const rows = Array.isArray(advances) ? advances : [];
  const total = Number(advancesTotal) || rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);

  return (
    <section style={{ marginBottom: "1rem" }} data-testid="count-advances">
      <h3 className="dashboard-subtitle" style={{ marginBottom: "0.5rem" }}>
        سلف
      </h3>
      {rows.length ? (
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 0.5rem" }}>
          {rows.map((row) => (
            <li key={row.request_id || row.movement_id} style={{ marginBottom: "0.35rem" }}>
              {row.employee_name || "موظف"} — {ils(row.amount)}
              {row.request_id != null ? ` — طلب #${row.request_id}` : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ color: "var(--office-text-muted)", marginBottom: "0.5rem" }}>لا توجد سلف مسجّلة على هذه الوردية.</p>
      )}
      <p style={{ marginBottom: "0.5rem" }}>
        الإجمالي: <span className="num">{ils(total)}</span>
      </p>
      {formOpen ? (
        <div>
          <p style={{ color: "var(--office-text-muted)", lineHeight: 1.6 }}>
            لتسجيل مبلغ سُلّف بالفعل من صندوق هذه الوردية ولم يُسجل سابقًا. السلفة المحفوظة تبقى
            مسجّلة حتى إذا ألغيت نافذة العد.
          </p>
          <FormField label="الموظف">
            <Select
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              disabled={listLoading || saving}
              placeholder="ابحث عن موظف"
            >
              <option value="">اختر الموظف</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.display_name || e.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="المبلغ ₪">
            <Input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={amount}
              disabled={saving}
              onChange={(e) => {
                const next = sanitizeCountAmount(e.target.value);
                if (next != null) setAmount(next);
              }}
            />
          </FormField>
          <FormField label="ملاحظة (اختياري)">
            <Input value={notes} disabled={saving} onChange={(e) => setNotes(e.target.value)} />
          </FormField>
          {error ? <p className="negative">{error}</p> : null}
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
            <PrimaryButton type="button" disabled={saving} onClick={saveAdvance}>
              {saving ? "جاري التسجيل…" : "تسجيل السلفة"}
            </PrimaryButton>
            <SecondaryButton type="button" disabled={saving} onClick={closeForm}>
              إلغاء
            </SecondaryButton>
          </div>
        </div>
      ) : (
        <SecondaryButton type="button" onClick={() => setFormOpen(true)}>
          تسجيل سلف من هذه الوردية
        </SecondaryButton>
      )}
    </section>
  );
}
