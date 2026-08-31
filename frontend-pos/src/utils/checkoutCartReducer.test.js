import {
  checkoutReducer,
  checkoutInitialState,
} from "./checkoutCartReducer.js";
import { mapLookupToCartProduct } from "./cartProduct.js";

const pack = {
  id: 11,
  unit_name: "حبة",
  barcode: "6251111111111",
  price: 12,
  conversion_to_base: 1,
};
const kg = {
  id: 22,
  unit_name: "كغم",
  barcode: "2100077",
  price: 6,
  conversion_to_base: 1,
};

function testdliLookup(selectedUnit, extra = {}) {
  return {
    product: { id: 1, name: "testdli", price: 6, stock: 10 },
    selectedUnit,
    availableUnits: [kg, pack],
    price: selectedUnit.price,
    unit_id: selectedUnit.id,
    unit_name: selectedUnit.unit_name,
    conversion_to_base: selectedUnit.conversion_to_base,
    ...extra,
  };
}

function line(state) {
  return state.cartItems[0];
}

describe("POS dual-unit price switching", () => {
  test("mapLookupToCartProduct is idempotent and keeps unit id/name", () => {
    const once = mapLookupToCartProduct(testdliLookup(kg, { weighed: true, weight: 0.255, quantity: 0.255 }));
    expect(once.unitId).toBe(kg.id);
    expect(once.unitName).toBe("كغم");
    expect(once.price).toBe(6);
    const twice = mapLookupToCartProduct(once);
    expect(twice.unitId).toBe(kg.id);
    expect(twice.unitName).toBe("كغم");
    expect(twice.price).toBe(6);
    expect(twice.cartKey).toBe(once.cartKey);
  });

  test("adding as حبة then switching to كغم uses the KG unit price", () => {
    let state = checkoutReducer(checkoutInitialState, {
      type: "ADD_PRODUCT",
      product: testdliLookup(pack),
    });
    expect(line(state).unitName).toBe("حبة");
    expect(line(state).price).toBe(12);
    expect(line(state).quantity).toBe(1);
    expect(line(state).subtotal).toBe(12);

    state = checkoutReducer(state, {
      type: "CHANGE_UNIT",
      cartKey: line(state).cartKey,
      unitId: kg.id,
    });
    expect(line(state).unitName).toBe("كغم");
    expect(line(state).unitId).toBe(kg.id);
    expect(line(state).price).toBe(6);
    expect(line(state).quantity).toBe(1);
    expect(line(state).subtotal).toBe(6);
    expect(line(state).weighed).toBe(true);
  });

  test("0.255 KG line does not keep package price 12 after switch to كغم", () => {
    let state = checkoutReducer(checkoutInitialState, {
      type: "ADD_PRODUCT",
      product: testdliLookup(pack, { weighed: true, weight: 0.255, quantity: 0.255 }),
    });
    expect(line(state).price).toBe(12);
    expect(line(state).quantity).toBeCloseTo(0.255);
    expect(line(state).subtotal).toBeCloseTo(3.06);

    state = checkoutReducer(state, {
      type: "CHANGE_UNIT",
      cartKey: line(state).cartKey,
      unitId: kg.id,
    });
    expect(line(state).unitName).toBe("كغم");
    expect(line(state).price).toBe(6);
    expect(line(state).quantity).toBeCloseTo(0.255);
    expect(line(state).subtotal).toBeCloseTo(1.53);
    expect(line(state).subtotal).not.toBeCloseTo(3.06);
  });

  test("switching كغم → حبة restores the package price", () => {
    let state = checkoutReducer(checkoutInitialState, {
      type: "ADD_PRODUCT",
      product: testdliLookup(kg, { weighed: true, weight: 0.255, quantity: 0.255 }),
    });
    expect(line(state).price).toBe(6);
    expect(line(state).subtotal).toBeCloseTo(1.53);

    state = checkoutReducer(state, {
      type: "CHANGE_UNIT",
      cartKey: line(state).cartKey,
      unitId: pack.id,
    });
    expect(line(state).unitName).toBe("حبة");
    expect(line(state).price).toBe(12);
    expect(line(state).quantity).toBe(1);
    expect(line(state).subtotal).toBe(12);
    expect(line(state).weighed).toBe(false);
  });

  test("0.5 KG × 6 = 3", () => {
    const state = checkoutReducer(checkoutInitialState, {
      type: "ADD_PRODUCT",
      product: testdliLookup(kg, { weighed: true, weight: 0.5, quantity: 0.5 }),
    });
    expect(line(state).unitName).toBe("كغم");
    expect(line(state).price).toBe(6);
    expect(line(state).quantity).toBeCloseTo(0.5);
    expect(line(state).subtotal).toBeCloseTo(3);
  });

  test("switching 1 حبة of 2 KG does not leave package price as the KG price", () => {
    const pack2 = { ...pack, conversion_to_base: 2, price: 24 };
    const kg2 = { ...kg, price: 6 };
    let state = checkoutReducer(checkoutInitialState, {
      type: "ADD_PRODUCT",
      product: {
        product: { id: 2, name: "مرتديلا 2 كغم", price: 6, stock: 10 },
        selectedUnit: pack2,
        availableUnits: [kg2, pack2],
        price: 24,
        unit_id: pack2.id,
        unit_name: "حبة",
        conversion_to_base: 2,
      },
    });
    expect(line(state).price).toBe(24);
    expect(line(state).subtotal).toBe(24);

    state = checkoutReducer(state, {
      type: "CHANGE_UNIT",
      cartKey: line(state).cartKey,
      unitId: kg2.id,
    });
    expect(line(state).unitName).toBe("كغم");
    expect(line(state).price).toBe(6);
    expect(line(state).quantity).toBe(2);
    expect(line(state).subtotal).toBe(12);
  });
});
