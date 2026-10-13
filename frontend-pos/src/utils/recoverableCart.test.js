import { clearRecoverableCart, readRecoverableCart, writeRecoverableCart } from "./recoverableCart";

describe("recoverable POS cart", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("restores only the same cashier and keeps the checkout key", () => {
    writeRecoverableCart({
      userId: 4,
      shiftId: 9,
      cartItems: [{ id: 1, quantity: 2, price: 10 }],
      idempotencyKey: "same-sale-key",
      submittedPayload: { idempotency_key: "same-sale-key", items: [{ product_id: 1 }] },
    });
    expect(readRecoverableCart(8)).toBeNull();
    const saved = readRecoverableCart(4);
    expect(saved.shiftId).toBe(9);
    expect(saved.cartItems).toHaveLength(1);
    expect(saved.idempotencyKey).toBe("same-sale-key");
    expect(saved.submittedPayload.idempotency_key).toBe("same-sale-key");
    expect(localStorage.getItem("pos.recoverableCart.v1.8")).toBeNull();
  });

  test("an empty cart removes that cashier's copy and leaves the other", () => {
    writeRecoverableCart({ userId: 4, shiftId: 9, cartItems: [{ id: 1 }] });
    writeRecoverableCart({ userId: 5, shiftId: 3, cartItems: [{ id: 2 }] });
    writeRecoverableCart({ userId: 4, shiftId: 9, cartItems: [] });
    expect(readRecoverableCart(4)).toBeNull();
    expect(readRecoverableCart(5).cartItems[0].id).toBe(2);
    clearRecoverableCart(5);
    expect(readRecoverableCart(5)).toBeNull();
  });
});