import { useEffect, useState } from "react";
import BarcodeInput from "../BarcodeInput";
import PosProductSearch from "./PosProductSearch";

function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="pos-pill clock">
      {now.toLocaleString("ar", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
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
  onProductFound,
}) {
  return (
    <header className="pos-header" dir="rtl" lang="ar">
      <div className="pos-header-scan">
        <div className="pos-header-scan-row">
          <BarcodeInput onProductFound={onProductFound} onError={() => {}} />
          <PosProductSearch onProductFound={onProductFound} />
        </div>
      </div>
      <div className="pos-header-meta pos-header-meta--compact">
        {posNeedsShift && activeShift ? (
          <>
            <span className="pos-pill">
              وردية {activeShift.start_time?.replace("T", " ").slice(0, 16) || "—"}
              <span className="pos-meta-divider"> · </span>
              مبيعات: {shiftTxCount}
            </span>
            <button type="button" className="pos-btn-ghost pos-btn-warn pos-btn-ghost--compact" onClick={onEndShift}>
              إغلاق الوردية
            </button>
          </>
        ) : null}
        <LiveClock />
        <span className="pos-pill">{user?.username}</span>
      </div>
    </header>
  );
}
