/** Base unit name for weighed / deli products. */
export const WEIGHED_BASE_UNIT_NAME = "كغم";

export function isKgSoldUnit(unitOrLine) {
  if (!unitOrLine) return false;
  const name = unitOrLine.unit_name ?? unitOrLine.unitName;
  return String(name || "") === WEIGHED_BASE_UNIT_NAME;
}

/**
 * Apply a selling unit to a cart line: that unit's price, conversion, and
 * customer quantity. Conversion is inventory only — never used to derive price.
 */
export function applyCartUnit(row, unit) {
  const toKg = isKgSoldUnit(unit);
  const fromKg = isKgSoldUnit(row) || Boolean(row.weighed);
  const oldQty = Number(row.quantity) || 0;
  const oldConversion = Math.max(0.0001, Number(row.conversionToBase ?? row.conversion_to_base) || 1);
  const price = Number(unit.price);
  const conversionToBase = Number(unit.conversion_to_base) || 1;

  let quantity;
  if (toKg) {
    quantity = fromKg ? oldQty : oldQty * oldConversion;
  } else if (fromKg) {
    quantity = 1;
  } else {
    quantity = Math.max(1, Math.round(oldQty));
  }

  return {
    ...row,
    unitId: unit.id,
    unitName: unit.unit_name,
    barcode: unit.barcode,
    price,
    conversionToBase,
    weighed: toKg,
    quantity,
    subtotal: Math.round(Number(quantity) * Number(price) * 100) / 100,
  };
}

/** Normalize barcode lookup API payload into cart-add shape. */
export function mapLookupToCartProduct(data) {
  if (!data || typeof data !== "object") return data;
  if (data.cartKey && data.unitId != null && Array.isArray(data.availableUnits)) {
    return data;
  }

  const product = data.product ?? data;
  const unitId = data.selectedUnit?.id ?? data.unitId ?? data.unit_id;
  const unitName =
    data.selectedUnit?.unit_name ??
    data.unitName ??
    data.unit_name ??
    product.unit ??
    null;
  const selectedUnit = data.selectedUnit ?? {
    id: unitId,
    unit_name: unitName,
    barcode: data.barcode ?? product.barcode,
    price: data.price ?? product.price,
    conversion_to_base: data.conversionToBase ?? data.conversion_to_base ?? 1,
  };
  const availableUnits = data.availableUnits ?? (selectedUnit?.id ? [selectedUnit] : []);
  const productId = product.id ?? data.id;
  const fromScale = Boolean(data.weighed) && Number(data.weight ?? data.quantity) > 0;
  const weight = fromScale ? Number(data.weight ?? data.quantity) : null;
  const needsWeight =
    !fromScale &&
    (data.needs_weight === true ||
      data.needsWeight === true ||
      isKgSoldUnit(selectedUnit) ||
      isKgSoldUnit(product));
  const scanned = data.scanned_barcode ?? null;
  const resolvedUnitName =
    selectedUnit?.unit_name ?? unitName ?? (fromScale ? WEIGHED_BASE_UNIT_NAME : "حبة");
  const resolvedUnitId = selectedUnit?.id ?? unitId;
  const cartKey = fromScale
    ? `${productId}-${resolvedUnitId ?? "0"}-w-${scanned ?? weight ?? Date.now()}`
    : `${productId}-${resolvedUnitId ?? "0"}`;
  return {
    cartKey,
    id: productId,
    unitId: resolvedUnitId,
    unitName: resolvedUnitName,
    barcode: selectedUnit?.barcode ?? product.barcode,
    scanned_barcode: scanned,
    name: product.name ?? data.name,
    price: Number(selectedUnit?.price ?? data.price ?? product.price),
    conversionToBase: Number(selectedUnit?.conversion_to_base ?? data.conversionToBase ?? 1) || 1,
    availableUnits,
    stock: Number(product.stock ?? data.stock),
    tax_rate: product.tax_rate ?? data.tax_rate ?? null,
    weighed: fromScale,
    needsWeight,
    weight,
    awaitingWeight: needsWeight,
    quantity: fromScale && Number.isFinite(weight) && weight > 0 ? weight : undefined,
    selectedUnit,
  };
}

export function cartKeyFor(item) {
  return item.cartKey ?? `${item.id}-${item.unitId ?? "0"}`;
}
