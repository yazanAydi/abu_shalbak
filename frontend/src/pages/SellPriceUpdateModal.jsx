import { useEffect, useState } from "react";
import api from "../apiClient";
import {
  Modal,
  FormField,
  FormGrid,
  Input,
  Textarea,
  PrimaryButton,
  SecondaryButton,
  useToast,
} from "../components/ui";
import { ils } from "../utils/format";

export default function SellPriceUpdateModal({
  open,
  onClose,
  productId,
  productName,
  oldSellPrice,
  newPurchaseCost,
  minPrice,
  maxPrice,
  onSaved,
}) {
  const toast = useToast();
  const [newPrice, setNewPrice] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!open) return;
    setNewPrice(oldSellPrice != null && oldSellPrice !== "" ? String(oldSellPrice) : "");
    setReason("");
    setErr(null);
  }, [open, oldSellPrice, productId]);

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
    setSaving(true);
    try {
      const { data } = await api.post(`/api/products/${productId}/change-price`, {
        new_price: Number(newPrice),
        reason: reason.trim() || "تحديث بعد تغير سعر الشراء",
      });
      toast.success("تم تغيير سعر البيع");
      onSaved?.(data?.product?.price ?? Number(newPrice));
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
            {saving ? "جاري الحفظ…" : "تغيير السعر"}
          </PrimaryButton>
          <SecondaryButton type="button" onClick={close} disabled={saving}>
            تجاهل
          </SecondaryButton>
        </>
      }
    >
      <p style={{ marginTop: 0, color: "var(--office-panel-muted, #64748b)" }}>
        {productName ? <>الصنف: <strong>{productName}</strong><br /></> : null}
        سعر الشراء الجديد: <strong>{ils(newPurchaseCost)}</strong>
      </p>
      <p style={{ marginTop: 0, color: "var(--office-panel-muted, #64748b)" }}>
        سعر البيع الحالي: <strong>{ils(oldSellPrice)}</strong>
        {minPrice != null || maxPrice != null ? (
          <span>
            {"  "}(المسموح: {minPrice != null ? ils(minPrice) : "—"} —{" "}
            {maxPrice != null ? ils(maxPrice) : "—"})
          </span>
        ) : null}
      </p>
      <FormGrid>
        <FormField label="سعر البيع الجديد" required>
          <Input
            type="number"
            step="0.01"
            min="0"
            value={newPrice}
            onChange={(e) => setNewPrice(e.target.value)}
            autoFocus
          />
        </FormField>
        <FormField label="سبب التغيير">
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="اختياري — مثال: زيادة تكلفة المورد…"
          />
        </FormField>
      </FormGrid>
      {err ? <p style={{ color: "var(--office-danger, #dc2626)", marginBottom: 0 }}>{err}</p> : null}
    </Modal>
  );
}
