import { useMemo, useState } from "react";
import { formatRefundReason, ils, sortRefunds, statusLabelAr } from "../utils/refundHelpers";
import "./RefundsManagement.css";

const PM = { cash: "نقد", visa: "بطاقة" };

/**
 * @param {object} props
 * @param {object[]} props.rows
 * @param {Set<number>} props.selected
 * @param {(id: number, checked: boolean) => void} props.onToggleSelect
 * @param {(ids: number[]) => void} props.onToggleSelectAllPending
 * @param {(row: object) => void} props.onViewDetails
 * @param {(row: object) => void} props.onPrint
 */
export default function RefundTable({
  rows,
  selected,
  onToggleSelect,
  onToggleSelectAllPending,
  onViewDetails,
  onPrint,
}) {
  const [sortKey, setSortKey] = useState("created_at");
  const [sortDir, setSortDir] = useState("desc");

  const sorted = useMemo(() => sortRefunds(rows || [], sortKey, sortDir), [rows, sortKey, sortDir]);

  function headerClick(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "created_at" ? "desc" : "asc");
    }
  }

  const pendingRows = (rows || []).filter((r) => r.status === "pending");
  const allPendingSelected =
    pendingRows.length > 0 && pendingRows.every((r) => selected.has(r.id));

  return (
    <>
      <div className="rf-bulk-bar" dir="rtl" lang="ar">
        <label className="rf-bulk-check">
          <input
            type="checkbox"
            checked={allPendingSelected}
            onChange={() => onToggleSelectAllPending(pendingRows.map((r) => r.id))}
          />
          تحديد كل المعلّقة
        </label>
        <span className="rf-bulk-count">المحدد: {selected.size}</span>
      </div>

      <div className="rf-table-wrap rf-table-wrap--desktop">
        <table className="rf-table">
          <thead>
            <tr>
              <th className="rf-th-check" />
              <th className="rf-th-sort" onClick={() => headerClick("cashier_username")}>
                الكاشير {sortKey === "cashier_username" ? (sortDir === "asc" ? "↑" : "↓") : ""}
              </th>
              <th className="rf-th-sort" onClick={() => headerClick("original_transaction_id")}>
                رقم الفاتورة {sortKey === "original_transaction_id" ? (sortDir === "asc" ? "↑" : "↓") : ""}
              </th>
              <th className="rf-th-sort" onClick={() => headerClick("reason")}>
                السبب {sortKey === "reason" ? (sortDir === "asc" ? "↑" : "↓") : ""}
              </th>
              <th className="rf-th-sort" onClick={() => headerClick("total")}>
                المبلغ {sortKey === "total" ? (sortDir === "asc" ? "↑" : "↓") : ""}
              </th>
              <th className="rf-th-sort" onClick={() => headerClick("status")}>
                الحالة {sortKey === "status" ? (sortDir === "asc" ? "↑" : "↓") : ""}
              </th>
              <th className="rf-th-sort" onClick={() => headerClick("created_at")}>
                التاريخ {sortKey === "created_at" ? (sortDir === "asc" ? "↑" : "↓") : ""}
              </th>
              <th>إجراءات</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const st = statusLabelAr(r);
              return (
                <tr
                  key={r.id}
                  className="rf-tr"
                  onClick={() => onViewDetails(r)}
                  onKeyDown={(e) => e.key === "Enter" && onViewDetails(r)}
                  role="button"
                  tabIndex={0}
                >
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={(e) => onToggleSelect(r.id, e.target.checked)}
                    />
                  </td>
                  <td>{r.cashier_username}</td>
                  <td>#{r.original_transaction_id}</td>
                  <td>{formatRefundReason(r.reason)}</td>
                  <td>{ils(r.total)}</td>
                  <td>
                    <span className={`rf-status rf-status--${st.tone}`}>
                      {st.icon} {st.text}
                    </span>
                  </td>
                  <td>{r.created_at?.replace("T", " ").slice(0, 16)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="rf-mini-btn" onClick={() => onViewDetails(r)}>
                      تفاصيل
                    </button>
                    <button type="button" className="rf-mini-btn" onClick={() => onPrint(r)}>
                      🖨️
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="rf-cards rf-cards--mobile" dir="rtl" lang="ar">
        {sorted.map((r) => {
          const st = statusLabelAr(r);
          return (
            <div
              key={r.id}
              className="rf-card"
              role="button"
              tabIndex={0}
              onClick={() => onViewDetails(r)}
              onKeyDown={(e) => e.key === "Enter" && onViewDetails(r)}
            >
              <div className="rf-card-head">
                <span className={`rf-status rf-status--${st.tone}`}>
                  {st.icon} {st.text}
                </span>
                <span className="rf-card-amt">{ils(r.total)}</span>
              </div>
              <div className="rf-card-row">
                <span>الكاشير</span>
                <span>{r.cashier_username}</span>
              </div>
              <div className="rf-card-row">
                <span>فاتورة</span>
                <span>#{r.original_transaction_id}</span>
              </div>
              <div className="rf-card-row">
                <span>التاريخ</span>
                <span>{r.created_at?.replace("T", " ").slice(0, 16)}</span>
              </div>
              <div className="rf-card-actions" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selected.has(r.id)}
                  onChange={(e) => onToggleSelect(r.id, e.target.checked)}
                />
                <button type="button" className="rf-mini-btn" onClick={() => onPrint(r)}>
                  طباعة
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
