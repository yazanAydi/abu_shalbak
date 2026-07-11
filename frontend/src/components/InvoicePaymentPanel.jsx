import { useMemo, useState } from "react";
import { Button, FormField, Input, Select } from "./ui";

const METHODS = [
  { id: "cash", label: "نقدًا" },
  { id: "visa", label: "بطاقة" },
  { id: "on_account", label: "ذمة" },
  { id: "check", label: "شيك" },
];

const ils = (n) => `₪${Number(n ?? 0).toFixed(2)}`;

function emptyLine() {
  return { method: "cash", amount: "", bank_name: "", check_no: "" };
}

/**
 * Payment panel for posting office sales invoices (single or mixed).
 * @param {{ total: number, onSubmit: (payload: object) => void, onCancel: () => void, submitting?: boolean }} props
 */
export default function InvoicePaymentPanel({ total, onSubmit, onCancel, submitting = false }) {
  const [mode, setMode] = useState("single");
  const [singleMethod, setSingleMethod] = useState("cash");
  const [bankName, setBankName] = useState("");
  const [checkNo, setCheckNo] = useState("");
  const [lines, setLines] = useState([emptyLine()]);

  const paid = useMemo(() => {
    if (mode === "single") return total;
    return lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  }, [mode, lines, total]);

  const remaining = round2(total - paid);

  function updateLine(i, key, val) {
    setLines((prev) => prev.map((x, idx) => (idx === i ? { ...x, [key]: val } : x)));
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(i) {
    setLines((prev) => prev.filter((_, idx) => idx !== i));
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (mode === "single") {
      if (singleMethod === "check" && !bankName.trim()) return;
      onSubmit({
        payment_method: singleMethod,
        bank_name: singleMethod === "check" ? bankName.trim() : undefined,
        check_no: singleMethod === "check" ? checkNo.trim() || undefined : undefined,
      });
      return;
    }
    const payments = lines
      .map((l) => ({
        method: l.method,
        amount: Number(l.amount) || 0,
        bank_name: l.method === "check" ? String(l.bank_name || "").trim() : undefined,
        check_no: l.method === "check" ? String(l.check_no || "").trim() || undefined : undefined,
      }))
      .filter((p) => p.amount > 0);
    if (payments.length === 0) return;
    if (payments.some((p) => p.method === "check" && !p.bank_name)) return;
    onSubmit({ payments });
  }

  const canSubmit =
    mode === "single"
      ? singleMethod !== "check" || bankName.trim()
      : lines.some((l) => Number(l.amount) > 0) &&
        !lines.some((l) => l.method === "check" && Number(l.amount) > 0 && !String(l.bank_name || "").trim()) &&
        remaining <= 0.005;

  return (
    <form className="invoice-payment-panel" onSubmit={handleSubmit}>
      <div className="invoice-payment-panel__total">
        <span>إجمالي الفاتورة</span>
        <strong>{ils(total)}</strong>
      </div>

      <FormField label="طريقة الدفع">
        <Select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="single">طريقة واحدة</option>
          <option value="mixed">دفع مختلط</option>
        </Select>
      </FormField>

      {mode === "single" ? (
        <>
          <FormField label="النوع">
            <Select value={singleMethod} onChange={(e) => setSingleMethod(e.target.value)}>
              {METHODS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </Select>
          </FormField>
          {singleMethod === "check" ? (
            <>
              <FormField label="اسم البنك" required>
                <Input value={bankName} onChange={(e) => setBankName(e.target.value)} />
              </FormField>
              <FormField label="رقم الشيك">
                <Input value={checkNo} onChange={(e) => setCheckNo(e.target.value)} />
              </FormField>
            </>
          ) : null}
        </>
      ) : (
        <div className="invoice-payment-panel__lines">
          {lines.map((line, i) => (
            <div key={i} className="invoice-payment-panel__line">
              <Select value={line.method} onChange={(e) => updateLine(i, "method", e.target.value)}>
                {METHODS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </Select>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="المبلغ"
                value={line.amount}
                onChange={(e) => updateLine(i, "amount", e.target.value)}
              />
              {line.method === "check" ? (
                <>
                  <Input
                    placeholder="البنك *"
                    value={line.bank_name}
                    onChange={(e) => updateLine(i, "bank_name", e.target.value)}
                  />
                  <Input
                    placeholder="رقم الشيك"
                    value={line.check_no}
                    onChange={(e) => updateLine(i, "check_no", e.target.value)}
                  />
                </>
              ) : null}
              <Button type="button" variant="ghost" size="sm" onClick={() => removeLine(i)} disabled={lines.length <= 1}>
                حذف
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addLine}>+ سطر دفع</Button>
          <div className={`invoice-payment-panel__summary${remaining <= 0.005 ? " invoice-payment-panel__summary--ok" : ""}`}>
            <span>المدفوع: {ils(paid)}</span>
            <span>المتبقي: {ils(Math.max(0, remaining))}</span>
          </div>
        </div>
      )}

      <div className="ui-toolbar" style={{ marginTop: "1rem" }}>
        <Button type="submit" disabled={!canSubmit || submitting}>
          {submitting ? "جاري الترحيل…" : "ترحيل الفاتورة"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          إلغاء
        </Button>
      </div>
    </form>
  );
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
