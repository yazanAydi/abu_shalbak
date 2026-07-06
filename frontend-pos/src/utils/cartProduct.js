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
  const weighed = Boolean(data.weighed ?? product.is_weighed);
  const weight = weighed ? Number(data.weight ?? data.quantity) : null;
  const scanned = data.scanned_barcode ?? null;
  const cartKey = weighed
    ? `${productId}-${unitId ?? "0"}-w-${scanned ?? weight ?? Date.now()}`
    : `${productId}-${unitId ?? "0"}`;
  return {
    cartKey,
    id: productId,
    unitId,
    unitName: selectedUnit?.unit_name ?? (weighed ? "كغم" : "حبة"),
    barcode: selectedUnit?.barcode ?? product.barcode,
    scanned_barcode: scanned,
    name: product.name ?? data.name,
    price: Number(selectedUnit?.price ?? data.price ?? product.price),
    conversionToBase: Number(selectedUnit?.conversion_to_base ?? 1) || 1,
    availableUnits,
    stock: Number(product.stock ?? data.stock),
    tax_rate: product.tax_rate ?? data.tax_rate ?? null,
    weighed,
    weight,
    quantity: weighed && Number.isFinite(weight) && weight > 0 ? weight : undefined,
  };
}

export function cartKeyFor(item) {
  return item.cartKey ?? `${item.id}-${item.unitId ?? "0"}`;
}
