import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Button, Modal } from "../ui";

/**
 * Confirms a repeated product on a purchase document.
 * Enter, including a scanner suffix, never confirms the addition.
 */
export default function DuplicateProductDialog({ open, productName, onConfirm, onCancel }) {
  const onceRef = useRef(false);
  const openedAtRef = useRef(0);

  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!open) {
      onceRef.current = false;
      return undefined;
    }
    openedAtRef.current = Date.now();
    const blockKeys = (e) => {
      if (e.key !== "Enter" && e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") onCancelRef.current?.();
    };
    window.addEventListener("keydown", blockKeys, true);
    return () => window.removeEventListener("keydown", blockKeys, true);
  }, [open]);

  function tooSoon(e) {
    if (Date.now() - openedAtRef.current < 350) {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      return true;
    }
    return false;
  }

  function confirm(e) {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (tooSoon(e) || onceRef.current) return;
    onceRef.current = true;
    onConfirm?.();
  }

  function cancel(e) {
    if (tooSoon(e)) return;
    onCancel?.();
  }

  const name = productName || "هذا الصنف";

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <Modal
      open={open}
      title="منتج مكرر"
      description={`الصنف «${name}» موجود مسبقاً في هذه الفاتورة. هل تريد إضافته مرة أخرى؟`}
      onClose={cancel}
      size="sm"
      className="duplicate-product-dialog"
      footer={(
        <>
          <Button type="button" variant="secondary" data-testid="duplicate-cancel" onClick={cancel}>
            إلغاء الإضافة
          </Button>
          <Button type="button" data-testid="duplicate-add-anyway" onClick={confirm} onDoubleClick={confirm}>
            إضافة على أي حال
          </Button>
        </>
      )}
    >
      <span tabIndex={0} autoFocus className="duplicate-product-dialog__focus" data-testid="duplicate-product-dialog" />
    </Modal>,
    document.body
  );
}
