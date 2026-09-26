/** Credentials exist only in the disposable E2E database. They are not shop logins. */
export const USERS = {
  admin: { username: "e2e-admin", password: "e2e-admin-pass", role: "admin" },
  cashierA: { username: "e2e-cashier-a", password: "e2e-cashier-a-pass", role: "cashier" },
  cashierB: { username: "e2e-cashier-b", password: "e2e-cashier-b-pass", role: "cashier" },
};

export const PRODUCT = {
  barcode: "9900020",
  name: "منتج أ",
  price: 20,
  raisedPrice: 30,
  cost: 5,
  stock: 100,
  category: "E2E",
  unit: "حبة",
};

export const SALE_DAY = "2020-01-10";
export const RETURN_DAY = "2020-01-11";
export const VISA_SALE_DAY = "2020-02-01";
export const VISA_CASH_SALE_DAY = "2020-02-02";

export const OPENING_A = 100;
export const OPENING_B = 500;
export const CASH_SALE_QTY = 2;
export const DRAWER_SALE_QTY = 15;
export const VISA_QTY = 5;

export function dmy(ymd) {
  const [year, month, day] = String(ymd).split("-");
  return `${day}/${month}/${year.slice(-2)}`;
}
