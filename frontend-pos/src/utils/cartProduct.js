/** Normalize barcode lookup API payload into cart-add shape. */
export function mapLookupToCartProduct(data) {
  const product = data.product ?? data;
  const selectedUnit = data.selectedUnit ?? {
    id: data.unit_id,
    unit_name: data.unit_name ?? product.unit ?? "حبة",
    barcode: data.barcode ?? product.barcode,
    price: data.price ?? product.price,
    conversion_to_base: data.conversion_to_base ?? 1,
  };
  const availableUnits = data.availableUnits ?? (selectedUnit?.id ? [selectedUnit] : []);
  const unitId = selectedUnit?.id ?? data.unit_id;
  const productId = product.id ?? data.id;
  return {
    cartKey: `${productId}-${unitId ?? "0"}`,
    id: productId,
    unitId,
    unitName: selectedUnit?.unit_name ?? "حبة",
    barcode: selectedUnit?.barcode ?? product.barcode,
    scanned_barcode: data.scanned_barcode ?? null,
    name: product.name ?? data.name,
    price: Number(selectedUnit?.price ?? data.price ?? product.price),
    conversionToBase: Number(selectedUnit?.conversion_to_base ?? 1) || 1,
    availableUnits,
    stock: Number(product.stock ?? data.stock),
    tax_rate: product.tax_rate ?? data.tax_rate ?? null,
  };
}

export function cartKeyFor(item) {
  return item.cartKey ?? `${item.id}-${item.unitId ?? "0"}`;
}
