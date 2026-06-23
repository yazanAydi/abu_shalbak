import { useEffect, useState } from "react";
import api from "../../apiClient";
import { getAuthHeaders } from "../../utils/auth";
import { normalizeBarcode } from "../../utils/barcode";
import CameraBarcodeButton from "../../components/barcode/CameraBarcodeButton";
import {
  Modal,
  FormField,
  Input,
  PrimaryButton,
  SecondaryButton,
  useToast,
} from "../../components/ui";

export default function EditBarcodeModal({ open, onClose, product, onSaved }) {
  const toast = useToast();
  const [barcode, setBarcode] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (open && product) {
      setBarcode("");
      setErr(null);
    }
  }, [open, product]);

  function close() {
    setBarcode("");
    setErr(null);
    onClose?.();
  }

  async function submit() {
    if (!product?.id) return;
    setErr(null);

    const next = normalizeBarcode(barcode);
    if (!next) {
      setErr("أدخل باركوداً صالحاً");
      return;
    }
    if (next === normalizeBarcode(product.barcode)) {
      setErr("أدخل باركوداً مختلفاً عن الحالي");
      return;
    }

    setSaving(true);
    try {
      const { data } = await api.put(
        `/api/products/${product.id}`,
        { barcode: next },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      toast.success("تم تغيير الباركود");
      onSaved?.(data);
      close();
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "تعذّر تغيير الباركود");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="تعديل باركود المنتج القديم"
      footer={
        <>
          <PrimaryButton type="button" onClick={submit} disabled={saving}>
            {saving ? "جاري الحفظ…" : "حفظ الباركود الجديد"}
          </PrimaryButton>
          <SecondaryButton type="button" onClick={close} disabled={saving}>
            إلغاء
          </SecondaryButton>
        </>
      }
    >
      <p style={{ marginTop: 0, color: "var(--office-text-muted)", fontSize: "0.9rem" }}>
        المنتج: <strong>{product?.name}</strong>
        <br />
        الباركود الحالي: <strong>{product?.barcode}</strong>
      </p>
      <FormField label="الباركود الجديد" required>
        <div className="barcode-input-row">
          <Input
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            autoFocus
            placeholder="أدخل باركوداً جديداً"
          />
          <CameraBarcodeButton
            onScan={(code) => setBarcode(normalizeBarcode(code))}
          />
        </div>
      </FormField>
      {err ? (
        <p style={{ color: "var(--office-danger)", marginBottom: 0, marginTop: "0.75rem" }}>
          {err}
        </p>
      ) : null}
    </Modal>
  );
}
