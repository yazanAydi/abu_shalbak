import { heldCartMatches, heldQuoteFromDetail, resolveHeldDisplay } from "./heldQuote";

const heldItems = [
  { product_id: 8, product_unit_id: 80, quantity: 1 },
  { product_id: 9, product_unit_id: 90, quantity: 2 },
];

const cart = [
  { id: 8, unitId: 80, quantity: 1 },
  { id: 9, unitId: 90, quantity: 2 },
];

describe("held quote display", () => {
  test("an unchanged verified hold shows the saved payable", () => {
    expect(heldCartMatches(cart, heldItems)).toBe(true);
    const quote = heldQuoteFromDetail({
      items: heldItems,
      quote_verified: true,
      discount: 10,
      saved_discount: 10,
      saved_payable: 210,
      saved_rounding_adjustment: -0.46,
      current_discount: 10,
      current_payable: 210,
      current_rounding_adjustment: -0.46,
    });
    expect(resolveHeldDisplay(quote)).toMatchObject({
      discount: 10,
      total: 210,
      needsConfirmation: false,
    });
  });

  test("a verified hold keeps its saved price when today's offer would charge a different discount", () => {
    const quote = heldQuoteFromDetail({
      items: heldItems,
      quote_verified: 1,
      saved_discount: 10,
      saved_payable: 210,
      saved_rounding_adjustment: -0.46,
      current_discount: 50,
      current_payable: 170,
      current_rounding_adjustment: -0.46,
    });
    expect(resolveHeldDisplay(quote)).toMatchObject({
      discount: 10,
      total: 210,
      needsConfirmation: false,
    });
  });

  test("a pre-fix hold shows the current offer and waits for confirmation", () => {
    const quote = heldQuoteFromDetail({
      items: heldItems,
      quote_verified: 0,
      discount: 50,
      saved_discount: 50,
      saved_payable: 170,
      current_discount: 10,
      current_payable: 210,
      current_rounding_adjustment: -0.46,
    });
    expect(resolveHeldDisplay(quote)).toEqual({
      discount: 10,
      total: 210,
      roundingAdjustment: -0.46,
      needsConfirmation: true,
      savedDiscount: 50,
      savedPayable: 170,
    });
  });

  test("a quantity change leaves the held quote and uses the live estimate", () => {
    const changed = cart.map((row) => (row.id === 9 ? { ...row, quantity: 1 } : row));
    expect(heldCartMatches(changed, heldItems)).toBe(false);
  });

  test("no offer on a verified hold shows a zero discount and payable 220", () => {
    const quote = heldQuoteFromDetail({
      items: heldItems,
      quote_verified: true,
      saved_discount: 0,
      saved_payable: 220,
      saved_rounding_adjustment: -0.46,
    });
    expect(resolveHeldDisplay(quote)).toMatchObject({
      discount: 0,
      total: 220,
      needsConfirmation: false,
    });
  });
});
