import { mapShiftDetailToCountTarget, paymentPayloadSignature } from "./shiftCountSupplierPayment";

describe("mapShiftDetailToCountTarget", () => {
  test("uses live expected cash and payments without inventing a second deduction", () => {
    const mapped = mapShiftDetailToCountTarget({
      shift: {
        id: 4,
        cashier_name: "testcashier",
        expected_cash: 57.5,
        expected_by_currency: [{ code: "ILS", original: 57.5 }],
      },
      summary: {
        expected: 57.5,
        expected_by_currency: [{ code: "ILS", original: 57.5 }],
        supplier_payments_total: 20,
        advances_total: 20,
        cash_sales: 500,
        cash_only_sales: 400,
        mixed_cash_sales: 100,
        tender_total: 700,
        cash_sales_incomplete: false,
      },
      supplier_payments: [{ voucher_no: 12, amount: 20, supplier_name: "مورد الخضار" }],
      advances: [{ request_id: 3, amount: 20, employee_name: "سامي" }],
    });
    expect(mapped.expected_cash).toBe(57.5);
    expect(mapped.supplier_payments).toHaveLength(1);
    expect(mapped.supplier_payments_total).toBe(20);
    expect(mapped.advances).toHaveLength(1);
    expect(mapped.advances_total).toBe(20);
    expect(mapped.cash_sales).toBe(500);
    expect(mapped.cash_only_sales).toBe(400);
    expect(mapped.mixed_cash_sales).toBe(100);
    expect(mapped.tender_total).toBe(700);
    expect(mapped.cash_sales_incomplete).toBe(false);
    expect(mapped.cashier_name).toBe("testcashier");
  });

  test("keeps a changed payload signature distinct from the original key", () => {
    expect(paymentPayloadSignature(1, "20", "")).not.toBe(paymentPayloadSignature(1, "25", ""));
  });
});
