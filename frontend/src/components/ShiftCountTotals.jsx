import { buildShiftCountSummaryModel } from "../utils/shiftVisa";
import { expectedBreakdownText } from "./CashCountFields";

function TotalsRow({ line, strong, incomplete, total }) {
  if (!line) return null;
  const className = strong
    ? total
      ? "shift-count-totals-row shift-count-totals-row--total"
      : "shift-count-totals-row"
    : "shift-count-totals-support";
  return (
    <div className={className}>
      <span>{line.label}</span>
      <span className="num">
        {line.value}
        {incomplete ? " (غير مكتمل)" : ""}
      </span>
    </div>
  );
}

/**
 * Compact cash / Visa / drawer lines for عد النقد and shift close.
 * Gross sales stay separate from refunds and from drawer expected cash.
 */
export default function ShiftCountTotals({ source, breakdown }) {
  const model = buildShiftCountSummaryModel(source || {});
  const currencyText = expectedBreakdownText(breakdown || source?.expected_by_currency);
  return (
    <div className="shift-count-totals" data-testid="shift-count-totals">
      <TotalsRow line={model.cashSales} strong incomplete={model.cashSales.incomplete} />
      {model.cashIncomplete ? (
        <p className="shift-count-totals-note">{model.cashSales.incompleteNote}</p>
      ) : null}
      {model.mixedIncluded ? (
        <>
          <TotalsRow line={model.mixedIncluded} />
          <p className="shift-count-totals-note">{model.mixedIncludedNote}</p>
        </>
      ) : null}
      <TotalsRow line={model.visa} strong incomplete={model.visa.incomplete} />
      <TotalsRow line={model.tenderTotal} strong total />
      <TotalsRow line={model.cashRefunds} />
      <TotalsRow line={model.visaRefunds} />
      <TotalsRow line={model.cashNet} />
      <TotalsRow line={model.visaNet} />
      <p className="shift-count-totals-note">
        {model.visaNote}
        {model.visaIncomplete ? ` ${model.visaIncompleteNote}` : ""}
      </p>
      <TotalsRow line={model.expected} />
      {currencyText ? <p className="shift-count-totals-support">{currencyText}</p> : null}
    </div>
  );
}
