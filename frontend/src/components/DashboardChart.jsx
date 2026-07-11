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

/** @typedef {"week"|"rolling30"|"calendarMonth"} ChartPeriod */

const PERIOD_LABELS = {
  week: "7 أيام",
  rolling30: "30 يوم",
  calendarMonth: "هذا الشهر",
};

/**
 * @param {object} props
 * @param {Array<{ label: string, chartRevenue: number, date?: string }>} props.data
 * @param {boolean} props.isDemo
 * @param {ChartPeriod} props.period
 * @param {(p: ChartPeriod) => void} [props.onPeriodChange]
 * @param {(date: string) => void} [props.onDayClick]
 */
export default function DashboardChart({ data, isDemo, period, onPeriodChange, onDayClick }) {
  const safe = Array.isArray(data) && data.length > 0 ? data : [];
  const periodLabel = PERIOD_LABELS[period] || PERIOD_LABELS.week;
  const isLongSeries = safe.length > 14;
  const clickable = Boolean(onDayClick) && !isDemo;

  return (
    <div className="dashboard-chart-wrap" dir="rtl" lang="ar">
      <div className="dashboard-chart-toolbar">
        <div className="dashboard-period-toggle" role="group" aria-label="فترة الرسم">
          <button
            type="button"
            className={period === "week" ? "active" : ""}
            onClick={() => onPeriodChange?.("week")}
          >
            7 أيام
          </button>
          <button
            type="button"
            className={period === "rolling30" ? "active" : ""}
            onClick={() => onPeriodChange?.("rolling30")}
          >
            30 يوم
          </button>
          <button
            type="button"
            className={period === "calendarMonth" ? "active" : ""}
            onClick={() => onPeriodChange?.("calendarMonth")}
          >
            هذا الشهر
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
          صافي الإيراد اليومي — {periodLabel}
          {clickable ? " — انقر على يوم لعرض التقرير" : ""}
        </p>
      )}

      <div className="dashboard-chart-box">
        <ResponsiveContainer width="100%" height={340}>
          <LineChart data={safe} margin={{ top: 12, right: 12, left: 4, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: isLongSeries ? 10 : 12, fill: "#64748b" }}
              interval={isLongSeries ? 4 : 0}
            />
            <YAxis
              tick={{ fontSize: 12, fill: "#64748b" }}
              tickFormatter={(v) => ils(v)}
              width={72}
            />
            <Tooltip
              formatter={(value) => [ils(value), "صافي الإيراد"]}
              labelFormatter={(label, payload) => {
                const date = payload?.[0]?.payload?.date;
                return date ? `${date} (${label})` : `اليوم ${label}`;
              }}
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
              dot={(props) => {
                const { cx, cy, payload } = props;
                if (cx == null || cy == null) return null;
                return (
                  <circle
                    cx={cx}
                    cy={cy}
                    r={isLongSeries ? 2 : 4}
                    fill={isDemo ? "#94a3b8" : "#0f766e"}
                    style={{ cursor: clickable ? "pointer" : "default" }}
                    onClick={() => {
                      if (clickable && payload?.date) onDayClick(payload.date);
                    }}
                  />
                );
              }}
              activeDot={{ r: 6 }}
              strokeDasharray={isDemo ? "6 4" : undefined}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
