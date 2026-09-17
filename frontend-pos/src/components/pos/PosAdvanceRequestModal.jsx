import { useEffect, useState } from "react";
import api from "../../apiClient";
import { getAuthHeaders } from "../../utils/auth";
import SearchableSelect from "../ui/SearchableSelect";
import { handleEnterNavKeyDown } from "../../utils/focusNavigation";
import "../ShiftModal.css";

const EMPTY_EMPLOYEES_MSG = "لا يوجد موظفون مسجلون. أضف الموظفين من الموظفون والرواتب.";

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {(requestId: number) => void} [props.onWaiting]
 */
export default function PosAdvanceRequestModal({ open, onClose, onWaiting }) {
  const [employeeId, setEmployeeId] = useState("");
  const [employees, setEmployees] = useState([]);
  const [listLoading, setListLoading] = useState(false);
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setListLoading(true);
    api
      .get("/api/pos/employees", { headers: getAuthHeaders() })
      .then(({ data }) => {
        if (cancelled) return;
        const rows = Array.isArray(data) ? data : [];
        setEmployees(rows);
        if (rows.length === 0) setError(EMPTY_EMPLOYEES_MSG);
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.error || err.message || "فشل تحميل الموظفين");
      })
      .finally(() => {
        if (!cancelled) setListLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  function resetForm() {
    setEmployeeId("");
    setAmount("");
    setNotes("");
    setError("");
  }

  function handleClose() {
    resetForm();
    onClose();
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (employees.length === 0) {
      setError(EMPTY_EMPLOYEES_MSG);
      return;
    }
    const empId = Number(employeeId);
    if (!empId) {
      setError("اختر الموظف");
      return;
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("أدخل مبلغاً صالحاً");
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.post(
        "/api/advance-requests",
        {
          employee_id: empId,
          amount: amt,
          notes: notes.trim() || null,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      const payload = data?.data ?? data;
      const requestId = payload.request_id;
      resetForm();
      if (requestId) onWaiting?.(requestId);
      else onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message || "فشل إرسال الطلب");
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  const noEmployees = !listLoading && employees.length === 0;

  return (
    <div className="shift-modal-overlay" role="dialog" aria-modal="true" dir="rtl" lang="ar">
      <div className="shift-modal-backdrop" onClick={handleClose} aria-hidden />
      <form className="shift-modal-panel shift-modal-panel--form" data-enter-nav="" onKeyDown={handleEnterNavKeyDown} onSubmit={handleSubmit}>
        <h2 className="shift-modal-title">طلب سلف</h2>
        <p className="shift-modal-lead">اختر الموظف وأدخل المبلغ — يُرسل للمدير للموافقة عبر تيليجرام أو لوحة الإدارة. الطلب يبقى معلّقاً حتى الموافقة.</p>

        <label className="shift-modal-label">
          الموظف
          <SearchableSelect
            className="shift-modal-input"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            placeholder="اختر الموظف"
            disabled={listLoading || noEmployees}
            required
          >
            <option value="">اختر الموظف</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.display_name || emp.name}
              </option>
            ))}
          </SearchableSelect>
        </label>

        <label className="shift-modal-label">
          المبلغ (₪)
          <input
            className="shift-modal-input"
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </label>

        <label className="shift-modal-label">
          ملاحظات (اختياري)
          <input
            className="shift-modal-input"
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={500}
            placeholder="سبب السلفة أو ملاحظة للمدير"
          />
        </label>

        {noEmployees ? <div className="shift-modal-err">{EMPTY_EMPLOYEES_MSG}</div> : null}
        {error && error !== EMPTY_EMPLOYEES_MSG ? <div className="shift-modal-err">{error}</div> : null}

        <div className="shift-modal-actions">
          <button type="button" className="shift-modal-secondary" onClick={handleClose} disabled={loading}>
            إلغاء
          </button>
          <button type="submit" className="shift-modal-primary" disabled={loading || noEmployees || listLoading}>
            {loading ? "جاري الإرسال…" : "إرسال للموافقة"}
          </button>
        </div>
      </form>
    </div>
  );
}
