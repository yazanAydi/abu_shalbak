import {
  SHIFT_EXPECTED_CASH_LABEL,
  SHIFT_EXPECTED_REVIEW_NOTE,
  SHIFT_OPENING_UNAVAILABLE,
  buildShiftCountDetailLines,
  buildShiftCountSummaryModel,
  buildShiftDrawerLines,
  drawerLineAmount,
  formatSignedMoney,
} from "../utils/shiftVisa";

function Money({ amount, strong }) {
  return (
    <span className={strong ? "shift-count-money shift-count-money--strong" : "shift-count-money"} dir="ltr">
      {formatSignedMoney(amount)}
    </span>
  );
}

function SalesFigure({ label, amount, incomplete, prominent }) {
  return (
    <div className={prominent ? "shift-count-figure shift-count-figure--total" : "shift-count-figure"}>
      <span className="shift-count-figure__label">{label}</span>
      <span className="shift-count-figure__value">
        <Money amount={amount} strong={prominent} />
        {incomplete ? <span className="shift-count-flag"> غير مكتمل</span> : null}
      </span>
    </div>
  );
}

function foreignCurrencyNote(rows) {
  const foreign = (rows || []).filter((row) => !row.is_base && Number(row.original) !== 0);
  if (!foreign.length) return null;
  return foreign.map((row) => formatSignedMoney(row.original, row.symbol || row.code)).join(" + ");
}

/**
 * Sales summary and drawer breakdown for عد النقد.
 * Amounts come from the shift payload. Expected cash is not recalculated here.
 */
export default function ShiftCountTotals({ source, breakdown, includeZeros = false }) {
  const model = buildShiftCountSummaryModel(source || {});
  const details = buildShiftCountDetailLines(model, { includeZeros });
  const drawer = buildShiftDrawerLines(source || {});
  const currencyText = foreignCurrencyNote(breakdown || source?.expected_by_currency);
  const expectedNegative = model.expected.amount != null && model.expected.amount < 0;

  return (
    <div className="shift-count-layout" data-testid="shift-count-totals">
      <section className="shift-count-card" data-testid="shift-count-sales">
        <h3 className="shift-count-card__title">ملخص المبيعات</h3>
        <div className="shift-count-figures">
          <SalesFigure
            label={model.cashSales.label}
            amount={model.cashSales.amount}
            incomplete={model.cashSales.incomplete}
          />
          <SalesFigure label={model.visa.label} amount={model.visa.amount} incomplete={model.visa.incomplete} />
          <SalesFigure label={model.tenderTotal.label} amount={model.tenderTotal.amount} prominent />
        </div>
        {details.length ? (
          <ul className="shift-count-details">
            {details.map((line) => (
              <li key={line.key} className="shift-count-line">
                <span className="shift-count-line__label">{line.label}</span>
                <span className="shift-count-figure__value">
                  <Money amount={line.amount} />
                  {line.incomplete ? <span className="shift-count-flag"> غير مكتمل</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {model.mixedIncluded ? <p className="shift-count-aside">{model.mixedIncludedNote}</p> : null}
        {model.cashIncomplete ? <p className="shift-count-aside">{model.cashSales.incompleteNote}</p> : null}
        {model.visaIncomplete ? <p className="shift-count-aside">{model.visaIncompleteNote}</p> : null}
      </section>

      <section className="shift-count-card" data-testid="shift-count-drawer">
        <h3 className="shift-count-card__title">حركة الصندوق</h3>
        <ul className="shift-count-lines">
          {drawer.map((line) => (
            <li key={line.key} className="shift-count-line">
              <span className="shift-count-line__label">{line.label}</span>
              {line.unavailable ? (
                <span className="shift-count-money">{SHIFT_OPENING_UNAVAILABLE}</span>
              ) : (
                <Money amount={drawerLineAmount(line)} />
              )}
            </li>
          ))}
        </ul>
        <div
          className={expectedNegative ? "shift-count-expected shift-count-expected--neg" : "shift-count-expected"}
          data-testid="shift-count-expected"
        >
          <span className="shift-count-expected__label">{model.expected.label || SHIFT_EXPECTED_CASH_LABEL}</span>
          <span className="shift-count-expected__value">
            {model.expected.amount == null ? (
              <span className="shift-count-money">—</span>
            ) : (
              <Money amount={model.expected.amount} strong />
            )}
          </span>
        </div>
        {expectedNegative ? (
          <p className="shift-count-review" data-testid="shift-count-expected-note">
            {SHIFT_EXPECTED_REVIEW_NOTE}
          </p>
        ) : null}
        {currencyText ? <p className="shift-count-aside">{currencyText}</p> : null}
      </section>
    </div>
  );
}
