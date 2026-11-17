import { FormField, Input } from "../ui";
import { displayProductSku } from "../../utils/entityCodeDisplay";

export const PENDING_PRODUCT_NUMBER = "يُنشأ تلقائيًا عند الحفظ";

/** Saved رقم المنتج, or empty when the server has not assigned one yet. */
export function savedProductNumber(sku) {
  const shown = displayProductSku(sku);
  return shown === "—" ? "" : shown;
}

/**
 * Read-only products.sku. Empty until save; never a predicted next number.
 */
export default function ProductNumberField({ sku }) {
  const value = savedProductNumber(sku);
  return (
    <FormField label="رقم الصنف">
      <Input
        value={value}
        placeholder={value ? undefined : PENDING_PRODUCT_NUMBER}
        readOnly
        autoComplete="off"
        aria-readonly="true"
      />
    </FormField>
  );
}
