import { dateOnly, num } from "../utils/format";
import { customerBalanceView } from "../utils/customerBalanceDisplay";
import { displayEntityCode } from "../utils/entityCodeDisplay";

export function formatStatementAmount(amount) {
  const n = Number(amount) || 0;
  if (Math.abs(n) < 0.009) return "—";
  return num(n);
}

export function getDisplayRows(report) {
  if (!report) return [];
  return report.formatted?.rows || report.rows?.map(normalizeApiRow) || [];
}

function normalizeApiRow(r) {
  return {
    line_no: r.line_no ?? r.referenceNumber,
    description: r.description,
    date: r.date,
    debit: r.debit,
    credit: r.credit,
    balance: r.runningBalance,
    balance_formatted: r.runningBalanceFormatted,
    balance_is_negative: Number(r.runningBalance) < 0,
    notes: r.notes,
    ev_type: r.sourceType,
    ref_id: r.sourceId,
  };
}

export function renderStatementBalance(partyType, row) {
  const formatted = row.balance_formatted;
  const isNeg = row.balance_is_negative || Number(row.balance) < 0;
  if (partyType === "supplier") {
    return (
      <span className={isNeg ? "hesabati-balance--neg negative" : ""}>{formatted}</span>
    );
  }
  const { className } = customerBalanceView(Number(row.balance || 0));
  return <span className={`${className} ${isNeg ? "hesabati-balance--neg" : ""}`}>{formatted}</span>;
}

/**
 * @param {{ report: object, partyType: "supplier"|"customer" }} props
 */
export default function AccountStatementView({ report, partyType }) {
  if (!report) return null;

  const rows = getDisplayRows(report);
  const partyLabel = partyType === "supplier" ? "المورد" : "العميل";
  const totals = report.totals || report.formatted?.totals;
  const closingFmt =
    report.totals?.finalBalanceFormatted ||
    totals?.final_balance_formatted ||
    report.closing_balance_formatted ||
    report.formatted?.closing_balance_formatted;

  const closingBalance =
    report.totals?.finalBalance ?? totals?.final_balance ?? report.party?.balance;
  const closingIsNeg = Number(closingBalance) < 0;

  const rangeLabel =
    report.date_from && report.date_to
      ? `من ${dateOnly(report.date_from)} إلى ${dateOnly(report.date_to)}`
      : "كل الفترات";

  return (
    <div className="statement-view hesabati-statement account-statement-view">
      <div className="hesabati-statement__store">{report.store_name || "أبو شلبك"}</div>
      <div className="hesabati-statement__title">{report.report_title || report.title || "كشف حساب"}</div>
      <div className="statement-header hesabati-statement__header">
        <div><strong>{partyLabel}:</strong> {report.party?.name}</div>
        {report.party?.code ? (
          <div><strong>الرقم:</strong> {displayEntityCode(report.party.code)}</div>
        ) : null}
        {report.party?.phone ? (
          <div><strong>الهاتف:</strong> {report.party.phone}</div>
        ) : null}
        <div><strong>الفترة:</strong> {rangeLabel}</div>
        <div><strong>تاريخ الطباعة:</strong> {dateOnly(report.print_date || new Date().toISOString())}</div>
        <div>
          <strong>الرصيد النهائي:</strong>{" "}
          <span className={closingIsNeg ? "hesabati-balance--neg negative" : ""}>
            {closingFmt || formatStatementAmount(closingBalance)}
          </span>
        </div>
      </div>
      <div className="hesabati-statement__table-wrap">
        <table className="hesabati-statement-table">
          <thead>
            <tr>
              <th>الرقم</th>
              <th>البيان</th>
              <th>التاريخ</th>
              <th>مدين</th>
              <th>دائن</th>
              <th>الرصيد</th>
              <th>ملاحظات</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={`${row.ev_type}-${row.ref_id}-${i}`}>
                <td className="num">{row.line_no || "—"}</td>
                <td>{row.description}</td>
                <td>{row.date ? dateOnly(row.date) : "—"}</td>
                <td className="num">{formatStatementAmount(row.debit)}</td>
                <td className="num">{formatStatementAmount(row.credit)}</td>
                <td className={`num ${row.balance_is_negative ? "hesabati-balance--neg" : ""}`}>
                  {renderStatementBalance(partyType, row)}
                </td>
                <td className="hesabati-notes">{row.notes || "—"}</td>
              </tr>
            ))}
          </tbody>
          {totals ? (
            <tfoot>
              <tr className="hesabati-statement-totals">
                <td colSpan={3}><strong>الإجمالي</strong></td>
                <td className="num"><strong>{formatStatementAmount(totals.debit)}</strong></td>
                <td className="num"><strong>{formatStatementAmount(totals.credit)}</strong></td>
                <td className="num">
                  <strong>{totals.final_balance_formatted || totals.finalBalanceFormatted}</strong>
                </td>
                <td />
              </tr>
            </tfoot>
          ) : null}
        </table>
        {!rows.length ? (
          <p className="empty-msg">لا توجد حركات في الفترة المحددة.</p>
        ) : null}
      </div>
    </div>
  );
}
