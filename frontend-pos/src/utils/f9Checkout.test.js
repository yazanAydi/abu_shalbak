import { isHeldKeyRepeat, onePressCashPayload, resolveF9CheckoutAction } from "./f9Checkout";

describe("F9 one-press checkout", () => {
  test("held/repeat F9 is ignored", () => {
    expect(isHeldKeyRepeat({ repeat: true })).toBe(true);
    expect(
      resolveF9CheckoutAction({
        repeat: true,
        cartCount: 2,
        shiftReady: true,
        isLoading: false,
        isSubmitting: false,
        payModalOpen: false,
      })
    ).toEqual({ action: "ignore-repeat" });
  });

  test("ready cart on F9 posts cash without opening the modal", () => {
    expect(
      resolveF9CheckoutAction({
        repeat: false,
        cartCount: 1,
        shiftReady: true,
        isLoading: false,
        isSubmitting: false,
        payModalOpen: false,
      })
    ).toEqual({ action: "cash-checkout" });
    expect(onePressCashPayload()).toEqual({ payment_method: "cash" });
  });

  test("in-flight submit or empty cart does not start another sale", () => {
    expect(
      resolveF9CheckoutAction({
        repeat: false,
        cartCount: 1,
        shiftReady: true,
        isLoading: false,
        isSubmitting: true,
        payModalOpen: false,
      })
    ).toEqual({ action: "ignore" });
    expect(
      resolveF9CheckoutAction({
        repeat: false,
        cartCount: 0,
        shiftReady: true,
        isLoading: false,
        isSubmitting: false,
        payModalOpen: false,
      })
    ).toEqual({ action: "ignore" });
  });

  test("F9 inside the payment modal is left to ترحيل", () => {
    expect(
      resolveF9CheckoutAction({
        repeat: false,
        cartCount: 1,
        shiftReady: true,
        isLoading: false,
        isSubmitting: false,
        payModalOpen: true,
      })
    ).toEqual({ action: "defer-to-modal" });
  });
});
