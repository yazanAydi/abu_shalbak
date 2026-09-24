import { useEffect, useRef, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { apiErrorMessage } from "../utils/apiError";
import { ils } from "../utils/format";
import { FormField, Input, Select, PrimaryButton, SecondaryButton } from "./ui";
import { sanitizeCountAmount } from "./CashCountFields";
import {
  newPaymentIdempotencyKey,
  paymentPayloadSignature,
} from "../utils/shiftCountSupplierPayment";

/**
 * Forgotten supplier cash already handed out during the selected shift.
 */
export default function CountSupplierPaymentSection({
  shiftId,
  payments = [],
  paymentsTotal = 0,
  pendingRequests = [],
  onPosted,
  onBusyChange,
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [suppliers, setSuppliers] = useState([]);
  const [listLoading, setListLoading] = useState(false);
  const [supplierId, setSupplierId] = useState("");
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
    setSupplierId("");
    setAmount("");
    setNotes("");
    setError("");
    let cancelled = false;
    setListLoading(true);
    api
      .get("/api/shifts/supplier-options", { headers: getAuthHeaders() })
      .then(({ data }) => {
        if (!cancelled) setSuppliers(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        if (!cancelled) setError(apiErrorMessage(err, "فشل تحميل الموردين"));
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

  async function savePayment() {
    if (saving) return;
    setError("");
    const sid = Number(supplierId);
    if (!sid) {
      setError("اختر المورد");
      return;
    }
    const parsed = Number(String(amount).replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("أدخل مبلغاً صالحاً");
      return;
    }
    const sig = paymentPayloadSignature(sid, amount, notes);
    if (lastSentSigRef.current && lastSentSigRef.current !== sig) {
      keyRef.current = newPaymentIdempotencyKey();
    }
    if (!keyRef.current) keyRef.current = newPaymentIdempotencyKey();
    setSaving(true);
    onBusyChange?.(true);
    try {
      const { data } = await api.post(
        `/api/shifts/${shiftId}/supplier-payments`,
        {
          supplier_id: sid,
          amount: parsed,
          notes: notes.trim() || null,
          idempotency_key: keyRef.current,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      lastSentSigRef.current = sig;
      closeForm();
      await onPosted?.(data?.data ?? data);
    } catch (err) {
      lastSentSigRef.current = sig;
      setError(apiErrorMessage(err, "فشل تسجيل الدفعة"));
    } finally {
      setSaving(false);
      onBusyChange?.(false);
    }
  }

  const rows = Array.isArray(payments) ? payments : [];
  const pending = Array.isArray(pendingRequests) ? pendingRequests : [];
  const total = Number(paymentsTotal) || rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);

  return (
    <section style={{ marginBottom: "1rem" }} data-testid="count-supplier-payments">
      <h3 className="dashboard-subtitle" style={{ marginBottom: "0.5rem" }}>
        دفعات الموردين
      </h3>
      {pending.length ? (
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 0.5rem" }}>
          {pending.map((row) => (
            <li key={row.request_id} style={{ marginBottom: "0.35rem" }}>
              بانتظار الموافقة — {row.supplier_name || "مورد"} — {ils(row.amount)} — طلب #{row.request_id}
            </li>
          ))}
        </ul>
      ) : null}
      {rows.length ? (
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 0.5rem" }}>
          {rows.map((row) => (
            <li key={row.voucher_id || row.movement_id} style={{ marginBottom: "0.35rem" }}>
              {row.supplier_name || "مورد"} — {ils(row.amount)} — سند #{row.voucher_no ?? "—"}
              {row.print_label ? ` — ${row.print_label}` : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ color: "var(--office-text-muted)", marginBottom: "0.5rem" }}>لا توجد دفعات مسجّلة على هذه الوردية.</p>
      )}
      <p style={{ marginBottom: "0.5rem" }}>
        الإجمالي: <span className="num">{ils(total)}</span>
      </p>
      {formOpen ? (
        <div>
          <p style={{ color: "var(--office-text-muted)", lineHeight: 1.6 }}>
            لتسجيل مبلغ دُفع بالفعل من صندوق هذه الوردية ولم يُسجل سابقًا. الدفعة المحفوظة تبقى
            مسجّلة حتى إذا ألغيت نافذة العد.
          </p>
          <FormField label="المورد">
            <Select
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              disabled={listLoading || saving}
              placeholder="ابحث عن مورد"
            >
              <option value="">اختر المورد</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
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
            <PrimaryButton type="button" disabled={saving} onClick={savePayment}>
              {saving ? "جاري التسجيل…" : "تسجيل الدفعة"}
            </PrimaryButton>
            <SecondaryButton type="button" disabled={saving} onClick={closeForm}>
              إلغاء
            </SecondaryButton>
          </div>
        </div>
      ) : (
        <SecondaryButton type="button" onClick={() => setFormOpen(true)}>
          تسجيل دفعة مورد من هذه الوردية
        </SecondaryButton>
      )}
    </section>
  );
}
