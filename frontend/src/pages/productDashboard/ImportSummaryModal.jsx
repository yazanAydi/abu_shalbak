import { Modal, SecondaryButton } from "../../components/ui";

/**
 * @param {{ open: boolean, onClose: () => void, data: object | null }} props
 */
export default function ImportSummaryModal({ open, onClose, data }) {
  if (!data) return null;

  const stats = [
    { label: "منتجات جديدة", value: data.products_created ?? data.inserted ?? 0 },
    { label: "منتجات محدّثة", value: data.products_updated ?? 0 },
    { label: "باركودات مضافة", value: data.barcodes_added ?? 0 },
    { label: "أكواد داخلية قصيرة", value: data.short_internal_codes_added ?? 0 },
    { label: "خلايا scientific notation", value: data.scientific_notation_cells_detected ?? 0 },
    { label: "صفوف بلا باركود", value: data.rows_no_barcode_found ?? 0 },
    { label: "باركودات مكررة (تُركت)", value: data.duplicate_barcodes_skipped ?? 0 },
    { label: "صفوف تُركت", value: data.skipped ?? 0 },
  ];

  const conflicts = Array.isArray(data.barcode_conflicts) ? data.barcode_conflicts : [];
  const errors = Array.isArray(data.errors) ? data.errors : [];
  const hasUnitBarcodeConflict = conflicts.some((c) => c.barcode === "6223001858911");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="ملخص الاستيراد"
      footer={
        <SecondaryButton type="button" onClick={onClose}>
          إغلاق
        </SecondaryButton>
      }
    >
      <p style={{ marginTop: 0, color: "var(--office-text-muted)" }}>
        {data.message}
      </p>
      <div className="import-summary-stats">
        {stats.map((s) => (
          <div key={s.label} className="import-summary-stat">
            <span className="import-summary-stat-label">{s.label}</span>
            <strong>{s.value}</strong>
          </div>
        ))}
      </div>

      {conflicts.length > 0 ? (
        <>
          <p className="import-summary-conflict-note">
            {hasUnitBarcodeConflict
              ? "باركود 6223001858911 مربوط بمنتج آخر — احذف المنتج المكرر أو حرّر الباركود ثم أعد الاستيراد."
              : "بعض الباركودات مربوطة بمنتجات أخرى — راجع الجدول أدناه واحذف المكررات ثم أعد الاستيراد."}
          </p>
          <h4 style={{ marginBottom: "0.5rem" }}>تعارضات الباركود</h4>
          <div className="import-summary-table-wrap">
            <table className="import-summary-table">
              <thead>
                <tr>
                  <th>صف</th>
                  <th>باركود</th>
                  <th>منتج موجود</th>
                </tr>
              </thead>
              <tbody>
                {conflicts.map((c, i) => (
                  <tr key={`${c.row}-${c.barcode}-${i}`}>
                    <td>{c.row}</td>
                    <td>{c.barcode}</td>
                    <td>{c.existing_product_name || c.existing_product_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {errors.length > 0 ? (
        <>
          <h4 style={{ marginBottom: "0.5rem" }}>أخطاء / صفوف مُتخطّاة</h4>
          <div className="import-summary-table-wrap">
            <table className="import-summary-table">
              <thead>
                <tr>
                  <th>صف</th>
                  <th>سبب</th>
                </tr>
              </thead>
              <tbody>
                {errors.map((e, i) => (
                  <tr key={`${e.row}-${i}`}>
                    <td>{e.row}</td>
                    <td>{e.reason}{e.barcode ? ` (${e.barcode})` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
