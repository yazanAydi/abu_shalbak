import { Link } from "react-router-dom";
import { formatDurationAr, shiftOpenDurationMs } from "../utils/dashboardHelpers";
import { dateTime } from "../utils/format";
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
    listRow.expected_cash != null
      ? Number(listRow.expected_cash)
      : detail?.summary?.expected != null
        ? Number(detail.summary.expected)
        : null;
  const opening = listRow.opening_cash != null ? Number(listRow.opening_cash) : null;
  const txCount =
    listRow.sale_count != null
      ? Number(listRow.sale_count)
      : Array.isArray(detail?.transactions)
        ? detail.transactions.length
        : "—";

  return (
    <div className="shift-status-card" dir="rtl" lang="ar">
      <div className="shift-status-head">
        <span className="shift-status-badge shift-status-badge--active">🟢 نشطة</span>
        <h3 className="shift-status-title">وردية: {listRow.cashier_name || `مستخدم #${listRow.cashier_id}`}</h3>
      </div>
      <ul className="shift-status-list">
        <li>
          <span className="shift-status-k">⏱️ بدء الوردية</span>
          <span className="shift-status-v">{dateTime(start)}</span>
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
          <span className="shift-status-k">مبيعات نقدية</span>
          <span className="shift-status-v">
            {listRow.cash_sales != null ? ils(listRow.cash_sales) : "—"}
            {listRow.cash_sales_incomplete ? " (غير مكتمل)" : ""}
          </span>
        </li>
        {Number(listRow.mixed_cash_sales) ? (
          <li>
            <span className="shift-status-k">منها نقد من دفعات مختلطة</span>
            <span className="shift-status-v">{ils(listRow.mixed_cash_sales)}</span>
          </li>
        ) : null}
        <li>
          <span className="shift-status-k">مبيعات فيزا</span>
          <span className="shift-status-v">
            {listRow.visa_sales != null ? ils(listRow.visa_sales) : "—"}
            {listRow.visa_incomplete ? " (غير مكتمل)" : ""}
          </span>
        </li>
        <li>
          <span className="shift-status-k">إجمالي المبيعات النقدية والفيزا</span>
          <span className="shift-status-v">
            {listRow.tender_total != null ? ils(listRow.tender_total) : "—"}
          </span>
        </li>
        <li>
          <span className="shift-status-k">مرتجعات نقدية</span>
          <span className="shift-status-v">
            {listRow.cash_refunds != null ? ils(listRow.cash_refunds) : "—"}
          </span>
        </li>
        <li>
          <span className="shift-status-k">مرتجعات الفيزا</span>
          <span className="shift-status-v">
            {listRow.visa_refunds != null ? ils(listRow.visa_refunds) : "—"}
          </span>
        </li>
        <li>
          <span className="shift-status-k">النقد المتوقع في الصندوق</span>
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
