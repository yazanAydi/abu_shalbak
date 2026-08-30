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
import ProductUnitsSection from "./ProductUnitsSection";
import CategorySelect from "../../components/CategorySelect";
import UnitNameSelect from "../../components/UnitNameSelect";
import CameraBarcodeButton from "../../components/barcode/CameraBarcodeButton";
import { normalizeBarcode } from "../../utils/barcode";
import { displayProductSku } from "../../utils/entityCodeDisplay";
import "./productBarcodes.css";
import "../../components/barcode/barcode-scanner.css";

const emptyForm = {
  barcode: "",
  sku: "",
  name: "",
  price: "",
  cost: "",
  category: "",
  stock: "",
  tax_rate: "",
  unit: "",
  expiry_date: "",
  is_weighed: false,
};

function productToForm(product) {
  if (!product) return emptyForm;
  return {
    barcode: product.barcode || "",
    sku: product.sku ? displayProductSku(product.sku) : "",
    name: product.name || "",
    price: product.price != null ? String(product.price) : "",
    cost: product.cost != null ? String(product.cost) : "",
    category: product.category || "",
    stock: product.stock != null ? String(product.stock) : "",
    tax_rate: product.tax_rate != null ? String(product.tax_rate) : "",
    unit: product.unit || "",
    expiry_date: product.expiry_date || "",
    is_weighed: Number(product.is_weighed) === 1,
  };
}

function sameText(a, b) {
  return String(a ?? "").trim() === String(b ?? "").trim();
}

function sameNumber(a, b) {
  const na = a === "" || a == null ? null : Number(a);
  const nb = b === "" || b == null ? null : Number(b);
  if (na == null && nb == null) return true;
  if (na == null || nb == null) return false;
  return Number(na) === Number(nb);
}

function dirtyProductPayload(form, product) {
  const payload = {};
  const barcode = form.barcode.trim();
  const name = form.name.trim();
  const sku = form.sku.trim() || null;
  const price = Number(form.price);
  const cost = form.cost === "" ? 0 : Number(form.cost);
  const category = form.category.trim() || null;
  const tax_rate = form.tax_rate !== "" ? Number(form.tax_rate) : null;
  const unit = form.is_weighed ? "كغم" : form.unit?.trim() || null;
  const expiry_date = form.expiry_date?.trim() || null;
  const is_weighed = form.is_weighed ? 1 : 0;

  if (!sameText(barcode, product.barcode)) payload.barcode = barcode;
  if (!sameText(sku, product.sku ? displayProductSku(product.sku) : null)) payload.sku = sku;
  if (!sameText(name, product.name)) payload.name = name;
  if (!sameNumber(price, product.price)) payload.price = price;
  if (!sameNumber(cost, product.cost ?? 0)) payload.cost = cost;
  if (!sameText(category, product.category)) payload.category = category;
  if (!sameNumber(tax_rate, product.tax_rate)) payload.tax_rate = tax_rate;
  if (!sameText(unit, product.unit)) payload.unit = unit;
  if (!sameText(expiry_date, product.expiry_date)) payload.expiry_date = expiry_date;
  if (is_weighed !== (Number(product.is_weighed) === 1 ? 1 : 0)) payload.is_weighed = is_weighed;
  return payload;
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
    if (!form.barcode.trim()) {
      setErr("الباركود مطلوب");
      return;
    }
    if (!name) {
      setErr("الاسم مطلوب");
      return;
    }
    if (form.price === "" || !Number.isFinite(Number(form.price)) || Number(form.price) < 0) {
      setErr("أدخل سعر بيع صالحاً");
      return;
    }

    const payload = dirtyProductPayload(form, product);
    if (Object.keys(payload).length === 0) {
      close();
      return;
    }

    setSaving(true);
    try {
      const { data } = await api.put(`/api/products/${product.id}`, payload);
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
        <FormField label="الباركود" required hint="باركود المنتج المخزّن — ليس رقم المنتج">
          <div className="barcode-input-row">
            <Input
              value={form.barcode}
              onChange={(e) => setForm({ ...form, barcode: e.target.value })}
              placeholder="امسح أو أدخل الباركود"
            />
            <CameraBarcodeButton
              onScan={(code) =>
                setForm((f) => ({ ...f, barcode: normalizeBarcode(code) }))
              }
            />
          </div>
        </FormField>
        <FormField label="الرقم" hint="رقم المنتج — مستقل عن الباركود">
          <Input
            value={form.sku}
            onChange={(e) => setForm({ ...form, sku: e.target.value })}
          />
        </FormField>
        <FormField label="الاسم" required>
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            autoFocus
          />
        </FormField>
        <FormField label="يُباع بالوزن (ميزان)">
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <input
              type="checkbox"
              checked={Boolean(form.is_weighed)}
              onChange={(e) =>
                setForm({
                  ...form,
                  is_weighed: e.target.checked,
                  unit: e.target.checked ? "كغم" : form.unit,
                })
              }
            />
            <span>منتج ميزان — السعر لكل كغم</span>
          </label>
        </FormField>
        <FormField label={form.is_weighed ? "السعر لكل كغم" : "سعر البيع"} required>
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
          <CategorySelect
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          />
        </FormField>
        <FormField
          label="المخزون"
          hint="يُحدَّث من المبيعات والتسويات فقط — لا يُحفظ من هذه الشاشة"
        >
          <Input type="number" value={form.stock} readOnly disabled />
        </FormField>
        <FormField label="الوحدة">
          <UnitNameSelect
            value={form.is_weighed ? "كغم" : form.unit}
            disabled={form.is_weighed}
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
      <ProductUnitsSection productId={product?.id ?? null} />
      {err ? (
        <p style={{ color: "var(--office-danger, #dc2626)", marginBottom: 0, marginTop: "0.75rem" }}>
          {err}
        </p>
      ) : null}
    </Modal>
  );
}
