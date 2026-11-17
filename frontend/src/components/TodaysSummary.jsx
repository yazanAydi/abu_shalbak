import { formatCount, formatMoney } from "../utils/dashboardHelpers";
import Icon from "./icons/Icon";
import "./TodaysSummary.css";
/**
 * @param {object} props
 * @param {object | null} props.today — /api/reports/today
 */
export default function TodaysSummary({ today }) {
  const hasSales = today && (Number(today.transaction_count) > 0 || Number(today.revenue) > 0);
  const hasAny = today != null;

  return (
    <div className="today-summary" dir="rtl" lang="ar">
      <div className="today-summary-grid">
        <div className="today-card today-card--revenue">
          <div className="today-card-icon" aria-hidden>
            <Icon name="finance" size={22} />
          </div>          <div className="today-card-body">
            <div className="today-card-label">إيراد اليوم (صافي)</div>
            <div className="today-card-value">{formatMoney(today?.revenue, hasAny && hasSales)}</div>
          </div>
        </div>
        <div className="today-card today-card--tx">
          <div className="today-card-icon" aria-hidden>
            <Icon name="dashboard" size={22} />
          </div>          <div className="today-card-body">
            <div className="today-card-label">عدد العمليات</div>
            <div className="today-card-value">
              {formatCount(today?.transaction_count, hasAny && Number(today?.transaction_count) > 0)}
            </div>
          </div>
        </div>
        <div className="today-card today-card--refund">
          <div className="today-card-icon" aria-hidden>
            <Icon name="refunds" size={22} />
          </div>          <div className="today-card-body">
            <div className="today-card-label">المرتجعات</div>
            <div className="today-card-value">
              {formatCount(today?.refund_count, hasAny && Number(today?.refund_count) > 0)}
              {hasAny && Number(today?.refund_count) > 0 ? (
                <span className="today-card-sub"> {formatMoney(today?.refund_amount, true)}</span>
              ) : null}
            </div>
          </div>
        </div>
        {hasAny && Number(today?.on_account_total) > 0 ? (
          <div className="today-card today-card--account">
            <div className="today-card-icon" aria-hidden><Icon name="vouchers" size={22} /></div>
            <div className="today-card-body">
              <div className="today-card-label">مبيعات الذمة</div>
              <div className="today-card-value">{formatMoney(today?.on_account_total, true)}</div>
            </div>
          </div>
        ) : null}
        <div className="today-card today-card--items">
          <div className="today-card-icon" aria-hidden>
            <Icon name="inventory" size={22} />
          </div>          <div className="today-card-body">
            <div className="today-card-label">القطع المباعة</div>
            <div className="today-card-value">
              {formatCount(today?.items_sold, hasAny && Number(today?.items_sold) > 0)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
