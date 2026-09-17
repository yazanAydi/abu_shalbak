import { round2 } from "./money.js";
import { HttpError } from "./httpError.js";
import { shopTodayYmd } from "./shopTime.js";

const NO_HISTORY_MESSAGE = "لا يوجد سعر شراء سابق لهذا المورد";

/**
 * Convert a purchase unit_cost between units using historical conversion.
 * unit_cost is the pre-discount price of one source unit.
 */
export function convertPurchaseUnitCost(unitCost, fromConversion, toConversion) {
  const cost = Number(unitCost);
  if (!Number.isFinite(cost)) return null;
  const src = Number(fromConversion);
  const tgt = Number(toConversion);
  const from = Number.isFinite(src) && src > 0 ? src : 1;
  const to = Number.isFinite(tgt) && tgt > 0 ? tgt : 1;
  return round2((cost / from) * to);
}

function parseAsOf(raw) {
  if (raw == null || String(raw).trim() === "") return shopTodayYmd();
  const value = String(raw).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, "as_of يجب أن يكون بصيغة YYYY-MM-DD", "VALIDATION_ERROR");
  }
  return value;
}

async function loadTargetUnit(db, productId, unitId) {
  if (!unitId) return null;
  return db.get(
    `SELECT id, unit_name, conversion_to_base
     FROM product_units
     WHERE id = ? AND product_id = ?`,
    [unitId, productId]
  );
}

function sourceConversion(row) {
  const stored = Number(row.conversion_used);
  if (Number.isFinite(stored) && stored > 0) return stored;
  return 1;
}

function presentHit(row, targetUnit) {
  const fromConv = sourceConversion(row);
  const toConv = targetUnit
    ? Number(targetUnit.conversion_to_base) > 0
      ? Number(targetUnit.conversion_to_base)
      : 1
    : fromConv;
  const sameUnit =
    !targetUnit ||
    Number(row.product_unit_id) === Number(targetUnit.id) ||
    Math.abs(fromConv - toConv) < 1e-9;
  const unitCost = sameUnit
    ? round2(Number(row.unit_cost) || 0)
    : convertPurchaseUnitCost(row.unit_cost, fromConv, toConv);
  if (unitCost == null) return null;
  return {
    found: true,
    unit_cost: unitCost,
    message: null,
    source: {
      kind: row.source_kind,
      invoice_id: Number(row.invoice_id),
      invoice_no: row.invoice_no ?? null,
      invoice_date: row.invoice_date ? String(row.invoice_date).slice(0, 10) : null,
      unit_name: row.unit_name || null,
      converted: !sameUnit,
    },
  };
}

function emptyResult() {
  return {
    found: false,
    unit_cost: null,
    message: NO_HISTORY_MESSAGE,
    source: null,
  };
}

async function linesForInvoice(db, { invoiceId, supplierId, productId, asOf }) {
  return db.all(
    `SELECT pii.unit_cost, pii.product_unit_id, pii.unit_name, pii.conversion_used,
            pi.id AS invoice_id, pi.invoice_no, pi.invoice_date,
            'original_invoice' AS source_kind
     FROM purchase_invoice_items pii
     JOIN purchase_invoices pi ON pi.id = pii.invoice_id
     WHERE pi.id = ?
       AND pi.supplier_id = ?
       AND pi.status = 'posted'
       AND pi.invoice_date <= ?
       AND pii.product_id = ?
     ORDER BY
       CASE WHEN pii.product_unit_id IS NOT NULL THEN 0 ELSE 1 END,
       pii.id DESC`,
    [invoiceId, supplierId, asOf, productId]
  );
}

async function latestLines(db, { supplierId, productId, asOf, targetUnitId }) {
  const unitParam = targetUnitId || null;
  return db.all(
    `SELECT pii.unit_cost, pii.product_unit_id, pii.unit_name, pii.conversion_used,
            pi.id AS invoice_id, pi.invoice_no, pi.invoice_date,
            'latest_purchase' AS source_kind
     FROM purchase_invoice_items pii
     JOIN purchase_invoices pi ON pi.id = pii.invoice_id
     WHERE pi.supplier_id = ?
       AND pi.status = 'posted'
       AND pi.invoice_date <= ?
       AND pii.product_id = ?
     ORDER BY pi.invoice_date DESC, pi.id DESC,
       CASE WHEN ? IS NOT NULL AND pii.product_unit_id = ? THEN 0 ELSE 1 END,
       pii.id DESC`,
    [supplierId, asOf, productId, unitParam, unitParam]
  );
}

function pickLine(rows, targetUnitId) {
  if (!rows.length) return null;
  if (targetUnitId) {
    const exact = rows.find((row) => Number(row.product_unit_id) === Number(targetUnitId));
    if (exact) return exact;
  }
  return rows[0];
}

/**
 * Latest posted purchase unit price for a supplier/product/unit as of a return date.
 * Prefers an explicit original invoice when it is posted, same supplier, and not after as_of.
 */
export async function resolveSupplierPurchaseUnitPrice(db, opts = {}) {
  const supplierId = Math.floor(Number(opts.supplierId));
  const productId = Math.floor(Number(opts.productId));
  if (!Number.isInteger(supplierId) || supplierId <= 0) {
    throw new HttpError(400, "المورد مطلوب", "VALIDATION_ERROR");
  }
  if (!Number.isInteger(productId) || productId <= 0) {
    throw new HttpError(400, "المنتج مطلوب", "VALIDATION_ERROR");
  }
  const asOf = parseAsOf(opts.asOf);
  const unitId = opts.unitId != null && opts.unitId !== "" ? Math.floor(Number(opts.unitId)) : null;
  const invoiceId =
    opts.invoiceId != null && opts.invoiceId !== "" ? Math.floor(Number(opts.invoiceId)) : null;

  const product = await db.get("SELECT id FROM products WHERE id = ?", [productId]);
  if (!product) throw new HttpError(404, "المنتج غير موجود", "NOT_FOUND");
  const supplier = await db.get("SELECT id FROM suppliers WHERE id = ?", [supplierId]);
  if (!supplier) throw new HttpError(404, "المورد غير موجود", "NOT_FOUND");

  const targetUnit = unitId ? await loadTargetUnit(db, productId, unitId) : null;
  if (unitId && !targetUnit) {
    throw new HttpError(400, "وحدة المنتج غير صالحة", "VALIDATION_ERROR");
  }

  if (invoiceId) {
    const original = await linesForInvoice(db, { invoiceId, supplierId, productId, asOf });
    const hit = pickLine(original, targetUnit?.id);
    const presented = hit ? presentHit(hit, targetUnit) : null;
    if (presented) return presented;
  }

  const latest = await latestLines(db, {
    supplierId,
    productId,
    asOf,
    targetUnitId: targetUnit?.id,
  });
  const presented = latest[0] ? presentHit(latest[0], targetUnit) : null;
  return presented || emptyResult();
}

export { NO_HISTORY_MESSAGE };
