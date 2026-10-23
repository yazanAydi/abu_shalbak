import { mapLookupToCartProduct } from "./cartProduct";
import { appliedPromoName, computeDealLineTotal, estimateCartTotals } from "./posTotals";

const cartonPromo = {
  id: 5,
  name: "صندوقين بـ 80",
  offer_type: "multi_price",
  product_id: 1,
  product_unit_id: 11,
  discount_value: 80,
  buy_qty: 2,
};

function line(quantity, unitId, price) {
  return {
    id: 1,
    unitId,
    unitName: unitId === 11 ? "صندوق" : "حبة",
    category: "ألبان",
    name: "حليب",
    quantity,
    price,
    subtotal: Math.round(quantity * price * 100) / 100,
    conversionToBase: unitId === 11 ? 12 : 1,
  };
}

describe("POS deal pricing", () => {
  test("barcode lookup keeps the selling unit and the product category", () => {
    const mapped = mapLookupToCartProduct({
      product: { id: 1, name: "حليب", category: "ألبان", price: 10 },
      selectedUnit: { id: 11, unit_name: "صندوق", barcode: "8800102", price: 50, conversion_to_base: 12 },
      availableUnits: [
        { id: 10, unit_name: "حبة", price: 10, conversion_to_base: 1 },
        { id: 11, unit_name: "صندوق", price: 50, conversion_to_base: 12 },
      ],
    });
    expect(mapped.category).toBe("ألبان");
    expect(mapped.unitId).toBe(11);
    expect(mapped.conversionToBase).toBe(12);
  });

  test("carton deal price is full below the quantity, the deal at it, and the remainder above it", () => {
    const settings = { tax_inclusive: true, default_tax_rate: 0 };
    const below = line(1, 11, 50);
    expect(computeDealLineTotal(below, [cartonPromo])).toBe(50);
    expect(appliedPromoName(below, [cartonPromo])).toBe("");

    const at = line(2, 11, 50);
    expect(computeDealLineTotal(at, [cartonPromo])).toBe(80);
    expect(appliedPromoName(at, [cartonPromo])).toBe("صندوقين بـ 80");
    expect(estimateCartTotals([at], settings, [cartonPromo]).discount).toBe(20);
    expect(estimateCartTotals([at], settings, [cartonPromo]).total).toBe(80);

    const above = line(3, 11, 50);
    expect(computeDealLineTotal(above, [cartonPromo])).toBe(130);
    expect(estimateCartTotals([above], settings, [cartonPromo]).discount).toBe(20);
  });

  test("a piece line does not receive the carton deal, even at the carton conversion count", () => {
    const pieces = line(12, 10, 10);
    expect(computeDealLineTotal(pieces, [cartonPromo])).toBe(120);
    expect(appliedPromoName(pieces, [cartonPromo])).toBe("");
  });

  test("a 220.46 basket does not turn the 2 x 25 line into a 50 discount", () => {
    const settings = { tax_inclusive: true, default_tax_rate: 0 };
    const filler = {
      id: 8,
      unitId: 80,
      category: "أخرى",
      quantity: 1,
      price: 170.46,
      subtotal: 170.46,
    };
    const shampoo = {
      id: 9,
      unitId: 90,
      category: "عناية",
      name: "شامبو",
      quantity: 2,
      price: 25,
      subtotal: 50,
    };
    const cart = [filler, shampoo];
    const plain = estimateCartTotals(cart, settings, []);
    expect(plain.subtotal).toBe(220.46);
    expect(plain.discount).toBe(0);
    expect(plain.amountBeforeRounding).toBe(220.46);
    expect(plain.roundingAdjustment).toBe(-0.46);
    expect(plain.total).toBe(220);

    const unitDeal = {
      id: 1,
      name: "2 بـ 40",
      offer_type: "multi_price",
      product_id: 9,
      product_unit_id: 90,
      discount_value: 40,
      buy_qty: 2,
    };
    const categoryFixed = {
      id: 2,
      name: "خصم العناية",
      offer_type: "fixed",
      category: "عناية",
      discount_value: 25,
    };
    const shown = estimateCartTotals(cart, settings, [categoryFixed, unitDeal]);
    expect(shown.discount).toBe(10);
    expect(shown.amountBeforeRounding).toBe(210.46);
    expect(shown.roundingAdjustment).toBe(-0.46);
    expect(shown.total).toBe(210);
    expect(computeDealLineTotal(shampoo, [categoryFixed, unitDeal])).toBe(40);
    const displayedLines =
      computeDealLineTotal(filler, [categoryFixed, unitDeal]) +
      computeDealLineTotal(shampoo, [categoryFixed, unitDeal]);
    expect(Math.round(displayedLines * 100) / 100).toBe(210.46);
    expect(shown.total).toBe(210);
  });

  test("a category deal uses the sold unit quantity", () => {
    const categoryPromo = {
      id: 9,
      name: "عرض ألبان",
      offer_type: "multi_price",
      category: "ألبان",
      product_unit_id: null,
      discount_value: 15,
      buy_qty: 2,
    };
    expect(computeDealLineTotal(line(1, 11, 50), [categoryPromo])).toBe(50);
    expect(computeDealLineTotal(line(2, 10, 10), [categoryPromo])).toBe(15);
    expect(appliedPromoName(line(2, 10, 10), [categoryPromo])).toBe("عرض ألبان");
  });
});
