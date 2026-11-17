/**
 * Company-wide stock reset.
 *
 * The quantity clears, ledger rows, single depletion pass, and completion
 * audit share one write transaction. A lost client response retries
 * the same idempotency key and does not start a second reset. Writers wait
 * until this transaction commits. WAL readers keep using the last commit.
 */

import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { withTransaction } from "../utils/dbTx.js";
import { badRequest } from "../utils/httpError.js";
import { applyStockDelta } from "../utils/inventory.js";
import { round6 } from "../utils/purchaseInventoryCost.js";
import { normalizeExpiryDate } from "../utils/expiryDate.js";
import { datedQuantitySum } from "./stockBatchService.js";
import {
  applyDepletionForMovements,
  shopBusinessToday,
  valuationAccountingStats,
} from "../utils/warehouseValuationHistory.js";

const LOT_EPS = 1e-9;
const STOCK_EPS = 0.0001;
const PRODUCT_CHUNK = 20;

const STAGE_AR = {
  preparing: "جارٍ تجهيز بيانات المخزون…",
  zeroing: "جارٍ تصفير الكميات…",
  saving: "جارٍ حفظ التغييرات…",
  completed: "اكتمل التصفير",
  failed: "لم يُحفظ التصفير. لم تتغير الكميات.",
  interrupted: "انقطع التصفير قبل اكتماله. لم يُعاد تشغيله.",
};

const operations = new Map();
let activeId = null;

function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function newOperationId() {
  return `zero-${crypto.randomUUID()}`;
}

export function resetZeroAllStockGuardForTests() {
  operations.clear();
  activeId = null;
}

function publish(op, patch = {}) {
  if (!op) return;
  Object.assign(op, patch);
  if (op.stage === "completed") {
    op.status = "completed";
    op.indeterminate = false;
    op.percent = 100;
    return;
  }
  if (op.stage === "failed" || op.stage === "interrupted") {
    op.status = op.stage;
    op.indeterminate = true;
    op.percent = null;
    return;
  }
  op.status = "running";
  if (op.stage === "preparing" || op.stage === "saving") {
    op.indeterminate = true;
    op.percent = null;
    return;
  }
  const total = Number(op.total) || 0;
  const processed = Number(op.processed) || 0;
  op.indeterminate = false;
  if (!total) {
    op.percent = 0;
    return;
  }
  const raw = Math.floor((processed / total) * 100);
  op.percent = raw >= 100 ? 99 : raw;
}

function publicView(op, { reused = false } = {}) {
  const done = op.status === "completed";
  return {
    operation_id: op.id,
    status: op.status,
    stage: op.stage,
    stage_ar: STAGE_AR[op.stage] || "",
    indeterminate: Boolean(op.indeterminate),
    processed: op.processed == null ? null : Number(op.processed),
    total: op.total == null ? null : Number(op.total),
    percent: op.percent == null ? null : Number(op.percent),
    products_changed: done ? Number(op.productsChanged) || 0 : null,
    products_zeroed: done ? Number(op.productsChanged) || 0 : null,
    skipped: done ? Number(op.skipped) || 0 : null,
    replayed: Boolean(op.replayed),
    ...(reused ? { reused: true } : {}),
    read_only: true,
  };
}

function completedFromRun(id, run, replayed) {
  const changed = Number(run.products_zeroed) || 0;
  const skipped = Number(run.skipped) || 0;
  return {
    id,
    status: "completed",
    stage: "completed",
    indeterminate: false,
    percent: 100,
    processed: changed + skipped,
    total: changed + skipped,
    productsChanged: changed,
    skipped,
    replayed: Boolean(replayed),
    promise: null,
  };
}

function remember(op) {
  operations.set(op.id, op);
  const finished = [...operations.values()].filter((row) => row.status !== "running");
  if (finished.length > 20) {
    operations.delete(finished[0].id);
  }
}

export function parseZeroAllIdempotencyKey(value) {
  if (value == null) return null;
  const key = String(value).trim();
  if (!key) return null;
  if (key.length < 8 || key.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw badRequest("مفتاح منع التكرار غير صالح", "INVALID_IDEMPOTENCY_KEY");
  }
  return key;
}

