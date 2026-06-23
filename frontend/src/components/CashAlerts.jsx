import { Link } from "react-router-dom";
import "./CashAlerts.css";

/**
 * @param {object} props
 * @param {Array<{ severity: string, title: string, body: string, link?: string, linkLabel?: string }>} props.alerts
 */
export default function CashAlerts({ alerts }) {
  if (!alerts || alerts.length === 0) {
    return (
      <div className="cash-alerts cash-alerts--ok" dir="rtl" lang="ar">
        <p className="cash-alerts-ok">🟢 لا تنبيهات حرجة — الوضع طبيعي</p>
      </div>
    );
  }

  return (
    <div className="cash-alerts" dir="rtl" lang="ar">
      {alerts.map((a, i) => (
        <div key={i} className={`cash-alert cash-alert--${a.severity || "info"}`}>
          <div className="cash-alert-title">{a.title}</div>
          <div className="cash-alert-body">{a.body}</div>
          {a.link ? (
            <Link to={a.link} className="cash-alert-link">
              {a.linkLabel || "عرض"}
            </Link>
          ) : null}
        </div>
      ))}
    </div>
  );
}
