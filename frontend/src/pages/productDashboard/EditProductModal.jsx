import { useEffect, useState } from "react";
import api from "../../apiClient";
import {
  Modal,
  FormField,
  FormGrid,
  Input,
  PrimaryButton,
  SecondaryButton,
  useToast,
} from "../../components/ui";
import ProductBarcodesSection from "./ProductBarcodesSection";
import "./productBarcodes.css";

const emptyForm = {
  name: "",
  price: "",
  cost: "",
  category: "",
  stock: "",
  tax_rate: "",
  unit: "",
  expiry_date: "",
};

function productToForm(product) {
  if (!product) return emptyForm;
  return {
    name: product.name || "",
    price: product.price != null ? String(product.price) : "",
    cost: product.cost != null ? String(product.cost) : "",
    category: product.category || "",
    stock: product.stock != null ? String(product.stock) : "",
    tax_rate: product.tax_rate != null ? String(product.tax_rate) : "",
    unit: product.unit || "",
    expiry_date: product.expiry_date || "",
  };
}

export default function EditProductModal({ open, onClose, product, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (open && product) {
      setForm(productToForm(product));
      setErr(null);
    }
  }, [open, product]);

  function close() {
    setForm(emptyForm);
    setErr(null);
    onClose?.();
  }

  async function submit() {
    if (!product?.id) return;
    setErr(null);

    const name = form.name.trim();
    if (!name) {
      setErr("الاسم مطلوب");
      return;
    }
    if (form.price === "" || !Number.isFinite(Number(form.price)) || Number(form.price) < 0) {
      setErr("أدخل سعر بيع صالحاً");
      return;
    }
    if (form.stock === "" || !Number.isFinite(Number(form.stock))) {
      setErr("أدخل مخزوناً صالحاً");
      return;
    }

    setSaving(true);
    try {
      const { data } = await api.put(`/api/products/${product.id}`, {
        name,
        price: Number(form.price),
        cost: form.cost === "" ? 0 : Number(form.cost),
        category: form.category.trim() || null,
        stock: Number(form.stock),
        tax_rate: form.tax_rate !== "" ? Number(form.tax_rate) : null,
        unit: form.unit?.trim() || null,
        expiry_date: form.expiry_date?.trim() || null,
      });
      toast.success("تم حفظ التعديلات");
      onSaved?.(data);
      close();
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "تعذّر حفظ التعديلات");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="تعديل المنتج"
      size="lg"
      footer={
        <>
          <PrimaryButton type="button" onClick={submit} disabled={saving}>
            {saving ? "جاري الحفظ…" : "حفظ"}
          </PrimaryButton>
          <SecondaryButton type="button" onClick={close} disabled={saving}>
            إلغاء
          </SecondaryButton>
        </>
      }
    >
      <FormGrid>
        <FormField label="الباركود">
          <Input value={product?.barcode || ""} readOnly disabled />
        </FormField>
        <FormField label="الاسم" required>
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            autoFocus
          />
        </FormField>
        <FormField label="سعر البيع" required>
          <Input
            type="number"
            step="0.01"
            min="0"
            value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value })}
          />
        </FormField>
        <FormField label="تكلفة">
          <Input
            type="number"
            step="0.01"
            value={form.cost}
            onChange={(e) => setForm({ ...form, cost: e.target.value })}
          />
        </FormField>
        <FormField label="التصنيف">
          <Input
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          />
        </FormField>
        <FormField label="المخزون" required>
          <Input
            type="number"
            value={form.stock}
            onChange={(e) => setForm({ ...form, stock: e.target.value })}
          />
        </FormField>
        <FormField label="نسبة الضريبة (0–1)">
          <Input
            type="number"
            step="0.01"
            min="0"
            max="1"
            value={form.tax_rate}
            onChange={(e) => setForm({ ...form, tax_rate: e.target.value })}
          />
        </FormField>
        <FormField label="الوحدة">
          <Input
            value={form.unit}
            onChange={(e) => setForm({ ...form, unit: e.target.value })}
          />
        </FormField>
        <FormField label="تاريخ الصلاحية">
          <Input
            type="date"
            value={form.expiry_date}
            onChange={(e) => setForm({ ...form, expiry_date: e.target.value })}
          />
        </FormField>
      </FormGrid>
      <ProductBarcodesSection productId={product?.id ?? null} onChanged={onSaved} />
      {err ? (
        <p style={{ color: "var(--office-danger, #dc2626)", marginBottom: 0, marginTop: "0.75rem" }}>
          {err}
        </p>
      ) : null}
    </Modal>
  );
}