function storedRun(row) {
  return {
    products_zeroed: Number(row.products_zeroed) || 0,
    skipped: Number(row.skipped) || 0,
    stock_movements: Number(row.stock_movements) || 0,
    depletion_adjustments: Number(row.depletion_adjustments) || 0,
    valuation_rebuilds: Number(row.valuation_rebuilds) || 0,
    depletion_passes: Number(row.depletion_passes) || 0,
    run_id: Number(row.id),
    replayed: true,
  };
}

function lotAllocation(lot, referenceId) {
  const quantity = round6(Math.abs(Number(lot.quantity) || 0));
  return {
    productId: Number(lot.product_id),
    expiry: normalizeExpiryDate(lot.expiry_date) || null,
    quantity,
    direction: Number(lot.quantity) > 0 ? "out" : "in",
    warehouseId: lot.warehouse_id == null ? null : Number(lot.warehouse_id),
    sourceLotId: Number(lot.id),
    supplierId: lot.supplier_id == null ? null : Number(lot.supplier_id),
    purchaseInvoiceId: lot.purchase_invoice_id == null ? null : Number(lot.purchase_invoice_id),
    purchaseInvoiceItemId: lot.purchase_invoice_item_id == null ? null : Number(lot.purchase_invoice_item_id),
    provenance: lot.provenance || null,
    referenceId,
  };
}

function plainAllocation(productId, expiry, quantity, referenceId) {
  const qty = round6(Number(quantity) || 0);
  return {
    productId: Number(productId),
    expiry: expiry || null,
    quantity: round6(Math.abs(qty)),
    direction: qty > 0 ? "out" : "in",
    warehouseId: null,
    sourceLotId: null,
    supplierId: null,
    purchaseInvoiceId: null,
    purchaseInvoiceItemId: null,
    provenance: null,
    referenceId,
  };
}

async function insertAllocations(db, rows) {
  const width = 14;
  const batchSize = 40;
  const usable = rows.filter((row) => row.quantity > 0);
  for (let i = 0; i < usable.length; i += batchSize) {
    const slice = usable.slice(i, i + batchSize);
    const params = [];
    for (const row of slice) {
      params.push(
        row.productId,
        row.expiry,
        row.quantity,
        row.direction,
        "zero_all_stock",
        row.referenceId,
        null,
        null,
        row.warehouseId,
        row.sourceLotId,
        row.supplierId,
        row.purchaseInvoiceId,
        row.purchaseInvoiceItemId,
        row.provenance
      );
    }
    const sqlValues = slice.map(() => `(${new Array(width).fill("?").join(",")})`).join(",");
    await db.run(
      `INSERT INTO stock_batch_allocations
         (product_id, expiry_date, quantity, direction, reference_type, reference_id,
          transaction_item_id, invoice_item_id, warehouse_id,
          source_lot_id, supplier_id, purchase_invoice_id, purchase_invoice_item_id, source_provenance)
       VALUES ${sqlValues}`,
      params
    );
    if (i > 0 && i % 800 === 0) await yieldEventLoop();
  }
}

async function clearQuantities(db) {
  await db.run(
    `DELETE FROM warehouse_stock
      WHERE EXISTS (
        SELECT 1 FROM warehouse_batch_stock b
         WHERE b.warehouse_id = warehouse_stock.warehouse_id
           AND b.product_id = warehouse_stock.product_id
      )`
  );
  await db.run("DELETE FROM warehouse_batch_stock");
  await db.run("UPDATE product_batches SET quantity = 0 WHERE quantity != 0");
  await db.run("UPDATE stock_source_lots SET quantity = 0 WHERE quantity != 0");
}

