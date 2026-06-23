import { Link } from "react-router-dom";
import { formatDurationAr, shiftOpenDurationMs } from "../utils/dashboardHelpers";
import "./ShiftStatusCard.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

/**
 * @param {object} props
 * @param {object | null} props.listRow — row from GET /api/shifts
 * @param {object | null} props.detail — full GET /api/shifts/:id payload
 */
export default function ShiftStatusCard({ listRow, detail }) {
  if (!listRow) return null;

  const start = listRow.start_time;
  const ms = shiftOpenDurationMs(start);
  const expected =
    detail?.summary?.expected != null ? Number(detail.summary.expected) : null;
  const opening = listRow.opening_cash != null ? Number(listRow.opening_cash) : null;
  const txCount = Array.isArray(detail?.transactions) ? detail.transactions.length : "—";

  return (
    <div className="shift-status-card" dir="rtl" lang="ar">
      <div className="shift-status-head">
        <span className="shift-status-badge shift-status-badge--active">🟢 نشطة</span>
        <h3 className="shift-status-title">وردية: {listRow.cashier_name || `مستخدم #${listRow.cashier_id}`}</h3>
      </div>
      <ul className="shift-status-list">
        <li>
          <span className="shift-status-k">⏱️ بدء الوردية</span>
          <span className="shift-status-v">{start?.replace("T", " ").slice(0, 16) || "—"}</span>
        </li>
        <li>
          <span className="shift-status-k">⏱️ مدة مفتوحة</span>
          <span className="shift-status-v">{formatDurationAr(ms)}</span>
        </li>
        <li>
          <span className="shift-status-k">💰 افتتاح الدرج</span>
          <span className="shift-status-v">{opening != null ? ils(opening) : "—"}</span>
        </li>
        <li>
          <span className="shift-status-k">📊 عدد المبيعات</span>
          <span className="shift-status-v">{txCount}</span>
        </li>
        <li>
          <span className="shift-status-k">💰 نقد متوقع (درج)</span>
          <span className="shift-status-v">{expected != null ? ils(expected) : "—"}</span>
        </li>
        <li>
          <span className="shift-status-k">💵 نقد فعلي (عدّ)</span>
          <span className="shift-status-v muted">— حتى إغلاق الوردية</span>
        </li>
      </ul>
      <Link to="/shift-audit" className="shift-status-link">
        عرض تفاصيل الوردية
      </Link>
    </div>
  );
}

/** @param {object} props */
export function ShiftStatusEmpty() {
  return (
    <div className="shift-status-card shift-status-card--empty" dir="rtl" lang="ar">
      <span className="shift-status-badge shift-status-badge--closed">⚪ لا ورديات نشطة</span>
      <p className="shift-status-empty-msg">لا توجد وردية مفتوحة حالياً. سيظهر الكاشيرون هنا عند بدء وردياتهم.</p>
    </div>
  );
}
