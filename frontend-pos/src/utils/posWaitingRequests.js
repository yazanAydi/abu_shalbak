const KEYS = {
  onAccount: "pos.waiting.onAccountId",
  advance: "pos.waiting.advanceId",
  cashDebt: "pos.waiting.cashDebtId",
  supplierPayment: "pos.waiting.supplierPaymentId",
  shopExpense: "pos.waiting.shopExpenseId",
};

function storage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readWaitingRequestId(kind) {
  const store = storage();
  if (!store) return null;
  const n = Number(store.getItem(KEYS[kind]));
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function writeWaitingRequestId(kind, id) {
  const store = storage();
  if (!store) return;
  if (id) store.setItem(KEYS[kind], String(id));
  else store.removeItem(KEYS[kind]);
}
