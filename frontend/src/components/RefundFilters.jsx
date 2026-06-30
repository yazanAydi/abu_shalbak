import "./RefundsManagement.css";
import { Select } from "./ui";

const STATUS_OPTS = [
  { value: "", label: "الكل" },
  { value: "pending", label: "قيد المراجعة" },
  { value: "approved", label: "موافَق" },
  { value: "rejected", label: "مرفوض" },
];

/**
 * @param {object} props
 * @param {{ dateFrom: string, dateTo: string, cashierName: string, status: string, minAmount: string, maxAmount: string, q: string }} props.filters
 * @param {(f: object) => void} props.onChange
 * @param {() => void} props.onSearch
 * @param {() => void} props.onReset
 */
export default function RefundFilters({ filters, onChange, onSearch, onReset }) {
  function set(k, v) {
    onChange({ ...filters, [k]: v });
  }

  return (
    <div className="rf-filters" dir="rtl" lang="ar">
      <div className="rf-filters-grid">
        <label className="rf-flab">
          من تاريخ
          <input
            type="date"
            className="rf-finput"
            value={filters.dateFrom}
            onChange={(e) => set("dateFrom", e.target.value)}
          />
        </label>
        <label className="rf-flab">
          إلى تاريخ
          <input
            type="date"
            className="rf-finput"
            value={filters.dateTo}
            onChange={(e) => set("dateTo", e.target.value)}
          />
        </label>
        <label className="rf-flab">
          اسم الكاشير
          <input
            type="text"
            className="rf-finput"
            value={filters.cashierName}
            onChange={(e) => set("cashierName", e.target.value)}
            placeholder="ابحث باسم الكاشير..."
            autoComplete="off"
          />
        </label>
        <label className="rf-flab">
          الحالة
          <Select
            className="rf-finput"
            value={filters.status}
            onChange={(e) => set("status", e.target.value)}
          >
            {STATUS_OPTS.map((o) => (
              <option key={o.value || "all"} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="rf-flab">
          المبلغ من ({`\u20AA`})
          <input
            type="number"
            min="0"
            step="0.01"
            className="rf-finput"
            value={filters.minAmount}
            onChange={(e) => set("minAmount", e.target.value)}
            placeholder="0"
          />
        </label>
        <label className="rf-flab">
          المبلغ إلى ({`\u20AA`})
          <input
            type="number"
            min="0"
            step="0.01"
            className="rf-finput"
            value={filters.maxAmount}
            onChange={(e) => set("maxAmount", e.target.value)}
            placeholder="—"
          />
        </label>
        <label className="rf-flab rf-flab--wide">
          بحث (رقم الفاتورة أو الكاشير)
          <input
            type="search"
            className="rf-finput"
            value={filters.q}
            onChange={(e) => set("q", e.target.value)}
            placeholder="مثال: 42 أو ahmed"
          />
        </label>
      </div>
      <div className="rf-filters-actions">
        <button type="button" className="rf-fbtn rf-fbtn--primary" onClick={onSearch}>
          بحث
        </button>
        <button type="button" className="rf-fbtn" onClick={onReset}>
          إعادة تعيين
        </button>
      </div>
    </div>
  );
}
