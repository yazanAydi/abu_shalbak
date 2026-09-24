import { FormField, Input } from "../ui";
import { normalizeBarcode } from "../../utils/barcode";
import { scaleProductCodeLength } from "../../utils/scaleCode";
import { patchScaleOnly, patchWeighed } from "../../utils/scaleProductForm";

function scaleDigits(raw) {
  return normalizeBarcode(raw).replace(/\D/g, "").slice(0, scaleProductCodeLength());
}

/**
 * Shared weighed / scale-only fields for product create and edit,
 * including bakery products that use the same form.
 */
export default function WeighedProductFields({ form, onChange }) {
  const scaleOnly = Boolean(form.scale_only);
  const weighed = scaleOnly || Boolean(form.is_weighed);

  return (
    <>
      <FormField label="يباع بالميزان فقط">
        <label className="ui-checkbox-label">
          <input
            type="checkbox"
            checked={scaleOnly}
            onChange={(e) => onChange(patchScaleOnly(form, e.target.checked))}
          />
          <span>بدون باركود عادي — البيع من ملصق الميزان أو بإدخال الوزن</span>
        </label>
      </FormField>
      <FormField label="يُباع بالوزن (ميزان)">
        <label className="ui-checkbox-label">
          <input
            type="checkbox"
            checked={weighed}
            disabled={scaleOnly}
            onChange={(e) => onChange(patchWeighed(form, e.target.checked))}
          />
          <span>
            {scaleOnly
              ? "الوحدة كغم وسعر الكيلو. بيع الحبة متوقف"
              : "يُباع بالوزن من الميزان (كغم). اترك وزن الحبة وسعر الحبة فارغين للبيع بالوزن فقط"}
          </span>
        </label>
      </FormField>
      {weighed ? (
        <FormField
          label={scaleOnly ? "كود الميزان / PLU" : "رمز الميزان"}
          required={scaleOnly}
          hint={
            scaleOnly
              ? "مطلوب. يُحفظ كما هو مع الأصفار، ومستقل عن الباركود"
              : "مثل 2100003 — مستقل عن الباركود ورقم المنتج"
          }
        >
          <Input
            value={form.scale_code}
            inputMode="numeric"
            autoComplete="off"
            required={scaleOnly}
            maxLength={scaleProductCodeLength()}
            onChange={(e) => onChange({ ...form, scale_code: scaleDigits(e.target.value) })}
            placeholder="2100003"
          />
        </FormField>
      ) : null}
      {weighed && !scaleOnly ? (
        <FormField
          label="وزن الحبة (كغم)"
          hint="اختياري مع سعر الحبة — اتركهما فارغين إذا كان المنتج يُباع من الميزان فقط. يحدد خصم المخزون وليس السعر"
        >
          <Input
            type="number"
            step="0.001"
            min="0.001"
            value={form.package_conversion}
            onChange={(e) => onChange({ ...form, package_conversion: e.target.value })}
            placeholder="1.000"
          />
        </FormField>
      ) : null}
      {weighed && !scaleOnly ? (
        <FormField label="سعر الحبة" hint="املأه مع وزن الحبة لإضافة بيع الحبة — مستقل عن سعر الكغم">
          <Input
            type="number"
            step="0.01"
            min="0"
            value={form.package_price}
            onChange={(e) => onChange({ ...form, package_price: e.target.value })}
            placeholder="0.00"
          />
        </FormField>
      ) : null}
    </>
  );
}
