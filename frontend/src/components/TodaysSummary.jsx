import { formatCount, formatMoney } from "../utils/dashboardHelpers";
import Icon from "./icons/Icon";
import "./TodaysSummary.css";
/**
 * @param {object} props
 * @param {object | null} props.today — /api/reports/today
 */
function formatCurrencyAmount(symbol, amount) {
  return `${symbol || "\u20AA"}${Number(amount || 0).toFixed(2)}`;
}

export default function TodaysSummary({ today }) {
  const hasSales = today && (Number(today.transaction_count) > 0 || Number(today.revenue) > 0);
  const hasAny = today != null;
  const collections = Array.isArray(today?.collections_by_currency)
    ? today.collections_by_currency
    : [];
  const showCollections = hasAny && collections.length > 0;

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
        {hasAny && Number(today?.total_tax) > 0 ? (
          <div className="today-card today-card--tax">
            <div className="today-card-icon" aria-hidden><Icon name="expenses" size={22} /></div>
            <div className="today-card-body">
              <div className="today-card-label">ضريبة القيمة المضافة</div>
              <div className="today-card-value">{formatMoney(today?.total_tax, true)}</div>
            </div>
          </div>
        ) : null}
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

      {showCollections ? (
        <div className="today-collections">
          <div className="today-collections-title">تحصيلات اليوم حسب العملة</div>
          <div className="today-collections-grid">
            {collections.map((c) => {
              const isBase = String(c.code).toUpperCase() === "NIS";
              return (
                <div className="today-collection-card" key={c.code}>
                  <div className="today-collection-code">{c.name || c.code}</div>
                  <div className="today-collection-value">
                    {formatCurrencyAmount(c.symbol, c.original_total)}
                  </div>
                  {!isBase ? (
                    <div className="today-collection-sub">
                      المعادل: {formatMoney(c.nis_total, true)}
                    </div>
                  ) : null}
                </div>
              );
            })}
            <div className="today-collection-card today-collection-card--total">
              <div className="today-collection-code">القيمة المحاسبية (₪)</div>
              <div className="today-collection-value">
                {formatMoney(today?.collections_grand_total_nis, true)}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
