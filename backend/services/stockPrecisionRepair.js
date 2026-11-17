import { STOCK_ZERO_EPS } from "../utils/stockQuantity.js";
import { withTransaction } from "../utils/dbTx.js";
import { applyStockDelta } from "../utils/inventory.js";
import { logAudit } from "../utils/auditLog.js";
import { forbidden, badRequest } from "../utils/httpError.js";

const COLUMNS = {
  products: "stock",
  product_batches: "quantity",
  stock_source_lots: "quantity",
  warehouse_batch_stock: "quantity",
  warehouse_stock: "quantity",
};

/** Read-only preview. Never rounds or changes genuine stock. */
export async function previewStockPrecisionRepair(db) {
  const result = {};
  for (const [table, column] of Object.entries(COLUMNS)) {
    result[table] = await db.all(
      `SELECT id, ${column} AS old_quantity FROM ${table}
        WHERE ${column} != 0 AND ABS(${column}) < ? ORDER BY id`,
      [STOCK_ZERO_EPS]
    );
  }
  return result;
}

/** Explicit maintenance only: never called by startup, reads, or an inventory reset. */
export async function applyStockPrecisionRepair(db, { actorId, reason }) {
  if (!String(reason || "").trim()) throw badRequest("سبب التصحيح مطلوب");
  return withTransaction(db, async () => {
    const actor = await db.get("SELECT id, username, role FROM users WHERE id = ?", [actorId]);
    if (actor?.role !== "admin") throw forbidden("هذا الإجراء للمدير فقط");
    const before = await previewStockPrecisionRepair(db);
    const counts = Object.fromEntries(Object.entries(before).map(([table, rows]) => [table, rows.length]));
    if (!Object.values(counts).some(Boolean)) return { changed: false, counts };
    for (const row of before.products) {
      // Append a correction; do not rewrite the existing ledger or sale costs.
      await applyStockDelta(db, row.id, -Number(row.old_quantity), {
        movementType: "correction",
        referenceType: "stock_precision_correction",
        userId: actor.id,
        notes: String(reason).trim(),
        deferDepletion: true,
      });
    }
    for (const [table, column] of Object.entries(COLUMNS)) {
      if (table === "products") continue;
      for (const row of before[table]) {
        await db.run(`UPDATE ${table} SET ${column} = 0 WHERE id = ?`, [row.id]);
      }
    }
    await logAudit(db, { user: actor, headers: {}, ip: null }, "STOCK_PRECISION_CORRECTION",
      "inventory", null, before, { counts, reason: String(reason).trim(), quantity: 0 });
    return { changed: true, counts };
  });
}
