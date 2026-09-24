import { useEffect, useState } from "react";
import { dateTime } from "../../utils/format";
import { SHOP_TZ } from "../../utils/shopTime";
import BarcodeInput from "../BarcodeInput";

function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="pos-pill clock">
      {now.toLocaleString("ar-u-nu-latn", {
        timeZone: SHOP_TZ,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })}
    </span>
  );
}

export default function PosHeader({
  user,
  posNeedsShift,
  activeShift,
  shiftTxCount,
  onEndShift,
  onLogout,
  onProductFound,
  onRefresh,
  refreshing = false,
  onShopExpense,
  shopExpenseDisabled = false,
}) {
  return (
    <header className="pos-header" dir="rtl" lang="ar">
      <div className="pos-header-scan">
        <div className="pos-header-scan-row">
          <BarcodeInput onProductFound={onProductFound} onError={() => {}} />
          <button
            type="button"
            className="pos-header-shop-expense"
            onClick={onShopExpense}
            disabled={shopExpenseDisabled}
          >
            ترحيل كمصاريف محل
          </button>
        </div>
      </div>
      <div className="pos-header-meta pos-header-meta--compact">
        {posNeedsShift && activeShift ? (
          <>
            <span className="pos-pill">
              وردية {activeShift.start_time ? dateTime(activeShift.start_time) : "—"}
              <span className="pos-meta-divider"> · </span>
              مبيعات: {shiftTxCount}
            </span>
            <button type="button" className="pos-btn-ghost pos-btn-warn pos-btn-ghost--compact" onClick={onEndShift}>
              إغلاق الوردية
            </button>
          </>
        ) : null}
        {typeof onRefresh === "function" ? (
          <button
            type="button"
            className={`pos-btn-ghost pos-btn-ghost--compact${refreshing ? " is-refreshing" : ""}`}
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="تحديث"
          >
            تحديث
          </button>
        ) : null}
        <LiveClock />
        <span className="pos-pill">{user?.username}</span>
        {onLogout ? (
          <button type="button" className="pos-btn-ghost pos-btn-ghost--compact" onClick={onLogout}>
            خروج
          </button>
        ) : null}
      </div>
    </header>
  );
}
