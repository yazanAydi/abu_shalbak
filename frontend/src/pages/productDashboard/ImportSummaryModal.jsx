import { Modal, SecondaryButton } from "../../components/ui";

const TYPE_LABELS = {
  hesabati_price_list: "قائمة الأسعار",
  hesabati_supplier_balances: "أرصدة الموردين",
  hesabati_customer_balances: "أرصدة الزبائن",
  hesabati_operator_balances: "أرصدة المشغلين",
  hesabati_building_balances: "أرصدة العمارة",
  arabic_retail: "بطاقة الأصناف",
  generic_products: "منتجات",
};

/**
 * @param {{ open: boolean, onClose: () => void, data: object | null }} props
 */
export default function ImportSummaryModal({ open, onClose, data }) {
  if (!data) return null;

  const importType = data.type || data.detected_type || "generic_products";
  const typeLabel = data.label || TYPE_LABELS[importType] || "استيراد";

  const isProductImport =
    !importType.includes("balance") &&
    importType !== "hesabati_customer_balances" &&
    importType !== "hesabati_supplier_balances" &&
    importType !== "hesabati_operator_balances" &&
    importType !== "hesabati_building_balances";

  const isBalanceImport =
    importType.includes("balance") ||
    importType === "hesabati_customer_balances" ||
    importType === "hesabati_supplier_balances" ||
    importType === "hesabati_operator_balances" ||
    importType === "hesabati_building_balances";

  /** @type {{ label: string, value: number }[]} */
  let stats = [];
  if (isProductImport) {
    stats = [
      { label: "منتجات جديدة", value: data.products_created ?? data.created ?? data.inserted ?? 0 },
      { label: "منتجات محدّثة", value: data.products_updated ?? data.updated ?? 0 },
      { label: "باركودات مضافة", value: data.barcodes_added ?? 0 },
      { label: "غير موجود", value: data.not_found ?? 0 },
      { label: "أكواد داخلية قصيرة", value: data.short_internal_codes_added ?? 0 },
      { label: "صفوف تُركت", value: data.skipped ?? 0 },
    ];
  } else if (isBalanceImport) {
    stats = [
      { label: "سجلات جديدة", value: data.created ?? 0 },
      { label: "سجلات محدّثة", value: data.updated ?? 0 },
      { label: "صفوف تُركت", value: data.skipped ?? 0 },
    ];
  } else {
    stats = [
      { label: "جديد", value: data.created ?? data.inserted ?? 0 },
      { label: "محدّث", value: data.updated ?? 0 },
      { label: "تُرك", value: data.skipped ?? 0 },
    ];
  }

  const conflicts = Array.isArray(data.barcode_conflicts) ? data.barcode_conflicts : [];
  const errors = Array.isArray(data.errors) ? data.errors : [];
  const hasUnitBarcodeConflict = conflicts.some((c) => c.barcode === "6223001858911");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`ملخص الاستيراد — ${typeLabel}`}
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
                    <td>
                      {e.reason || e.message}
                      {e.barcode ? ` (${e.barcode})` : ""}
                      {e.name ? ` — ${e.name}` : ""}
                    </td>
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
