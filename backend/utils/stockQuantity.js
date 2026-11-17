// Numerical noise below this conservative tolerance is below supported 6-dp stock precision.
// Genuine negative stock, including -0.000001, must remain negative.
export const STOCK_ZERO_EPS = 1e-9;
export function stockQuantitySql(column = "stock") {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(column)) throw new Error("Invalid stock column");
  return `(CASE WHEN ABS(${column}) < ${STOCK_ZERO_EPS} THEN 0 ELSE ${column} END)`;
}
