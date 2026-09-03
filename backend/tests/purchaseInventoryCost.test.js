import { round2 } from "../utils/money.js";
import {
  purchaseBaseQty,
  purchaseBaseUnitCost,
  purchaseLineGross,
  wacAfterInbound,
  wacAfterOutbound,
} from "../utils/purchaseInventoryCost.js";

describe("purchaseInventoryCost helpers", () => {
  test("purchaseLineGross prefers post-discount line_total", () => {
    expect(purchaseLineGross({ total_cost: 100, line_total: 90 })).toBe(90);
    expect(purchaseLineGross({ total_cost: 100 })).toBe(100);
  });

  test("purchaseBaseUnitCost uses payable / base qty", () => {
    expect(purchaseBaseUnitCost({ line_total: 90, base_quantity: 25 })).toBe(3.6);
    expect(purchaseBaseUnitCost({ total_cost: 100, quantity: 10, base_quantity: 25 })).toBe(4);
  });

  test("purchaseBaseQty prefers base_quantity", () => {
    expect(purchaseBaseQty({ quantity: 10, base_quantity: 25 })).toBe(25);
    expect(purchaseBaseQty({ quantity: 12.5 })).toBe(12.5);
  });

  test("WAC inbound mixed costs", () => {
    expect(wacAfterInbound(25, 4, 25, 6)).toBe(5);
  });

  test("WAC outbound reverses stated return value (not a batch layer)", () => {
    expect(wacAfterOutbound(50, 5, 5, 6)).toBe(round2(220 / 45));
    expect(wacAfterOutbound(50, 5, 5, 6)).toBe(4.89);
  });

  test("WAC outbound at current average leaves cost unchanged", () => {
    expect(wacAfterOutbound(50, 5, 5, 5)).toBe(5);
  });

  test("WAC outbound to zero stock keeps last cost", () => {
    expect(wacAfterOutbound(25, 4, 25, 4)).toBe(4);
  });

  test("WAC outbound clamps remaining negative value to 0", () => {
    expect(wacAfterOutbound(10, 1, 5, 10)).toBe(0);
  });
});
