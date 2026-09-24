import { resolveSearchPickCode } from "./PosProductSearch";

describe("POS search pick codes", () => {
  const scaleOnly = {
    name: "بندورة",
    barcode: null,
    scale_code: "2100100",
    scale_only: 1,
    unit_name: "كغم",
  };
  const dual = {
    name: "مرتديلا",
    barcode: "6281000000077",
    scale_code: "2100410",
    unit_name: "حبة",
  };

  test("name or bare PLU of a scale-only product is the PLU, not a piece", () => {
    expect(resolveSearchPickCode(scaleOnly, "بندورة")).toBe("2100100");
    expect(resolveSearchPickCode(scaleOnly, "2100100")).toBe("2100100");
  });

  test("a typed scale label is looked up whole, ahead of the regular barcode", () => {
    expect(resolveSearchPickCode(dual, "2100410015504")).toBe("2100410015504");
    expect(resolveSearchPickCode(dual, "مرتديلا")).toBe("6281000000077");
  });

  test("a regular barcode is not replaced by a different PLU", () => {
    expect(resolveSearchPickCode(dual, "6281000000077")).toBe("6281000000077");
    expect(resolveSearchPickCode({ barcode: "9990001", scale_code: null }, "حليب")).toBe("9990001");
  });
});
