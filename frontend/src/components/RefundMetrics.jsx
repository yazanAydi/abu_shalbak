import { ils } from "../utils/refundHelpers";
import "./RefundsManagement.css";

/**
 * @param {object} props
 * @param {object | null} props.summary — /api/refunds/summary
 */
export default function RefundMetrics({ summary }) {
  if (!summary) {
    return (
      <div className="rf-metrics rf-metrics--loading" dir="rtl" lang="ar">
        جاري تحميل المؤشرات…
      </div>
    );
  }

  const pending = summary.pending || { count: 0, amount: 0 };
  const hasPending = Number(pending.count) > 0;

  return (
    <div className="rf-metrics" dir="rtl" lang="ar">
      <div className="rf-metric-card">
        <div className="rf-metric-icon" aria-hidden>
          🛒
        </div>
        <div className="rf-metric-body">
          <div className="rf-metric-label">إجمالي الاسترجاعات</div>
          <div className="rf-metric-value">
            {summary.all_time?.count ?? 0} <span className="rf-metric-sub">| {ils(summary.all_time?.amount ?? 0)}</span>
          </div>
        </div>
      </div>
      <div className="rf-metric-card">
        <div className="rf-metric-icon" aria-hidden>
          📅
        </div>
        <div className="rf-metric-body">
          <div className="rf-metric-label">استرجاعات اليوم</div>
          <div className="rf-metric-value">
            {summary.today?.count ?? 0} <span className="rf-metric-sub">| {ils(summary.today?.amount ?? 0)}</span>
          </div>
        </div>
      </div>
      <div className={`rf-metric-card ${hasPending ? "rf-metric-card--alert" : ""}`}>
        <div className="rf-metric-icon" aria-hidden>
          ⏳
        </div>
        <div className="rf-metric-body">
          <div className="rf-metric-label">قيد المراجعة</div>
          <div className="rf-metric-value">
            {pending.count} <span className="rf-metric-sub">| {ils(pending.amount)}</span>
            {hasPending ? <span className="rf-metric-warn"> ⚠️</span> : null}
          </div>
        </div>
      </div>
      <div className="rf-metric-card">
        <div className="rf-metric-icon" aria-hidden>
          ✓
        </div>
        <div className="rf-metric-body">
          <div className="rf-metric-label">نسبة الموافقة</div>
          <div className="rf-metric-value">{summary.approval_rate_pct ?? 100}%</div>
        </div>
      </div>
    </div>
  );
}
