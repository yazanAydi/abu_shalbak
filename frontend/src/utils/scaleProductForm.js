import { isValidScaleProductCode, scaleProductCodeLength } from "./scaleCode";

export { scaleProductCodeLength };

export function validateScaleSaleFields(form) {
  if (form?.scale_only) {
    const code = String(form.scale_code || "").trim();
    if (!code) return "كود الميزان مطلوب";
    if (!isValidScaleProductCode(code)) return "كود الميزان غير صالح";
    const conv = String(form.package_conversion ?? "").trim();
    const pkg = String(form.package_price ?? "").trim();
    if (conv || pkg) return "البيع بالحبة غير متاح لمنتج يباع بالميزان فقط";
    if (String(form.barcode || "").trim() && String(form.barcode).trim() === code) {
      return "كود الميزان يجب أن يختلف عن الباركود";
    }
    return null;
  }
  if (!form?.is_weighed) return null;
  const convEmpty = form.package_conversion === "" || form.package_conversion == null;
  const priceEmpty = form.package_price === "" || form.package_price == null;
  if (convEmpty && priceEmpty) return null;
  if (convEmpty || priceEmpty) {
    return "أدخل وزن الحبة وسعر الحبة معاً، أو اتركهما فارغين للبيع بالوزن فقط";
  }
  if (!Number.isFinite(Number(form.package_conversion)) || Number(form.package_conversion) <= 0) {
    return "وزن الحبة غير صالح";
  }
  if (!Number.isFinite(Number(form.package_price)) || Number(form.package_price) <= 0) {
    return "سعر الحبة غير صالح";
  }
  return null;
}

export function sellingPriceLabel(form) {
  if (form?.scale_only) return "سعر الكيلو";
  if (form?.is_weighed || Number(form?.is_weighed) === 1) return "سعر الكغم (ميزان)";
  return "سعر البيع";
}

export function sellingPriceError(form) {
  if (form?.scale_only) return "أدخل سعر الكيلو";
  if (form?.is_weighed || Number(form?.is_weighed) === 1) return "أدخل سعر الكغم";
  return "أدخل سعر بيع صالحاً";
}

export function productPriceLabel(product) {
  if (Number(product?.scale_only) === 1) return "سعر الكيلو";
  if (Number(product?.is_weighed) === 1) return "سعر الكغم";
  return "سعر البيع";
}

export function patchScaleOnly(form, checked) {
  if (checked) {
    return {
      ...form,
      scale_only: true,
      is_weighed: true,
      unit: "كغم",
      package_conversion: "",
      package_price: "",
    };
  }
  return { ...form, scale_only: false };
}

export function patchWeighed(form, checked) {
  if (form.scale_only) return form;
  return {
    ...form,
    is_weighed: checked,
    unit: checked ? "كغم" : form.unit,
    ...(checked ? {} : { scale_code: "", package_conversion: "", package_price: "" }),
  };
}

export function weighedSalePayload(form) {
  const scaleOnly = Boolean(form.scale_only);
  const weighed = scaleOnly || Boolean(form.is_weighed);
  const barcodeText = String(form.barcode || "").trim();
  const payload = {
    is_weighed: weighed ? 1 : 0,
    scale_only: scaleOnly ? 1 : 0,
    unit: weighed ? "كغم" : form.unit?.trim() || null,
    barcode: scaleOnly ? barcodeText || null : barcodeText,
  };
  if (!weighed) return payload;
  const scale = String(form.scale_code || "").trim();
  if (scaleOnly) {
    payload.scale_code = scale || null;
    payload.package_conversion = null;
    payload.package_price = null;
    return payload;
  }
  if (scale) payload.scale_code = scale;
  const conv = form.package_conversion;
  const pkg = form.package_price;
  if (
    conv !== "" &&
    pkg !== "" &&
    conv != null &&
    pkg != null &&
    Number.isFinite(Number(conv)) &&
    Number.isFinite(Number(pkg))
  ) {
    payload.package_conversion = Number(conv);
    payload.package_price = Number(pkg);
  }
  return payload;
}
