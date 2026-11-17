import { qty } from "./format";

test("stock display hides binary noise and negative zero without hiding fractional shortages", () => {
  for (const value of [-1.4210854715202004e-14, -2.7755575615628914e-17, 1e-14, -0]) expect(qty(value, 6)).toBe("0");
  expect(qty(-0.000001, 6)).toBe("-0.000001");
  expect(qty(0.125, 6)).toBe("0.125");
  expect(qty(-12.5, 6)).toBe("-12.5");
});
