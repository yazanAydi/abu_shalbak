import { useState } from "react";
import api from "../../apiClient";
import {
  Modal,
  FormField,
  FormGrid,
  Input,
  Textarea,
  PrimaryButton,
  SecondaryButton,
  useToast,
} from "../../components/ui";
import { ils } from "../../utils/format";

export default function ChangePriceModal({ open, onClose, product, onSaved }) {
  const toast = useToast();
  const [newPrice, setNewPrice] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  function close() {
    setNewPrice("");
    setReason("");
    setErr(null);
    onClose?.();
  }

  async function submit() {
    setErr(null);
    if (newPrice === "" || !Number.isFinite(Number(newPrice)) || Number(newPrice) < 0) {
      setErr("أدخل سعراً صالحاً");
      return;
    }
    if (!reason.trim()) {
      setErr("سبب تغيير السعر مطلوب");
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.post(`/api/products/${product.id}/change-price`, {
        new_price: Number(newPrice),
        reason: reason.trim(),
      });
      toast.success("تم تغيير سعر البيع");
      onSaved?.(data);
      close();
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "تعذّر تغيير السعر");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="تغيير سعر البيع"
      footer={
        <>
          <PrimaryButton type="button" onClick={submit} disabled={saving}>
            {saving ? "جاري الحفظ…" : "حفظ السعر الجديد"}
          </PrimaryButton>
          <SecondaryButton type="button" onClick={close} disabled={saving}>
            إلغاء
          </SecondaryButton>
        </>
      }
    >
      <p style={{ marginTop: 0, color: "var(--office-panel-muted, #64748b)" }}>
        السعر الحالي: <strong>{ils(product?.price)}</strong>
        {product?.min_price != null || product?.max_price != null ? (
          <span>
            {"  "}(المسموح: {product?.min_price != null ? ils(product.min_price) : "—"} —{" "}
            {product?.max_price != null ? ils(product.max_price) : "—"})
          </span>
        ) : null}
      </p>
      <FormGrid>
        <FormField label="السعر الجديد" required>
          <Input
            type="number"
            step="0.01"
            min="0"
            value={newPrice}
            onChange={(e) => setNewPrice(e.target.value)}
            autoFocus
          />
        </FormField>
        <FormField label="سبب التغيير" required>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="مثال: زيادة تكلفة المورد، عرض ترويجي، تصحيح سعر…"
          />
        </FormField>
      </FormGrid>
      {err ? <p style={{ color: "var(--office-danger, #dc2626)", marginBottom: 0 }}>{err}</p> : null}
    </Modal>
  );
}