function planReset(products, lots, batches, referenceId) {
  const lotsByProduct = new Map();
  for (const lot of lots) {
    const quantity = round6(Number(lot.quantity) || 0);
    if (Math.abs(quantity) <= LOT_EPS) continue;
    const pid = Number(lot.product_id);
    const list = lotsByProduct.get(pid) || [];
    list.push({ ...lot, quantity });
    lotsByProduct.set(pid, list);
  }
  const batchesByProduct = new Map();
  for (const batch of batches) {
    const expiry = normalizeExpiryDate(batch.expiry_date);
    if (!expiry) continue;
    const pid = Number(batch.product_id);
    const list = batchesByProduct.get(pid) || [];
    list.push({ expiry, quantity: round6(Number(batch.quantity) || 0) });
    batchesByProduct.set(pid, list);
  }

  const work = [];
  for (const product of products) {
    const pid = Number(product.id);
    const rawStock = Number(product.stock) || 0;
    // Cancel the stored binary value exactly, including sub-precision residues.
    const stock = rawStock;
    const active = lotsByProduct.get(pid) || [];
    const dated = batchesByProduct.get(pid) || [];
    const allocations = [];
    let touched = false;
    if (active.length) {
      touched = true;
      for (const lot of active) allocations.push(lotAllocation(lot, referenceId));
    } else if (dated.length) {
      for (const batch of dated) {
        if (Math.abs(batch.quantity) <= LOT_EPS) continue;
        touched = true;
        allocations.push(plainAllocation(pid, batch.expiry, batch.quantity, referenceId));
      }
      const unknown = round6(rawStock - datedQuantitySum(dated));
      if (Math.abs(unknown) > LOT_EPS) {
        touched = true;
        allocations.push(plainAllocation(pid, null, unknown, referenceId));
      }
    }
    work.push({
      productId: pid,
      allocations,
      delta: stock !== 0 ? -stock : null,
      skipped: stock === 0 && !touched,
    });
  }
  return { work };
}

async function performZeroAllStock(db, opts, key, op) {
  const started = Date.now();
  publish(op, { stage: "preparing", processed: null, total: null });
  return withTransaction(db, async () => {
    if (key) {
      const existing = await db.get(
        "SELECT * FROM zero_all_stock_runs WHERE idempotency_key = ?",
        [key]
      );
      if (existing) return { ...storedRun(existing), elapsed_ms: Date.now() - started };
    }
    if (opts.hold) await opts.hold;

    const run = await db.run(
      `INSERT INTO zero_all_stock_runs
         (idempotency_key, products_zeroed, skipped, stock_movements, depletion_adjustments,
          valuation_rebuilds, depletion_passes, user_id)
       VALUES (?, 0, 0, 0, 0, 0, 0, ?)`,
      [key, opts.userId ?? null]
    );
    const runId = Number(run.lastID);
    const before = valuationAccountingStats();
    const products = await db.all("SELECT id, stock FROM products");
    await yieldEventLoop();
    const lots = await db.all(
      `SELECT id, product_id, warehouse_id, expiry_date, supplier_id, purchase_invoice_id,
              purchase_invoice_item_id, quantity, provenance
         FROM stock_source_lots
        WHERE ABS(quantity) > ?`,
      [LOT_EPS]
    );
    await yieldEventLoop();
    const batches = await db.all(
      `SELECT product_id, expiry_date, quantity
         FROM product_batches
        WHERE expiry_date IS NOT NULL AND TRIM(expiry_date) != ''`
    );
    const businessDay = await shopBusinessToday(db);
    const plan = planReset(products, lots, batches, runId);
    await yieldEventLoop();

    const movements = [];
    let processed = 0;
    let changed = 0;
    let skipped = 0;
    publish(op, {
      stage: "zeroing",
      processed: 0,
      total: plan.work.length,
    });
    for (let i = 0; i < plan.work.length; i += 1) {
      const item = plan.work[i];
      if (item.delta != null && opts.failAfter != null && changed >= Number(opts.failAfter)) {
        const err = new Error("forced zero-all failure");
        err.code = "FORCED_ZERO_FAILURE";
        throw err;
      }
      if (item.allocations.length) await insertAllocations(db, item.allocations);
      if (item.delta != null) {
        const entry = await applyStockDelta(db, item.productId, item.delta, {
          movementType: "count",
          referenceType: "zero_all_stock",
          referenceId: runId,
          userId: opts.userId ?? null,
          notes: "تصفير كل الكميات",
          businessDay,
          deferDepletion: true,
        });
        if (entry) {
          movements.push({
            productId: item.productId,
            ledgerId: entry.ledgerId,
            qtyAfter: entry.qtyAfter,
          });
        }
      }
      if (item.skipped) skipped += 1;
      else changed += 1;
      processed += 1;
      if (i % PRODUCT_CHUNK === PRODUCT_CHUNK - 1 || processed === plan.work.length) {
        publish(op, { stage: "zeroing", processed, total: plan.work.length });
        await yieldEventLoop();
      }
      if (opts.holdAfter != null && processed >= Number(opts.holdAfter) && opts.holdAfterGate) {
        const gate = opts.holdAfterGate;
        opts.holdAfterGate = null;
        publish(op, { stage: "zeroing", processed, total: plan.work.length });
        await gate;
      }
    }

    publish(op, { stage: "saving", processed, total: plan.work.length });
    await clearQuantities(db);
    await yieldEventLoop();
    const depletionAdjustments = movements.length
      ? await applyDepletionForMovements(db, movements)
      : 0;
    const after = valuationAccountingStats();
    const summary = {
      products_zeroed: changed,
      skipped,
      stock_movements: movements.length,
      depletion_adjustments: depletionAdjustments,
      valuation_rebuilds: after.historicalBuilds - before.historicalBuilds,
      depletion_passes: after.depletionPasses - before.depletionPasses,
      run_id: runId,
    };
    await db.run(
      `UPDATE zero_all_stock_runs
          SET products_zeroed = ?, skipped = ?, stock_movements = ?, depletion_adjustments = ?,
              valuation_rebuilds = ?, depletion_passes = ?
        WHERE id = ?`,
      [
        summary.products_zeroed,
        summary.skipped,
        summary.stock_movements,
        summary.depletion_adjustments,
        summary.valuation_rebuilds,
        summary.depletion_passes,
        runId,
      ]
    );
    await logAudit(
      db,
      opts.req,
      AUDIT_ACTIONS.INVENTORY_COUNT,
      "zero_all_stock_runs",
      runId,
      null,
      summary
    );
    return { ...summary, elapsed_ms: Date.now() - started, replayed: false };
  });
}

