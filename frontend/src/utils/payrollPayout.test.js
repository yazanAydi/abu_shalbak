import { allocatePayrollDeductions } from "./payrollPayout";

const advances = [
  { id: 11, date: "2026-08-02", remaining: 200, reason: "سلفة أولى" },
  { id: 12, date: "2026-08-10", remaining: 50, reason: "سلفة ثانية" },
];
const debts = [
  { source_type: "pos_sale", source_id: 21, date: "2026-08-05", remaining: 100, description: "ذمة خبز" },
];

describe("allocatePayrollDeductions", () => {
  it("deducts all outstanding and pays the leftover cash", () => {
    const result = allocatePayrollDeductions(1000, advances, debts);
    expect(result.advanceDeducted).toBe(250);
    expect(result.debtDeducted).toBe(100);
    expect(result.cashPaid).toBe(650);
    expect(result.deductions).toHaveLength(3);
    expect(result.deductions.map((d) => d.amount)).toEqual([200, 100, 50]);
  });

  it("applies oldest lines first when the amount is smaller than outstanding", () => {
    const result = allocatePayrollDeductions(220, advances, debts);
    expect(result.advanceDeducted).toBe(200);
    expect(result.debtDeducted).toBe(20);
    expect(result.cashPaid).toBe(0);
    expect(result.deductions).toEqual([
      expect.objectContaining({ kind: "advance", source_id: 11, amount: 200 }),
      expect.objectContaining({ kind: "debt", source_id: 21, amount: 20 }),
    ]);
  });

  it("pays zero cash when the amount is fully consumed by deductions", () => {
    const result = allocatePayrollDeductions(350, advances, debts);
    expect(result.cashPaid).toBe(0);
    expect(result.advanceDeducted).toBe(250);
    expect(result.debtDeducted).toBe(100);
  });

  it("pays the full amount when there are no outstanding lines", () => {
    const result = allocatePayrollDeductions(400, [], []);
    expect(result.cashPaid).toBe(400);
    expect(result.deductions).toEqual([]);
  });

  it("returns empty allocation for a blank or zero amount", () => {
    expect(allocatePayrollDeductions("", advances, debts).cashPaid).toBe(0);
    expect(allocatePayrollDeductions(0, advances, debts).deductions).toEqual([]);
  });
});
