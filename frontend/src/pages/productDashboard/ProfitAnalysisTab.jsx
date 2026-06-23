import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  LineChart,
} from "recharts";
import { Card, CardBody, StatCard } from "../../components/ui";
import { ils, num, dateOnly } from "../../utils/format";
import { useProductTab } from "./useProductTab";
import { TabState, CHART_COLORS } from "./shared";

export default function ProfitAnalysisTab({ productId }) {
  const { data, loading, error } = useProductTab(`/api/products/${productId}/profit-analysis`);
  const cards = data?.cards;
  const series = (data?.series || []).map((d) => ({
    label: dateOnly(d.day),
    revenue: Number(d.revenue),
    profit: Number(d.profit),
    margin: Number(d.margin_pct),
  }));

  return (
    <TabState loading={loading} error={error} empty={!cards || series.length === 0} emptyText="لا توجد بيانات أرباح كافية لهذا المنتج">
      {cards ? (
        <div className="ui-stat-grid pd-cards">
          <StatCard label="متوسط سعر البيع" value={ils(cards.avg_selling_price)} icon="finance" tone="green" />
          <StatCard label="متوسط تكلفة الشراء" value={ils(cards.avg_purchase_cost)} icon="purchases" tone="orange" />
          <StatCard label="الهامش الحالي" value={`${num(cards.current_margin)}%`} icon="finance" tone="teal" />
          <StatCard label="الهامش التاريخي" value={`${num(cards.historical_margin)}%`} icon="finance" tone="teal" />
          <StatCard label="أعلى هامش" value={`${num(cards.highest_margin)}%`} icon="finance" tone="green" />
          <StatCard label="أدنى هامش" value={`${num(cards.lowest_margin)}%`} icon="finance" tone="red" />
        </div>
      ) : null}

      {series.length > 0 ? (
        <>
          <Card className="pd-chart-card">
            <CardBody>
              <h3 className="pd-section-title">الإيراد مقابل الربح</h3>
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={series} margin={{ top: 12, right: 16, left: 4, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#64748b" }} />
                  <YAxis tick={{ fontSize: 12, fill: "#64748b" }} tickFormatter={(v) => ils(v)} width={80} />
                  <Tooltip formatter={(v, n) => [ils(v), n === "revenue" ? "الإيراد" : "الربح"]} />
                  <Legend formatter={(v) => (v === "revenue" ? "الإيراد" : "الربح")} />
                  <Bar dataKey="revenue" name="revenue" fill={CHART_COLORS.blue} radius={[6, 6, 0, 0]} />
                  <Line type="monotone" dataKey="profit" name="profit" stroke={CHART_COLORS.green} strokeWidth={2.5} dot={{ r: 3 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </CardBody>
          </Card>

          <Card className="pd-chart-card">
            <CardBody>
              <h3 className="pd-section-title">هامش الربح % عبر الزمن</h3>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={series} margin={{ top: 12, right: 16, left: 4, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#64748b" }} />
                  <YAxis tick={{ fontSize: 12, fill: "#64748b" }} tickFormatter={(v) => `${v}%`} width={56} />
                  <Tooltip formatter={(v) => [`${num(v)}%`, "الهامش"]} />
                  <Line type="monotone" dataKey="margin" name="الهامش" stroke={CHART_COLORS.purple} strokeWidth={2.5} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </CardBody>
          </Card>
        </>
      ) : null}
    </TabState>
  );
}
