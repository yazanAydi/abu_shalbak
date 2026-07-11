import { buildReceiptText } from "../utils/receipt.js";
import {
  STORE_LICENSE_LINE,
  STORE_NAME_AR,
  STORE_PHONE,
} from "../utils/storeBranding.js";

const baseReceiptOpts = {
  transactionId: 42,
  timestamp: "2026-07-06 12:00:00",
  cashierName: "test",
  lines: [{ name: "خبز", quantity: 2, price: 5, lineTotal: 10 }],
  subtotal: 10,
  tax: 0,
  total: 10,
  paymentMethod: "cash",
  settings: {},
};

describe("receipt store branding", () => {
  test("customer sale receipt shows store name and phone in English digits", () => {
    const text = buildReceiptText(baseReceiptOpts);

    expect(text).toContain(STORE_NAME_AR);
    expect(text).toContain(STORE_PHONE);
    expect(text).toContain("إيصال بيع");
    expect(text).not.toContain("مشتغل مرخص");
    expect(text).not.toContain(STORE_LICENSE_LINE);
  });
});
