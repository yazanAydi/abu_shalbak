import { ils } from "../../utils/format";
import { PrimaryButton, SecondaryButton, DangerButton } from "../../components/ui";

export default function DuplicateBarcodeConflict({
  existingProduct,
  busy,
  onReplace,
  onDelete,
  onEditBarcode,
}) {
  if (!existingProduct) return null;

  const isActive = Number(existingProduct.is_active) !== 0;

  return (
    <div
      className="duplicate-barcode-conflict"
      style={{
        marginTop: "1rem",
        padding: "1rem 1.25rem",
        borderRadius: "8px",
        border: "1px solid var(--office-warning, #f59e0b)",
        background: "var(--office-warning-bg, rgba(245, 158, 11, 0.08))",
      }}
    >
      <p
        style={{
          margin: "0 0 0.75rem",
          fontWeight: 600,
          color: "var(--office-warning-text, #b45309)",
        }}
      >
        الباركود مستخدم لمنتج موجود
      </p>
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(10rem, 1fr))",
          gap: "0.5rem 1.5rem",
          margin: "0 0 1rem",
          fontSize: "0.9rem",
        }}
      >
        <div>
          <dt style={{ color: "var(--office-text-muted)", marginBottom: "0.15rem" }}>الاسم</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{existingProduct.name}</dd>
        </div>
        <div>
          <dt style={{ color: "var(--office-text-muted)", marginBottom: "0.15rem" }}>الباركود</dt>
          <dd style={{ margin: 0 }}>{existingProduct.barcode}</dd>
        </div>
        <div>
          <dt style={{ color: "var(--office-text-muted)", marginBottom: "0.15rem" }}>السعر</dt>
          <dd style={{ margin: 0 }}>{ils(existingProduct.price)}</dd>
        </div>
        <div>
          <dt style={{ color: "var(--office-text-muted)", marginBottom: "0.15rem" }}>المخزون</dt>
          <dd style={{ margin: 0 }}>{existingProduct.stock}</dd>
        </div>
        {existingProduct.category ? (
          <div>
            <dt style={{ color: "var(--office-text-muted)", marginBottom: "0.15rem" }}>التصنيف</dt>
            <dd style={{ margin: 0 }}>{existingProduct.category}</dd>
          </div>
        ) : null}
        <div>
          <dt style={{ color: "var(--office-text-muted)", marginBottom: "0.15rem" }}>الحالة</dt>
          <dd style={{ margin: 0 }}>{isActive ? "نشط" : "غير نشط"}</dd>
        </div>
      </dl>
      <p style={{ margin: "0 0 0.75rem", fontSize: "0.875rem", color: "var(--office-text-muted)" }}>
        اختر إجراءً: استبدال المنتج ببيانات النموذج، حذف المنتج القديم، أو تغيير باركود المنتج القديم.
      </p>
      <div className="ui-table__actions" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
        <PrimaryButton type="button" onClick={onReplace} disabled={busy}>
          {busy ? "جاري المعالجة…" : "استبدال المنتج"}
        </PrimaryButton>
        <SecondaryButton type="button" onClick={onEditBarcode} disabled={busy}>
          تعديل باركود المنتج القديم
        </SecondaryButton>
        <DangerButton type="button" onClick={onDelete} disabled={busy}>
          حذف المنتج القديم
        </DangerButton>
      </div>
    </div>
  );
}
