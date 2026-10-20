import { useEffect, useState } from "react";
import { dateTimeSeconds, ils } from "../utils/format";
import {
  VISA_INCOMPLETE_NOTE,
  VISA_MACHINE_HINT,
  VISA_RECONCILE_LABELS,
  formatSignedMoney,
  parseVisaMachineInput,
  visaExpectedCaption,
  visaReconciliationStatus,
} from "../utils/shiftVisa";
import { FormField, Input, SecondaryButton } from "./ui";

function Money({ amount }) {
  if (amount == null || Number.isNaN(Number(amount))) return <span className="shift-count-money">—</span>;
  return (
    <span className="shift-count-money" dir="ltr">
      {formatSignedMoney(amount)}
    </span>
  );
}

function Figure({ label, amount, flag }) {
  return (
    <div className="shift-count-figure">
      <span className="shift-count-figure__label">{label}</span>
      <span className="shift-count-figure__value">
        <Money amount={amount} />
        {flag ? <span className="shift-count-flag"> {flag}</span> : null}
      </span>
    </div>
  );
}

export default function ShiftVisaSection({
  visa,
  reconciliation,
  machineValue,
  onMachineChange,
  showInput = false,
  inputDisabled = false,
  corrections = [],
  onOpenLines,
  onCorrect,
  correcting = false,
  onSave,
  saving = false,
}) {
  const live = reconciliation?.live || visa || {};
  const saved = reconciliation?.saved || null;
  const incomplete = !!(reconciliation?.incomplete ?? visa?.visa_incomplete);
  const sales = saved ? saved.sales : Number(live.visa_sales ?? visa?.visa_sales) || 0;
  const other = saved ? saved.other : Number(live.visa_other_receipts ?? visa?.visa_other_receipts) || 0;
  const refunds = saved ? saved.refunds : Number(live.visa_refunds ?? visa?.visa_refunds) || 0;
  const expected = saved ? saved.net : Number(live.visa_net ?? visa?.visa_net) || 0;
  const receiptCount = saved
    ? saved.receipt_count
    : Number(live.visa_receipt_count ?? visa?.visa_receipt_count) || 0;
  const parsed = parseVisaMachineInput(machineValue);
  const previewDifference =
    !saved && parsed.value != null ? Math.round((parsed.value - expected) * 100) / 100 : null;
  const previewing = !saved && !incomplete && parsed.value != null;
  const status = visaReconciliationStatus({
    saved: !!saved || previewing,
    difference: saved ? saved.difference : previewDifference,
    incomplete,
  });
  const shownDifference = saved ? saved.difference : previewDifference;
  const expectedLabel = saved ? VISA_RECONCILE_LABELS.expected : visaExpectedCaption(incomplete);
  const [correctValue, setCorrectValue] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    setCorrectValue("");
    setReason("");
  }, [saved?.machine_net, saved?.counted_at]);

  return (
    <section className="shift-count-card" data-testid="shift-visa-section">
      <h3 className="shift-count-card__title">تحصيلات الفيزا</h3>
      <div className="shift-count-figures">
        <div className="shift-count-figure">
          <span className="shift-count-figure__label">{VISA_RECONCILE_LABELS.receiptCount}</span>
          <span className="shift-count-figure__value">
            <span className="shift-count-money" dir="ltr">
              {receiptCount}
            </span>
          </span>
        </div>
        <Figure
          label={VISA_RECONCILE_LABELS.sales}
          amount={sales}
          flag={incomplete && !saved ? VISA_RECONCILE_LABELS.incomplete : null}
        />
        {other !== 0 ? <Figure label={VISA_RECONCILE_LABELS.other} amount={other} /> : null}
        <Figure label={VISA_RECONCILE_LABELS.refunds} amount={refunds} />
        <Figure
          label={expectedLabel}
          amount={expected}
          flag={incomplete && !saved ? VISA_RECONCILE_LABELS.incomplete : null}
        />
      </div>
      {incomplete && !saved ? <p className="shift-count-aside">{VISA_INCOMPLETE_NOTE}</p> : null}
      {saved ? (
        <ul className="shift-count-lines">
          <li className="shift-count-line">
            <span className="shift-count-line__label">{VISA_RECONCILE_LABELS.machine}</span>
            <Money amount={saved.machine_net} />
          </li>
          <li className="shift-count-line">
            <span className="shift-count-line__label">{VISA_RECONCILE_LABELS.difference}</span>
            <span className="shift-count-figure__value">
              <Money amount={saved.difference} />
              <span className="shift-count-flag"> {status.label}</span>
            </span>
          </li>
        </ul>
      ) : null}
      {showInput && !saved ? (
        <FormField label={VISA_RECONCILE_LABELS.machine} hint={VISA_MACHINE_HINT}>
          <Input
            value={machineValue}
            onChange={(e) => onMachineChange(e.target.value)}
            inputMode="decimal"
            disabled={inputDisabled || incomplete}
            placeholder={VISA_RECONCILE_LABELS.waiting}
            data-testid="visa-machine-input"
          />
        </FormField>
      ) : null}
      {!saved && previewDifference != null ? (
        <p className="shift-count-line">
          <span className="shift-count-line__label">{VISA_RECONCILE_LABELS.difference}</span>
          <span className="shift-count-figure__value">
            <Money amount={shownDifference} />
            <span className="shift-count-flag"> {status.label}</span>
          </span>
        </p>
      ) : null}
      {!saved && (machineValue == null || String(machineValue).trim() === "") ? (
        <p className="shift-count-aside">{VISA_RECONCILE_LABELS.waiting}</p>
      ) : null}
      {reconciliation?.basis_changed ? (
        <p className="shift-count-aside" data-testid="visa-basis-changed">
          {VISA_RECONCILE_LABELS.basisChanged}. النشاط الحالي: {ils(live.visa_net ?? visa?.visa_net)} (
          {VISA_RECONCILE_LABELS.receiptCount} {live.visa_receipt_count ?? visa?.visa_receipt_count ?? 0}).
        </p>
      ) : null}
      <div className="ui-mt-sm">
        <SecondaryButton type="button" onClick={onOpenLines}>
          عرض العمليات
        </SecondaryButton>
        {showInput && !saved && onSave ? (
          <SecondaryButton type="button" onClick={onSave} disabled={saving || incomplete}>
            {saving ? "جاري الحفظ…" : "حفظ مطابقة الفيزا"}
          </SecondaryButton>
        ) : null}
      </div>
      {saved && onCorrect ? (
        <div className="ui-mt-sm">
          <FormField label="تصحيح صافي جهاز الفيزا" hint="لا يفتح الوردية ولا يغيّر عد النقد">
            <Input
              value={correctValue}
              onChange={(e) => setCorrectValue(e.target.value)}
              inputMode="decimal"
              data-testid="visa-correct-input"
            />
          </FormField>
          <FormField label="سبب التصحيح">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              data-testid="visa-correct-reason"
            />
          </FormField>
          <SecondaryButton
            type="button"
            disabled={correcting}
            onClick={() => onCorrect(correctValue, reason)}
          >
            {correcting ? "جاري التصحيح…" : "حفظ التصحيح"}
          </SecondaryButton>
        </div>
      ) : null}
      {corrections.length ? (
        <ul className="shift-count-details">
          {corrections.map((row) => (
            <li key={row.id} className="shift-count-line">
              <span className="shift-count-line__label">
                {row.corrected_by_name || "مستخدم"} — {dateTimeSeconds(row.corrected_at)} — {row.reason}
              </span>
              <span className="shift-count-money" dir="ltr">
                {formatSignedMoney(row.previous_machine_net)} → {formatSignedMoney(row.revised_machine_net)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function VisaActivityList({ lines, incomplete }) {
  if (!lines?.length) {
    return <p className="shift-section-empty">{incomplete ? VISA_INCOMPLETE_NOTE : "لا توجد عمليات فيزا"}</p>;
  }
  return (
    <div className="dashboard-stock-list-wrap">
      {incomplete ? <p className="shift-count-aside">{VISA_INCOMPLETE_NOTE}</p> : null}
      <table className="data-table">
        <thead>
          <tr>
            <th>المرجع</th>
            <th>الوقت</th>
            <th>النوع</th>
            <th>مبلغ الفيزا</th>
            <th>المرتجع</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={`${line.kind}-${line.refund_id || line.transaction_id}`}>
              <td>{line.reference}</td>
              <td>{dateTimeSeconds(line.created_at)}</td>
              <td>{line.type_label}</td>
              <td dir="ltr">{ils(line.visa_amount)}</td>
              <td>
                {line.kind === "refund"
                  ? `مرتجع #${line.refund_id}`
                  : line.reversal
                    ? `مرتجع فيزا #${line.reversal.refund_id}`
                    : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
