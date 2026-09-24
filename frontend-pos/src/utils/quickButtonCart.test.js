import { checkoutInitialState, checkoutReducer } from "./checkoutCartReducer";

function buttonPayload(index) {
  return {
    id: 1000 + index,
    name: `سريع ${index + 1}`,
    barcode: `77${String(index).padStart(6, "0")}`,
    price: index + 1,
    stock: 10,
    unit_id: 5000 + index,
    unit_name: "حبة",
    conversion_to_base: 1,
    selectedUnit: {
      id: 5000 + index,
      unit_name: "حبة",
      barcode: `77${String(index).padStart(6, "0")}`,
      price: index + 1,
      conversion_to_base: 1,
    },
    availableUnits: [
      {
        id: 5000 + index,
        unit_name: "حبة",
        barcode: `77${String(index).padStart(6, "0")}`,
        price: index + 1,
        conversion_to_base: 1,
      },
    ],
  };
}

test("a quick button past position 48 adds that product and unit once", () => {
  const past = buttonPayload(48);
  const next = checkoutReducer(checkoutInitialState, { type: "ADD_PRODUCT", product: past });
  expect(next.cartItems).toHaveLength(1);
  expect(next.cartItems[0].id).toBe(past.id);
  expect(next.cartItems[0].unitId).toBe(past.unit_id);
  expect(next.cartItems[0].name).toBe("سريع 49");
  expect(next.cartItems[0].quantity).toBe(1);
});
