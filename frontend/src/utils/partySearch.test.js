import { isPartyValue, partyBadgeFromCustomer } from "./partySearch";

describe("isPartyValue", () => {
  test("accepts a customer or supplier pick", () => {
    expect(isPartyValue({ type: "customer", id: 4, name: "أحمد" })).toBe(true);
    expect(isPartyValue({ type: "supplier", id: "12", name: "شركة النور" })).toBe(true);
  });

  test("rejects click events and empty chips so the name field stays searchable", () => {
    expect(isPartyValue({ type: "click", target: {}, nativeEvent: {} })).toBe(false);
    expect(isPartyValue({ type: "supplier" })).toBe(false);
    expect(isPartyValue({ id: 3, name: "بدون نوع" })).toBe(false);
    expect(isPartyValue(null)).toBe(false);
  });
});

describe("partyBadgeFromCustomer", () => {
  test("falls back to زبون", () => {
    expect(partyBadgeFromCustomer(null, null)).toBe("زبون");
  });
});
