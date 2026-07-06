import { Modal, SecondaryButton } from "../../components/ui";
import ProductUnitsSection from "./ProductUnitsSection";

export default function ProductUnitsModal({ open, onClose, product, onChanged }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={product ? `وحدات: ${product.name}` : "الوحدات"}
      size="lg"
      footer={
        <SecondaryButton type="button" onClick={onClose}>
          تم
        </SecondaryButton>
      }
    >
      <p style={{ marginTop: 0, color: "var(--office-text-muted)", fontSize: "0.9rem" }}>
        أضف وحدات التعبئة الأكبر (صندوق، ربطة…) مع باركودها ومعامل التحويل. يمكنك التخطي.
      </p>
      <ProductUnitsSection productId={product?.id ?? null} onChanged={onChanged} />
    </Modal>
  );
}