function runningView() {
  if (!activeId) return null;
  const op = operations.get(activeId);
  if (!op || op.status !== "running") return null;
  return publicView(op, { reused: true });
}

export function runningZeroAllView() {
  return runningView();
}

export async function startZeroAllStock(db, opts = {}) {
  const key = parseZeroAllIdempotencyKey(opts.idempotencyKey);
  const active = runningView();
  if (active) return active;
  const id = key || newOperationId();
  const known = operations.get(id);
  if (known?.status === "completed") return publicView({ ...known, replayed: true });
  if (known?.status === "running") return publicView(known, { reused: true });
  if (key) {
    const existing = await db.get(
      "SELECT * FROM zero_all_stock_runs WHERE idempotency_key = ?",
      [key]
    );
    if (existing) {
      const op = completedFromRun(id, existing, true);
      remember(op);
      return publicView(op);
    }
  }
  const again = runningView();
  if (again) return again;

  const op = {
    id,
    status: "running",
    stage: "preparing",
    indeterminate: true,
    percent: null,
    processed: null,
    total: null,
    productsChanged: null,
    skipped: null,
    replayed: false,
    promise: null,
  };
  publish(op, { stage: "preparing" });
  remember(op);
  activeId = id;
  op.promise = (async () => {
    try {
      const result = await performZeroAllStock(db, opts, id, op);
      op.productsChanged = result.products_zeroed;
      op.skipped = result.skipped;
      op.replayed = Boolean(result.replayed);
      op.processed = Number(result.products_zeroed) + Number(result.skipped);
      op.total = op.processed;
      publish(op, { stage: "completed" });
      return result;
    } catch (err) {
      publish(op, { stage: "failed" });
      throw err;
    } finally {
      if (activeId === id) activeId = null;
    }
  })();
  return publicView(op);
}

export async function runZeroAllStock(db, opts = {}) {
  const view = await startZeroAllStock(db, opts);
  const op = operations.get(view.operation_id);
  if (view.status === "running" && op?.promise) return op.promise;
  return {
    products_zeroed: view.products_zeroed,
    skipped: view.skipped,
    replayed: true,
    elapsed_ms: 0,
    run_id: null,
    stock_movements: null,
    depletion_adjustments: null,
    valuation_rebuilds: 0,
    depletion_passes: 0,
  };
}

