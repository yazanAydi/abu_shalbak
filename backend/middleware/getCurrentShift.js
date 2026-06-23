/** @param {any} db */
export async function getOpenShiftForCashier(db, cashierId) {
  const id = Number(cashierId);
  if (!id) return null;
  return db.get(
    `SELECT * FROM cashier_shifts WHERE cashier_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`,
    [id]
  );
}

/** @param {any} db */
export async function requireOpenShiftForCashier(db, cashierId) {
  const shift = await getOpenShiftForCashier(db, cashierId);
  if (!shift) {
    return { shift: null, error: "لا توجد وردية مفتوحة" };
  }
  return { shift };
}
