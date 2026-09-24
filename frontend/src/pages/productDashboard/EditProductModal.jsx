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
import WeighedProductFields from "../../components/products/WeighedProductFields";
import {
  sellingPriceError,
  sellingPriceLabel,
  validateScaleSaleFields,
  weighedSalePayload,
} from "../../utils/scaleProductForm";
import CameraBarcodeButton from "../../components/barcode/CameraBarcodeButton";
import { normalizeBarcode } from "../../utils/barcode";
import { productSkuInputValue } from "../../utils/entityCodeDisplay";
import "./productBarcodes.css";
import "../../components/barcode/barcode-scanner.css";
import { apiErrorMessage } from "../../utils/apiError";

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
  scale_only: false,
  scale_code: "",
  package_conversion: "",
  package_price: "",
};

function productToForm(product) {
  if (!product) return emptyForm;
  return {
    barcode: product.barcode || "",
    sku: productSkuInputValue(product.sku),
    name: product.name || "",
    price: product.price != null ? String(product.price) : "",
    cost: product.cost != null ? String(product.cost) : "",
    category: product.category || "",
    stock: product.stock != null ? String(product.stock) : "",
    tax_rate: product.tax_rate != null ? String(product.tax_rate) : "",
    unit: product.unit || "",
    expiry_date: product.expiry_date || "",
    is_weighed: Number(product.is_weighed) === 1 || Number(product.scale_only) === 1,
    scale_only: Number(product.scale_only) === 1,
    scale_code: product.scale_code || "",
    package_conversion: product.package_conversion != null ? String(product.package_conversion) : "",
    package_price: product.package_price != null ? String(product.package_price) : "",
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
  const name = form.name.trim();
  const sku = form.sku.trim() || null;
  const price = Number(form.price);
  const cost = form.cost === "" ? 0 : Number(form.cost);
  const category = form.category.trim() || null;
  const tax_rate = form.tax_rate !== "" ? Number(form.tax_rate) : null;
  const sale = weighedSalePayload(form);
  const unit = sale.unit;
  const expiry_date = form.expiry_date?.trim() || null;
  const is_weighed = sale.is_weighed;
  const scale_only = sale.scale_only;

  if (!sameText(sale.barcode, product.barcode || null)) payload.barcode = sale.barcode;
  if (!sameText(sku, productSkuInputValue(product.sku) || null)) payload.sku = sku;
  if (!sameText(name, product.name)) payload.name = name;
  if (!sameNumber(price, product.price)) payload.price = price;
  if (!sameNumber(cost, product.cost ?? 0)) payload.cost = cost;
  if (!sameText(category, product.category)) payload.category = category;
  if (!sameNumber(tax_rate, product.tax_rate)) payload.tax_rate = tax_rate;
  if (!sameText(unit, product.unit)) payload.unit = unit;
  if (!sameText(expiry_date, product.expiry_date)) payload.expiry_date = expiry_date;
  if (is_weighed !== (Number(product.is_weighed) === 1 ? 1 : 0)) payload.is_weighed = is_weighed;
  if (scale_only !== (Number(product.scale_only) === 1 ? 1 : 0)) payload.scale_only = scale_only;
  if (form.scale_only || form.is_weighed) {
    const scale = form.scale_code?.trim() || null;
    if (!sameText(scale, product.scale_code || null) || form.scale_only) payload.scale_code = scale;
    if (form.scale_only) {
      if (product.package_conversion != null || product.package_price != null) {
        payload.package_conversion = null;
        payload.package_price = null;
      }
    } else {
      const convEmpty = form.package_conversion === "" || form.package_conversion == null;
      const priceEmpty = form.package_price === "" || form.package_price == null;
      const hadPackage = product.package_conversion != null || product.package_price != null;
      if (convEmpty && priceEmpty) {
        if (hadPackage) {
          payload.package_conversion = null;
          payload.package_price = null;
        }
      } else if (!convEmpty && !priceEmpty) {
        const conv = Number(form.package_conversion);
        const pkgPrice = Number(form.package_price);
        if (!sameNumber(conv, product.package_conversion) || !sameNumber(pkgPrice, product.package_price)) {
          payload.package_conversion = conv;
          payload.package_price = pkgPrice;
        }
      }
    }
  }
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
    if (!form.scale_only && !form.barcode.trim()) {
      setErr("الباركود مطلوب");
      return;
    }
    if (!name) {
      setErr("الاسم مطلوب");
      return;
    }
    if (form.price === "" || !Number.isFinite(Number(form.price)) || Number(form.price) < 0) {
      setErr(sellingPriceError(form));
      return;
    }
    const scaleErr = validateScaleSaleFields(form);
    if (scaleErr) {
      setErr(scaleErr);
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
      setErr(apiErrorMessage(e, "تعذّر حفظ التعديلات"));
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
        <FormField
          label="الباركود"
          required={!form.scale_only}
          hint={form.scale_only ? "اختياري لمنتج الميزان فقط" : "باركود المنتج المخزّن — ليس رقم المنتج"}
        >
          <div className="barcode-input-row">
            <Input
              value={form.barcode}
              onChange={(e) => setForm({ ...form, barcode: e.target.value })}
              placeholder="امسح أو أدخل الباركود"
              required={!form.scale_only}
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
            inputMode="numeric"
            autoComplete="off"
            maxLength={11}
            onChange={(e) => {
              const raw = e.target.value.replace(/\D/g, "").slice(0, 11);
              setForm({ ...form, sku: raw });
            }}
          />
        </FormField>
        <FormField label="الاسم" required>
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            autoFocus
          />
        </FormField>
        <WeighedProductFields form={form} onChange={setForm} />
        <FormField
          label={sellingPriceLabel(form)}
          hint={
            form.scale_only
              ? "سعر الكيلو — يُضرب في الوزن. تقريب الفاتورة يبقى منفصلاً"
              : form.is_weighed
                ? "سعر الميزان لكل كغم — مستقل عن سعر الحبة"
                : undefined
          }
          required
        >
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
            value={form.is_weighed || form.scale_only ? "كغم" : form.unit}
            disabled={form.is_weighed || form.scale_only}
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
