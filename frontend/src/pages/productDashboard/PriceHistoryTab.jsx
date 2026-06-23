import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { Card, CardBody, StatusBadge } from "../../components/ui";
import { ils, dateTime } from "../../utils/format";
import { useProductTab } from "./useProductTab";
import { TabState, CHART_COLORS } from "./shared";

export default function PriceHistoryTab({ productId }) {
  const { data, loading, error } = useProductTab(`/api/products/${productId}/price-history`);
  const rows = data?.rows || [];

  // Chart data oldest -> newest
  const chartData = [...rows]
    .reverse()
    .map((r) => ({ label: dateTime(r.created_at), price: Number(r.new_price) }));

  function diffBadge(diff) {
    const d = Number(diff) || 0;
    if (d > 0) return <StatusBadge tone="green" noDot>{`▲ ${ils(d)}`}</StatusBadge>;
    if (d < 0) return <StatusBadge tone="red" noDot>{`▼ ${ils(Math.abs(d))}`}</StatusBadge>;
    return <StatusBadge tone="neutral" noDot>—</StatusBadge>;
  }

  return (
    <TabState loading={loading} error={error} empty={rows.length === 0} emptyText="لا توجد تغييرات سعرية مسجّلة لهذا المنتج بعد">
      {chartData.length > 1 ? (
        <Card className="pd-chart-card">
          <CardBody>
            <h3 className="pd-section-title">تطور سعر البيع</h3>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData} margin={{ top: 12, right: 16, left: 4, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748b" }} />
                <YAxis tick={{ fontSize: 12, fill: "#64748b" }} tickFormatter={(v) => ils(v)} width={80} />
                <Tooltip formatter={(v) => [ils(v), "سعر البيع"]} />
                <Line type="stepAfter" dataKey="price" name="سعر البيع" stroke={CHART_COLORS.teal} strokeWidth={2.5} dot={{ r: 4 }} activeDot={{ r: 6 }} />
              </LineChart>
            </ResponsiveContainer>
          </CardBody>
        </Card>
      ) : null}

      <div className="ui-table-wrap pd-sticky-table">
        <table className="ui-table">
          <thead>
            <tr>
              <th>التاريخ</th>
              <th>السعر القديم</th>
              <th>السعر الجديد</th>
              <th>الفرق</th>
              <th>غُيّر بواسطة</th>
              <th>السبب</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{dateTime(r.created_at)}</td>
                <td className="num">{r.old_price != null ? ils(r.old_price) : "—"}</td>
                <td className="num">{ils(r.new_price)}</td>
                <td>{diffBadge(r.difference)}</td>
                <td>{r.changed_by || "—"}</td>
                <td>{r.reason || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TabState>
  );
}
