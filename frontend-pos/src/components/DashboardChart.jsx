import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import "./DashboardChart.css";

/**
 * @param {object} props
 * @param {Array<{ label: string, chartRevenue: number, chartCost: number }>} props.data
 * @param {boolean} props.isDemo
 */
export default function DashboardChart({ data, isDemo }) {
  const safe = Array.isArray(data) && data.length > 0 ? data : [];

  return (
    <div className="dashboard-chart-wrap" dir="rtl" lang="ar">
      {isDemo ? (
        <div className="dashboard-chart-demo-notice">
          📊 الرسم يعرض <strong>بيانات تجريبية</strong> لأن لا توجد مبيعات في آخر 7 أيام. ستظهر
          الأرقام الفعلية عند استخدام النظام.
        </div>
      ) : (
        <p className="dashboard-chart-hint">
          📊 آخر 7 أيام: صافي الإيراد مقابل تكلفة البضاعة المباعة (تقدير من تكلفة المنتجات).
        </p>
      )}
      <div className="dashboard-chart-box">
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={safe} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.25)" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip
              contentStyle={{
                background: "#18181b",
                border: "1px solid #3f3f46",
                borderRadius: 8,
              }}
            />
            <Legend verticalAlign="bottom" wrapperStyle={{ paddingTop: 12 }} />
            <Line
              type="monotone"
              dataKey="chartRevenue"
              name="صافي الإيراد"
              stroke={isDemo ? "#64748b" : "#22c55e"}
              strokeWidth={2}
              dot={{ r: isDemo ? 3 : 4 }}
              strokeDasharray={isDemo ? "6 4" : undefined}
            />
            <Line
              type="monotone"
              dataKey="chartCost"
              name="تكلفة البضاعة"
              stroke={isDemo ? "#94a3b8" : "#3b82f6"}
              strokeWidth={2}
              dot={{ r: isDemo ? 3 : 4 }}
              strokeDasharray={isDemo ? "6 4" : undefined}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
