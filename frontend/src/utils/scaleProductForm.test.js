import fs from "fs";
import path from "path";
import { isValidScaleProductCode, normalizeScaleProductCode } from "./scaleCode";
import {
  patchScaleOnly,
  sellingPriceLabel,
  validateScaleSaleFields,
  weighedSalePayload,
} from "./scaleProductForm";

describe("scale product form rules", () => {
  const base = {
    barcode: "",
    scale_code: "",
    is_weighed: false,
    scale_only: false,
    unit: "حبة",
    package_conversion: "",
    package_price: "",
  };

  test("scale-only requires a decoder-sized PLU and drops piece sale", () => {
    const on = patchScaleOnly(base, true);
    expect(on.scale_only).toBe(true);
    expect(on.is_weighed).toBe(true);
    expect(on.unit).toBe("كغم");
    expect(on.package_conversion).toBe("");
    expect(sellingPriceLabel(on)).toBe("سعر الكيلو");
    expect(validateScaleSaleFields(on)).toBe("كود الميزان مطلوب");
    expect(validateScaleSaleFields({ ...on, scale_code: "0210003" })).toBe("كود الميزان غير صالح");
    expect(validateScaleSaleFields({ ...on, scale_code: "2200001" })).toBe("كود الميزان غير صالح");
    expect(validateScaleSaleFields({ ...on, scale_code: "2100100" })).toBeNull();
    expect(
      validateScaleSaleFields({ ...on, scale_code: "2100100", package_price: "4" })
    ).toBe("البيع بالحبة غير متاح لمنتج يباع بالميزان فقط");
  });

  test("payload keeps the PLU text and does not invent a barcode", () => {
    const form = patchScaleOnly({ ...base, scale_code: "2100100", barcode: "" }, true);
    expect(normalizeScaleProductCode(form.scale_code)).toBe("2100100");
    expect(isValidScaleProductCode("2100100")).toBe(true);
    expect(isValidScaleProductCode("0210003")).toBe(false);
    const payload = weighedSalePayload(form);
    expect(payload.barcode).toBeNull();
    expect(payload.scale_code).toBe("2100100");
    expect(payload.scale_only).toBe(1);
    expect(payload.unit).toBe("كغم");
    expect(payload.package_conversion).toBeNull();
    expect(payload.package_price).toBeNull();
  });

  test("dual-mode and regular products keep their previous payload", () => {
    const regular = weighedSalePayload({ ...base, barcode: "6281000000011" });
    expect(regular.scale_only).toBe(0);
    expect(regular.is_weighed).toBe(0);
    expect(regular.barcode).toBe("6281000000011");
    expect(regular.scale_code).toBeUndefined();

    const weighed = weighedSalePayload({
      ...base,
      barcode: "6281000000012",
      is_weighed: true,
      scale_code: "",
      unit: "كغم",
    });
    expect(weighed.scale_only).toBe(0);
    expect(weighed.scale_code).toBeUndefined();
    expect(sellingPriceLabel(weighed)).toBe("سعر الكغم (ميزان)");
  });

  test("create, edit, and bakery forms share the same rules", () => {
    const files = [
      "../pages/ProductManagement.jsx",
      "../pages/BakerySupplies.jsx",
      "../pages/productDashboard/EditProductModal.jsx",
    ];
    for (const file of files) {
      const src = fs.readFileSync(path.join(__dirname, file), "utf8");
      expect(src).toContain("WeighedProductFields");
      expect(src).toContain("validateScaleSaleFields");
      expect(src).toContain("weighedSalePayload");
      expect(src).toContain("sellingPriceLabel");
    }
  });
});