export async function resolveZeroAllProgress(db, operationId) {
  const requested = operationId ? String(operationId).trim() : "";
  if (requested) {
    const live = operations.get(requested);
    if (live) return publicView(live);
    const run = await db.get(
      "SELECT * FROM zero_all_stock_runs WHERE idempotency_key = ?",
      [requested]
    );
    if (!run) {
      return publicView({
        id: requested,
        status: "interrupted",
        stage: "interrupted",
        indeterminate: true,
        percent: null,
        processed: null,
        total: null,
        productsChanged: null,
        skipped: null,
        replayed: false,
      });
    }
    const audit = await db.get(
      `SELECT id FROM audit_logs
        WHERE action = ? AND entity_type = 'zero_all_stock_runs' AND entity_id = ?`,
      [AUDIT_ACTIONS.INVENTORY_COUNT, run.id]
    );
    if (!audit) {
      return publicView({
        id: requested,
        status: "interrupted",
        stage: "interrupted",
        indeterminate: true,
        percent: null,
        processed: null,
        total: null,
        productsChanged: null,
        skipped: null,
        replayed: false,
      });
    }
    return publicView(completedFromRun(requested, run, true));
  }
  return runningView();
}

function parseAudit(row) {
  if (!row) return null;
  let body = null;
  try {
    body = JSON.parse(row.new_value || "null");
  } catch {
    body = null;
  }
  if (!body || body.products_zeroed == null || body.skipped == null) return null;
  const runId = body.run_id != null
    ? Number(body.run_id)
    : (row.entity_type === "zero_all_stock_runs" && row.entity_id != null ? Number(row.entity_id) : null);
  return {
    id: Number(row.id),
    created_at: row.created_at,
    entity_type: row.entity_type,
    run_id: runId,
    products_zeroed: Number(body.products_zeroed) || 0,
    skipped: Number(body.skipped) || 0,
    stock_movements: body.stock_movements == null ? null : Number(body.stock_movements),
  };
}

function verdictCopy(verdict) {
  if (verdict === "committed") {
    return "التصفير مُلتزم به. سجل الإتمام وحركات المخزون والكميات متوافقة.";
  }
  if (verdict === "unresolved") {
    return "حالة التصفير غير محسومة. الأدلة متعارضة، فلا يُعاد تشغيل التصفير قبل مراجعة الأرقام.";
  }
  return "لا يوجد تصفير مُلتزم به. لا توجد حركات تصفير ولا سجل إتمام. هذا استنتاج من البيانات، وإعادة تشغيل الحاوية وحدها لا تُثبته. الطلب الذي لم يُلتزم بعد لا يظهر هنا.";
}

/**
 * Read-only picture of the latest reset. An open transaction is invisible
 * until it commits or rolls back, so a restart is not itself the evidence.
 */
