import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { Card, CardBody, StatCard } from "../../components/ui";
import { ils, num, qty, dateTime } from "../../utils/format";
import { useProductTab } from "./useProductTab";
import { TabState, CHART_COLORS } from "./shared";

export default function SalesByPriceTab({ productId }) {
  const { data, loading, error } = useProductTab(`/api/products/${productId}/sales-by-price`);
  const rows = data?.rows || [];
  const summary = data?.summary;

  const chartData = rows.map((r) => ({
    label: ils(r.unit_price_at_sale),
    quantity: Number(r.net_quantity_sold),
  }));

  return (
    <TabState loading={loading} error={error} empty={rows.length === 0} emptyText="لا توجد مبيعات مسجّلة لهذا المنتج">
      {summary ? (
        <div className="ui-stat-grid pd-cards">
          <StatCard label="إجمالي الكمية" value={qty(summary.total_quantity)} icon="inventory" />
          <StatCard label="إجمالي الإيراد" value={ils(summary.total_revenue)} icon="finance" tone="green" />
          <StatCard label="إجمالي الربح" value={ils(summary.total_profit)} icon="finance" tone="teal" />
          <StatCard label="عدد الأسعار" value={String(summary.distinct_prices)} icon="products" tone="orange" />
        </div>
      ) : null}

      {chartData.length > 0 ? (
        <Card className="pd-chart-card">
          <CardBody>
            <h3 className="pd-section-title">الكمية المباعة عند كل سعر</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData} margin={{ top: 12, right: 16, left: 4, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748b" }} />
                <YAxis tick={{ fontSize: 12, fill: "#64748b" }} width={56} />
                <Tooltip formatter={(v) => [num(v, 0), "الكمية"]} />
                <Bar dataKey="quantity" name="الكمية المباعة" fill={CHART_COLORS.teal} radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardBody>
        </Card>
      ) : null}

      <div className="ui-table-wrap pd-sticky-table">
        <table className="ui-table">
          <thead>
            <tr>
              <th>سعر البيع</th>
              <th>الكمية المباعة</th>
              <th>الإيراد</th>
              <th>الربح</th>
              <th>عدد الفواتير</th>
              <th>أول بيع</th>
              <th>آخر بيع</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.unit_price_at_sale}>
                <td className="num">{ils(r.unit_price_at_sale)}</td>
                <td className="num">{qty(r.net_quantity_sold)}</td>
                <td className="num">{ils(r.total_revenue)}</td>
                <td className="num">{ils(r.total_profit)}</td>
                <td className="num">{r.number_of_transactions}</td>
                <td>{dateTime(r.first_sale_date)}</td>
                <td>{dateTime(r.last_sale_date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TabState>
  );
}
