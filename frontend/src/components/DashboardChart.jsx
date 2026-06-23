import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import "./DashboardChart.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

/**
 * @param {object} props
 * @param {Array<{ label: string, chartRevenue: number }>} props.data
 * @param {boolean} props.isDemo
 * @param {"week"|"month"} props.period
 * @param {(p: "week"|"month") => void} [props.onPeriodChange]
 */
export default function DashboardChart({ data, isDemo, period, onPeriodChange }) {
  const safe = Array.isArray(data) && data.length > 0 ? data : [];
  const periodLabel = period === "month" ? "30 يوماً" : "7 أيام";

  return (
    <div className="dashboard-chart-wrap" dir="rtl" lang="ar">
      <div className="dashboard-chart-toolbar">
        <div className="dashboard-period-toggle" role="group" aria-label="فترة الرسم">
          <button
            type="button"
            className={period === "week" ? "active" : ""}
            onClick={() => onPeriodChange?.("week")}
          >
            أسبوع
          </button>
          <button
            type="button"
            className={period === "month" ? "active" : ""}
            onClick={() => onPeriodChange?.("month")}
          >
            شهر
          </button>
        </div>
      </div>

      {isDemo ? (
        <div className="dashboard-chart-demo-notice">
          الرسم يعرض <strong>بيانات تجريبية</strong> لأن لا توجد مبيعات في آخر {periodLabel}. ستظهر
          الأرقام الفعلية عند استخدام النظام.
        </div>
      ) : (
        <p className="dashboard-chart-hint">
          صافي الإيراد اليومي — آخر {periodLabel}
        </p>
      )}

      <div className="dashboard-chart-box">
        <ResponsiveContainer width="100%" height={340}>
          <LineChart data={safe} margin={{ top: 12, right: 12, left: 4, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: period === "month" ? 10 : 12, fill: "#64748b" }}
              interval={period === "month" ? 4 : 0}
            />
            <YAxis
              tick={{ fontSize: 12, fill: "#64748b" }}
              tickFormatter={(v) => ils(v)}
              width={72}
            />
            <Tooltip
              formatter={(value) => [ils(value), "صافي الإيراد"]}
              labelFormatter={(label) => `اليوم ${label}`}
              contentStyle={{
                background: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: 8,
                color: "#1e293b",
                boxShadow: "0 4px 12px rgba(15,23,42,0.1)",
              }}
            />
            <Line
              type="monotone"
              dataKey="chartRevenue"
              name="صافي الإيراد"
              stroke={isDemo ? "#94a3b8" : "#0f766e"}
              strokeWidth={2.5}
              dot={{ r: period === "month" ? 2 : 4, fill: isDemo ? "#94a3b8" : "#0f766e" }}
              activeDot={{ r: 6 }}
              strokeDasharray={isDemo ? "6 4" : undefined}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
