export function newPaymentIdempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

export function paymentPayloadSignature(supplierId, amount, notes) {
  return JSON.stringify({
    supplier_id: String(supplierId || ""),
    amount: String(amount || ""),
    notes: String(notes || "").trim(),
  });
}

export function advancePayloadSignature(employeeId, amount, notes) {
  return JSON.stringify({
    employee_id: String(employeeId || ""),
    amount: String(amount || ""),
    notes: String(notes || "").trim(),
  });
}

export function mapShiftDetailToCountTarget(data) {
  const shift = data?.shift || {};
  const summary = data?.summary || {};
  return {
    ...shift,
    expected_cash: summary.expected ?? shift.expected_cash,
    expected_by_currency: summary.expected_by_currency || shift.expected_by_currency || [],
    supplier_payments: Array.isArray(data?.supplier_payments)
      ? data.supplier_payments
      : shift.supplier_payments || [],
    supplier_payments_total: summary.supplier_payments_total ?? shift.supplier_payments_total ?? 0,
    customer_collections: Array.isArray(data?.customer_collections)
      ? data.customer_collections
      : shift.customer_collections || [],
    customer_collections_total:
      summary.customer_collections_total ?? shift.customer_collections_total ?? 0,
    customer_cash_debts: Array.isArray(data?.customer_cash_debts)
      ? data.customer_cash_debts
      : shift.customer_cash_debts || [],
    customer_cash_debts_total:
      summary.customer_cash_debts_total ?? shift.customer_cash_debts_total ?? 0,
    advances: Array.isArray(data?.advances) ? data.advances : shift.advances || [],
    advances_total: summary.advances_total ?? shift.advances_total ?? 0,
    cash_sales: summary.cash_sales ?? shift.cash_sales ?? 0,
    cash_only_sales: summary.cash_only_sales ?? shift.cash_only_sales ?? 0,
    mixed_cash_sales: summary.mixed_cash_sales ?? shift.mixed_cash_sales ?? 0,
    cash_refunds: summary.cash_refunds ?? shift.cash_refunds ?? 0,
    cash_net: summary.cash_net ?? shift.cash_net,
    tender_total: summary.tender_total ?? shift.tender_total,
    cash_sales_incomplete: !!(summary.cash_sales_incomplete ?? shift.cash_sales_incomplete),
    cash_sales_label: summary.cash_sales_label || shift.cash_sales_label,
    mixed_cash_label: summary.mixed_cash_label || shift.mixed_cash_label,
    mixed_cash_included_note: summary.mixed_cash_included_note || shift.mixed_cash_included_note,
    visa_amount_label: summary.visa_amount_label || shift.visa_amount_label,
    tender_total_label: summary.tender_total_label || shift.tender_total_label,
    cash_refunds_label: summary.cash_refunds_label || shift.cash_refunds_label,
    cash_net_label: summary.cash_net_label || shift.cash_net_label,
    cash_sales_incomplete_note:
      summary.cash_sales_incomplete_note || shift.cash_sales_incomplete_note,
    expected_cash_label: summary.expected_cash_label || shift.expected_cash_label,
  };
}