export async function diagnoseZeroAllStock(db) {
  const [run, auditRows, ledger, company, dirty] = await Promise.all([
    db.get("SELECT * FROM zero_all_stock_runs ORDER BY id DESC LIMIT 1"),
    db.all(
      `SELECT id, created_at, entity_type, entity_id, new_value
         FROM audit_logs
        WHERE action = ?
          AND (
            entity_type = 'zero_all_stock_runs'
            OR (entity_type = 'products' AND IFNULL(new_value, '') LIKE '%"products_zeroed"%'
                AND IFNULL(new_value, '') LIKE '%"skipped"%')
          )
        ORDER BY id DESC
        LIMIT 20`,
      [AUDIT_ACTIONS.INVENTORY_COUNT]
    ),
    db.get(
      `SELECT COUNT(*) AS rows, COUNT(DISTINCT product_id) AS products
         FROM inventory_ledger
        WHERE reference_type = 'zero_all_stock'`
    ),
    db.get(
      `SELECT
         (SELECT COUNT(*) FROM products WHERE ABS(COALESCE(stock, 0)) > ?) AS products_nonzero_stock,
         (SELECT COUNT(*) FROM stock_source_lots WHERE ABS(COALESCE(quantity, 0)) > ?) AS source_lots_nonzero,
         (SELECT COUNT(*) FROM product_batches WHERE ABS(COALESCE(quantity, 0)) > ?) AS batches_nonzero,
         (SELECT COUNT(*) FROM warehouse_batch_stock WHERE ABS(COALESCE(quantity, 0)) > ?) AS warehouse_batches_nonzero`,
      [LOT_EPS, LOT_EPS, LOT_EPS, LOT_EPS]
    ),
    db.get(
      `WITH latest AS (
         SELECT l.product_id, l.reference_type, l.qty_after
           FROM inventory_ledger l
           JOIN (
             SELECT product_id, MAX(id) AS id
               FROM inventory_ledger
              GROUP BY product_id
           ) m ON m.id = l.id
          WHERE l.reference_type = 'zero_all_stock'
       )
       SELECT
         (SELECT COUNT(*) FROM latest WHERE ABS(COALESCE(qty_after, 0)) > ?) AS qty_after_open,
         (SELECT COUNT(*) FROM latest l
            JOIN products p ON p.id = l.product_id
           WHERE ABS(COALESCE(p.stock, 0)) > ?) AS stock_open,
         (SELECT COUNT(DISTINCT l.product_id) FROM latest l
            JOIN stock_source_lots s ON s.product_id = l.product_id
           WHERE ABS(COALESCE(s.quantity, 0)) > ?) AS lots_open,
         (SELECT COUNT(DISTINCT l.product_id) FROM latest l
            JOIN product_batches b ON b.product_id = l.product_id
           WHERE ABS(COALESCE(b.quantity, 0)) > ?) AS batches_open,
         (SELECT COUNT(DISTINCT l.product_id) FROM latest l
            JOIN warehouse_batch_stock w ON w.product_id = l.product_id
           WHERE ABS(COALESCE(w.quantity, 0)) > ?) AS warehouse_open`,
      [STOCK_EPS, STOCK_EPS, LOT_EPS, LOT_EPS, LOT_EPS]
    ),
  ]);

  const audits = auditRows.map(parseAudit).filter(Boolean);
  const zeroLedgerRows = Number(ledger?.rows) || 0;
  const dirtyCount = ["qty_after_open", "stock_open", "lots_open", "batches_open", "warehouse_open"]
    .reduce((sum, key) => sum + (Number(dirty?.[key]) || 0), 0);
  let ledgerForRun = null;
  let matchedAudit = null;
  let verdict = "rolled_back";

  if (run) {
    ledgerForRun = Number((await db.get(
      `SELECT COUNT(*) AS n FROM inventory_ledger
        WHERE reference_type = 'zero_all_stock' AND reference_id = ?`,
      [run.id]
    ))?.n) || 0;
    matchedAudit = audits.find((row) => row.run_id === Number(run.id)) || null;
    const countsMatch = ledgerForRun === Number(run.stock_movements);
    const auditMatch = Boolean(
      matchedAudit
      && matchedAudit.products_zeroed === Number(run.products_zeroed)
      && matchedAudit.skipped === Number(run.skipped)
      && matchedAudit.stock_movements === Number(run.stock_movements)
    );
    verdict = countsMatch && auditMatch && dirtyCount === 0 ? "committed" : "unresolved";
  } else if (zeroLedgerRows > 0 || audits.length) {
    const legacy = audits.find((row) => row.run_id == null) || null;
    matchedAudit = legacy;
    verdict = legacy && zeroLedgerRows > 0 && dirtyCount === 0 ? "committed" : "unresolved";
  }

  return {
    verdict,
    verdict_ar: verdictCopy(verdict),
    read_only: true,
    observed_at: new Date().toISOString(),
    latest_run: run
      ? {
          id: Number(run.id),
          created_at: run.created_at,
          products_zeroed: Number(run.products_zeroed) || 0,
          skipped: Number(run.skipped) || 0,
          stock_movements: Number(run.stock_movements) || 0,
          depletion_adjustments: Number(run.depletion_adjustments) || 0,
          valuation_rebuilds: Number(run.valuation_rebuilds) || 0,
          depletion_passes: Number(run.depletion_passes) || 0,
          user_id: run.user_id == null ? null : Number(run.user_id),
        }
      : null,
    latest_audit: matchedAudit,
    evidence: {
      zero_ledger_rows: zeroLedgerRows,
      zero_ledger_products: Number(ledger?.products) || 0,
      ledger_rows_for_latest_run: ledgerForRun,
      products_nonzero_stock: Number(company?.products_nonzero_stock) || 0,
      source_lots_nonzero: Number(company?.source_lots_nonzero) || 0,
      batches_nonzero: Number(company?.batches_nonzero) || 0,
      warehouse_batches_nonzero: Number(company?.warehouse_batches_nonzero) || 0,
      qty_after_open: Number(dirty?.qty_after_open) || 0,
      stock_open: Number(dirty?.stock_open) || 0,
      lots_open: Number(dirty?.lots_open) || 0,
      batches_open: Number(dirty?.batches_open) || 0,
      warehouse_open: Number(dirty?.warehouse_open) || 0,
    },
  };
}
