/**
 * Warehouse valuation as of a shop business day.
 *
 * The displayed value is recorded inventory accounting. Movements are applied
 * in posting order. Purchases add the posted line amount. Sales remove
 * unit_cost_at_sale, shop consumption removes line_cost, and supplier returns
 * remove the posted return amount. Other outflows use the cost stored on the
 * ledger row at posting. A later purchase never recalculates an earlier sale.
 *
 * Document date chooses which day a movement belongs to. It does not change
 * the saved outgoing cost. A document-date replay that recomputes outgoing
 * cost is returned only as document_date_estimate and is not the line value.
 * Posted product costs and sale snapshots are not rewritten.
 *
 * When a movement brings quantity to zero, a positive rounding remainder is
 * assigned to that last movement so value is zero. A negative remainder, or a
 * removal that would make value negative while quantity remains, is left
 * unreconciled and is not forced to zero.
 *
 * Completed supplier returns are history, not owned stock. Transfers into
 * returns or damaged locations stay owned.
 */

import { businessDayFromTimestamp } from "./businessDay.js";
import { round2 } from "./money.js";
import { purchaseBaseQty, purchaseLineGross, round6 } from "./purchaseInventoryCost.js";
import { getAppSettings } from "./settings.js";
import { shopYmdFromTimestamp } from "./shopTime.js";
import { classifyBakeryProduct } from "./bakeryMembership.js";
import { resolveBakeryReportCategories } from "../services/bakeryReportService.js";
import {
  loadWarehouses,
  productSearchClause,
  warehouseRoles,
} from "./warehouseInventory.js";

const QTY_EPS = 0.0001;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export const BACKDATED_VALUATION_NOTE_AR =
  "تاريخ المستند ليس لقطة لما كان النظام يعرفه في ذلك اليوم. مستند مرحّل لاحقاً بتاريخ أقدم يغيّر تقرير ذلك التاريخ. القيمة تستخدم التكاليف المحفوظة وقت الترحيل ولا تعيد كتابة المبيعات. تقدير إعادة الترتيب حسب تاريخ المستند، إن وُجد، منفصل عن القيمة المسجّلة.";

export const COSTING_NOTE_AR =
  "قيمة المخزون تجمع قيم الحركات المسجّلة. فرق التقريب عند نفاد الكمية يُحفظ على حركة المخزون الجديدة فقط، ولا يُحسب عند قراءة التقرير ولا يُعاد كتابته على تكلفة بيع قديمة.";

export const HISTORY_GAP_NOTE_AR =
  "بعض الكميات الحالية بلا حركة مخزون تبدأ من صفر، ولم يُفترض لها رصيد افتتاحي أو تكلفة تاريخية. التقييم التاريخي يعرض الحركات الموثقة فقط، والتكلفة غير المعروفة تظهر «غير مكتمل» ولا تُحسب صفراً.";

export const CLASSIFICATION_GAP_NOTE_AR =
  "انتماء المخبز يُؤخذ من نطاق الصنف وتصنيفه المحفوظين مع الحركة. إذا لم تُحفظ تلك البيانات قبل التاريخ، لا يُستخدم تصنيف المنتج الحالي.";

function ymd(value) {
  if (typeof value !== "string") return null;
  const day = value.trim().slice(0, 10);
  return YMD_RE.test(day) ? day : null;
}

function num(value) {
  return Number(value) || 0;
}

export async function shopBusinessToday(db) {
  const settings = await getAppSettings(db);
  return businessDayFromTimestamp(new Date().toISOString(), settings.business_day_cutoff_hour);
}

function emptyWarehouse(warehouse) {
  return {
    warehouse_id: warehouse.id,
    warehouse_name: warehouse.name,
    warehouse_type: warehouse.type,
    total_qty: 0,
    total_value: 0,
    unvalued_count: 0,
  };
}

function finalize(payload) {
  const warehouses = [...payload.warehouseMap.values()].map((row) => ({
    warehouse_id: row.warehouse_id,
    warehouse_name: row.warehouse_name,
    warehouse_type: row.warehouse_type,
    total_qty: row.total_qty,
    total_value: round2(row.total_value),
    unvalued_count: row.unvalued_count,
  }));
  warehouses.sort((a, b) => b.total_value - a.total_value || a.warehouse_id - b.warehouse_id);
  const unexplainedSum = (payload.unexplainedRounding || []).reduce((sum, row) => round2(sum + num(row.amount)), 0);
  const known = round2(warehouses.reduce((sum, row) => round2(sum + num(row.total_value)), 0) + unexplainedSum);
  const unvalued = payload.lines.filter((line) => line.cost_known !== true && Math.abs(num(line.quantity)) > QTY_EPS).length;
  const excluded = payload.excluded || [];
  const unreconciled = payload.unreconciled || [];
  const complete = excluded.length === 0 && unvalued === 0 && payload.unclassified === 0 && unreconciled.length === 0 && (payload.unexplainedRounding || []).length === 0;
  return {
    as_of: payload.asOf,
    as_of_label: payload.label,
    shop_business_day: payload.shopDay,
    valued_as: "recorded_posting",
    costing_method: "recorded_posting",
    document_date_estimate: payload.documentDateEstimate || null,
    unreconciled_products: payload.unreconciled || [],
    rounding_adjustments: payload.roundingAdjustments || [],
    unexplained_rounding: payload.unexplainedRounding || [],
    costing_note: COSTING_NOTE_AR,
    warehouses,
    lines: payload.lines,
    grand_total: complete ? known : null,
    known_subtotal: known,
    valuation_complete: complete,
    unvalued_count: unvalued,
    unexplained_count: excluded.length,
    excluded_products: excluded,
    supplier_returns: payload.supplierReturns || [],
    unclassified_count: payload.unclassified,
    supported_from: payload.supportedFrom,
    history_limited: !complete,
    history_message: [
      excluded.length ? HISTORY_GAP_NOTE_AR : null,
      unreconciled.length
        ? "قيمة مسجّلة لا تتفق مع رصيد المخزون، ولم تُصفَّر تلقائياً. هذه الأصناف غير مكتملة إلى أن تُسوّى بحركة مسجّلة."
        : null,
      (payload.unexplainedRounding || []).length
        ? "بعض فروقات التقريب غير محفوظة على حركة مخزون. تُعرض للبيان ولا تُعامل كتسوية مسجّلة."
        : null,
    ].filter(Boolean).join(" ") || null,
    classification_message: CLASSIFICATION_GAP_NOTE_AR,
    backdated_note: BACKDATED_VALUATION_NOTE_AR,
    read_only: true,
  };
}

function pushLine(state, warehouse, product, quantity, unitCost, value, costKnown) {
  if (!warehouse || Math.abs(quantity) <= QTY_EPS) return;
  const bucket = state.warehouseMap.get(Number(warehouse.id));
  if (!bucket) return;
  bucket.total_qty += quantity;
  if (costKnown) bucket.total_value = round2(bucket.total_value + num(value));
  else bucket.unvalued_count += 1;
  state.lines.push({
    warehouse_id: warehouse.id,
    warehouse_name: warehouse.name,
    warehouse_type: warehouse.type,
    product_id: product.id,
    product_name: product.name,
    barcode: product.barcode,
    sku: product.sku,
    quantity,
    unit_cost: costKnown ? unitCost : null,
    value: costKnown ? round2(num(value)) : null,
    cost_known: costKnown,
    as_of: state.asOf,
    as_of_label: state.label,
  });
}

function queueKey(docId, productId) {
  return `${Number(docId)}:${Number(productId)}`;
}

function takeQueued(queues, docId, productId) {
  const list = queues.get(queueKey(docId, productId));
  if (!list || !list.length) return null;
  return list.shift();
}

async function loadCostQueues(db) {
  const purchases = await db.all(
    `SELECT i.id, i.invoice_id, i.product_id, i.quantity, i.base_quantity, i.line_total, i.total_cost, i.unit_cost
       FROM purchase_invoice_items i
       JOIN purchase_invoices inv ON inv.id = i.invoice_id
      WHERE inv.status = 'posted'
      ORDER BY i.id`
  );
  const returns = await db.all(
    `SELECT i.id, i.return_id, i.product_id, i.quantity, i.base_quantity, i.line_total, i.total_cost, i.unit_cost
       FROM purchase_return_items i
       JOIN purchase_returns r ON r.id = i.return_id
      WHERE r.status = 'posted'
      ORDER BY i.id`
  );
  const purchaseQueues = new Map();
  for (const row of purchases) {
    const key = queueKey(row.invoice_id, row.product_id);
    const list = purchaseQueues.get(key) || [];
    list.push({
      qty: purchaseBaseQty(row),
      value: round2(purchaseLineGross(row)),
    });
    purchaseQueues.set(key, list);
  }
  const returnQueues = new Map();
  for (const row of returns) {
    const key = queueKey(row.return_id, row.product_id);
    const list = returnQueues.get(key) || [];
    list.push({
      qty: purchaseBaseQty(row),
      value: round2(purchaseLineGross(row)),
    });
    returnQueues.set(key, list);
  }
  return { purchaseQueues, returnQueues };
}

async function loadAttributionMaps(db) {
  const [invoices, returns, adjustments, documents, consumptions, sales, refunds, transfers] = await Promise.all([
    db.all("SELECT id, invoice_date AS day FROM purchase_invoices"),
    db.all("SELECT id, return_date AS day FROM purchase_returns"),
    db.all("SELECT id, adjustment_date AS day FROM stock_adjustments"),
    db.all("SELECT id, document_date AS day FROM inventory_documents"),
    db.all("SELECT id, business_day AS day FROM shop_consumptions"),
    db.all(
      `SELECT t.id, COALESCE(cs.business_day, t.business_day) AS day
         FROM transactions t
         LEFT JOIN cashier_shifts cs ON cs.id = t.shift_id`
    ),
    db.all(
      `SELECT r.id, COALESCE(r.business_day, cs.business_day) AS day
         FROM refunds r
         LEFT JOIN cashier_shifts cs ON cs.id = r.shift_id`
    ),
    db.all("SELECT id, transfer_date AS day FROM warehouse_transfers"),
  ]);
  const toMap = (rows) => new Map(rows.map((row) => [Number(row.id), ymd(row.day)]));
  return {
    purchase_invoice: toMap(invoices),
    purchase_return: toMap(returns),
    stock_adjustment: toMap(adjustments),
    inventory_receipt: toMap(documents),
    inventory_issue: toMap(documents),
    shop_consumption: toMap(consumptions),
    transaction: toMap(sales),
    refund: toMap(refunds),
    warehouse_transfer: toMap(transfers),
  };
}

function attributionDay(row, maps) {
  const stored = ymd(row.business_day);
  if (stored) return stored;
  const ref = maps[row.reference_type]?.get(Number(row.reference_id)) || null;
  if (ref) return ref;
  return shopYmdFromTimestamp(row.created_at);
}

async function loadRecordedMoney(db) {
  const [sales, refunds, consumptions] = await Promise.all([
    db.all(
      `SELECT transaction_id, product_id, unit_cost_at_sale, quantity
         FROM transaction_items
        ORDER BY id`
    ),
    db.all(
      `SELECT r.id AS refund_id, ti.product_id, ti.unit_cost_at_sale
         FROM refunds r
         JOIN transaction_items ti ON ti.transaction_id = r.original_transaction_id
        ORDER BY r.id, ti.id`
    ),
    db.all(
      `SELECT consumption_id, product_id, line_cost
         FROM shop_consumption_items
        ORDER BY id`
    ),
  ]);
  const saleQueues = new Map();
  for (const row of sales) {
    const key = queueKey(row.transaction_id, row.product_id);
    const list = saleQueues.get(key) || [];
    list.push(row.unit_cost_at_sale == null ? null : round2(num(row.unit_cost_at_sale) * num(row.quantity)));
    saleQueues.set(key, list);
  }
  const refundQueues = new Map();
  for (const row of refunds) {
    const key = queueKey(row.refund_id, row.product_id);
    const list = refundQueues.get(key) || [];
    list.push(row.unit_cost_at_sale == null ? null : num(row.unit_cost_at_sale));
    refundQueues.set(key, list);
  }
  const consumptionQueues = new Map();
  for (const row of consumptions) {
    const key = queueKey(row.consumption_id, row.product_id);
    const list = consumptionQueues.get(key) || [];
    list.push(round2(num(row.line_cost)));
    consumptionQueues.set(key, list);
  }
  return { saleQueues, refundQueues, consumptionQueues };
}

function snapshotRemoval(row, recorded) {
  const qty = Math.abs(num(row.quantity_delta));
  if (row.movement_type === "sale") {
    const saved = takeQueued(recorded.saleQueues, row.reference_id, row.product_id);
    return saved == null ? null : round2(saved);
  }
  if (row.movement_type === "supplier_return") {
    const saved = takeQueued(recorded.returnQueues, row.reference_id, row.product_id);
    return saved ? round2(saved.value) : null;
  }
  if (row.reference_type === "shop_consumption") {
    const saved = takeQueued(recorded.consumptionQueues, row.reference_id, row.product_id);
    return saved == null ? null : round2(saved);
  }
  if (row.cost_known === 0 || row.cost_known === null || row.unit_cost_after == null) return null;
  return round2(qty * num(row.unit_cost_after));
}

function applyRecordedOutbound(state, snapshotMoney, delta) {
  const nextQty = state.qty + delta;
  if (snapshotMoney == null || !state.known || state.value == null) {
    state.known = false;
    state.value = null;
    state.qty = nextQty;
    return;
  }
  if (Math.abs(nextQty) <= QTY_EPS) {
    const remainder = round2(state.value - snapshotMoney);
    if (remainder < -0.001) {
      state.unreconciled = true;
      state.known = false;
      state.value = null;
      state.qty = 0;
      return;
    }
    state.value = remainder;
    state.qty = 0;
    return;
  }
  const nextValue = round2(state.value - snapshotMoney);
  if (nextValue < -0.001) {
    state.unreconciled = true;
    state.known = false;
    state.value = null;
    state.qty = nextQty;
    return;
  }
  state.value = nextValue;
  state.qty = nextQty;
}

function matchesCatalog(product, options, categoryNames) {
  const bakery = String(options.membership || "").toLowerCase() === "bakery";
  const snapshot = {
    inventory_scope: product.snapshot_scope,
    category: product.snapshot_category,
  };
  if (snapshot.inventory_scope == null && snapshot.category == null) return "unclassified";
  const names = new Set(categoryNames);
  const inBakery = classifyBakeryProduct(snapshot, names).workspace;
  if (bakery) return inBakery ? "in" : "out";
  return inBakery ? "out" : "in";
}

function matchesSearch(product, query) {
  const clause = productSearchClause("", query);
  if (!clause.sql) return true;
  const term = String(query || "").trim().toLowerCase();
  const name = String(product.name || "").toLowerCase();
  const barcode = String(product.barcode || "");
  const sku = String(product.sku || "");
  return name.includes(term) || barcode.includes(term) || sku.toLowerCase().includes(term);
}

export async function buildHistoricalWarehouseValuation(db, options, asOf, shopDay, label = asOf) {
  const warehouses = await loadWarehouses(db);
  const roles = warehouseRoles(warehouses);
  const [products, ledger, queues, maps, transfers, returnLines, bakery, recordedMoney] = await Promise.all([
    db.all(
      `SELECT id, name, barcode, sku, stock, cost, cost_known,
              COALESCE(inventory_scope, 'retail') AS inventory_scope, category, is_active
         FROM products`
    ),
    db.all(
      `SELECT id, product_id, movement_type, quantity_delta, qty_before, reference_type, reference_id,
              created_at, business_day, inventory_scope, category, cost_known, unit_cost_after, value_adjustment
         FROM inventory_ledger
        ORDER BY id`
    ),
    loadCostQueues(db),
    loadAttributionMaps(db),
    db.all(
      `SELECT t.transfer_date, t.from_warehouse_id, t.to_warehouse_id, i.product_id, i.quantity
         FROM warehouse_transfers t
         JOIN warehouse_transfer_items i ON i.transfer_id = t.id
        WHERE t.status = 'posted'`
    ),
    db.all(
      `SELECT pr.return_date, pri.product_id,
              COALESCE(pri.base_quantity, pri.quantity) AS quantity,
              COALESCE(pri.line_total, pri.total_cost, 0) AS value
         FROM purchase_return_items pri
         JOIN purchase_returns pr ON pr.id = pri.return_id
        WHERE pr.status = 'posted'`
    ),
    resolveBakeryReportCategories(db),
    loadRecordedMoney(db),
  ]);
  recordedMoney.returnQueues = queues.returnQueues;
  const categoryNames = (bakery.categories || []).map((row) => String(row.name || "").trim()).filter(Boolean);
  const productById = new Map(products.map((row) => [Number(row.id), { ...row, snapshot_scope: null, snapshot_category: null }]));
  const movements = ledger.map((row) => ({ ...row, day: attributionDay(row, maps) }));
  const byProduct = new Map();
  for (const row of movements) {
    const list = byProduct.get(Number(row.product_id)) || [];
    list.push(row);
    byProduct.set(Number(row.product_id), list);
  }

  const ledgerSum = new Map();
  for (const row of ledger) {
    ledgerSum.set(Number(row.product_id), num(ledgerSum.get(Number(row.product_id))) + num(row.quantity_delta));
  }

  const excluded = [];
  const unreconciled = [];
  const roundingAdjustments = [];
  const unexplainedRounding = [];
  const replay = new Map();
  const estimateQueues = {
    purchaseQueues: new Map([...queues.purchaseQueues.entries()].map(([key, list]) => [key, [...list]])),
    returnQueues: new Map([...queues.returnQueues.entries()].map(([key, list]) => [key, [...list]])),
  };
  const estimates = [];
  for (const product of productById.values()) {
    const pid = Number(product.id);
    const rows = byProduct.get(pid) || [];
    const first = rows[0];
    const explained = rows.length > 0 && Math.abs(num(first.qty_before)) <= QTY_EPS;
    const cacheGap = Math.abs(num(product.stock) - num(ledgerSum.get(pid))) > QTY_EPS;
    const onHand = Math.abs(num(product.stock)) > QTY_EPS || rows.length > 0;
    if (!explained || cacheGap) {
      if (onHand) {
        excluded.push({
          product_id: pid,
          product_name: product.name,
          stock: num(product.stock),
          reason: !explained ? "no_opening_history" : "stock_differs_from_ledger",
        });
      }
      continue;
    }
    const state = { qty: 0, value: 0, unit: null, known: false, rounding_remainder: 0, unreconciled: false };
    const posted = [...rows].sort((a, b) => a.id - b.id);
    for (const row of posted) {
      if (!row.day || row.day > asOf) continue;
      if (row.inventory_scope != null || row.category != null) {
        product.snapshot_scope = row.inventory_scope != null ? String(row.inventory_scope) : product.snapshot_scope;
        product.snapshot_category = row.category != null ? String(row.category) : product.snapshot_category;
      }
      const delta = num(row.quantity_delta);
      if (row.movement_type === "purchase_receive") {
        const inbound = takeQueued(queues.purchaseQueues, row.reference_id, pid);
        if (!inbound || (state.qty > QTY_EPS && !state.known)) {
          state.known = false;
          state.value = null;
        } else {
          state.value = round2((state.known ? state.value : 0) + inbound.value);
          state.known = true;
        }
        state.qty += delta;
      } else if (row.movement_type === "refund") {
        const unit = takeQueued(recordedMoney.refundQueues, row.reference_id, pid);
        if (unit == null || !state.known || state.value == null) {
          state.known = false;
          state.value = null;
        } else {
          state.value = round2(state.value + round2(Math.abs(delta) * unit));
        }
        state.qty += delta;
      } else if (delta < 0) {
        applyRecordedOutbound(state, snapshotRemoval(row, recordedMoney), delta);
      } else if (!state.known || state.value == null) {
        state.qty += delta;
      } else if (row.unit_cost_after == null || row.cost_known === 0) {
        state.known = false;
        state.value = null;
        state.qty += delta;
      } else {
        state.value = round2(state.value + round2(delta * num(row.unit_cost_after)));
        state.qty += delta;
      }
      if (state.known && state.value != null && row.value_adjustment != null && row.value_adjustment !== "") {
        state.value = round2(state.value + num(row.value_adjustment));
        state.persisted_adjustment = round2((state.persisted_adjustment || 0) + num(row.value_adjustment));
      }
      if (state.known && state.value != null && Math.abs(state.qty) > QTY_EPS) {
        state.unit = state.value / state.qty;
      }
    }
    for (const row of posted) {
      if (row.value_adjustment == null || row.value_adjustment === "") continue;
      roundingAdjustments.push({
        product_id: pid,
        product_name: product.name,
        ledger_id: row.id,
        amount: num(row.value_adjustment),
        recorded: true,
        note: "فرق تقريب محفوظ على حركة المخزون",
      });
    }
    if (state.known && state.value != null && Math.abs(state.qty) <= QTY_EPS && Math.abs(state.value) > 0.001 && !state.persisted_adjustment) {
      unexplainedRounding.push({
        product_id: pid,
        product_name: product.name,
        amount: state.value,
        note: "فرق تقريب غير محفوظ على حركة. ليس تسوية مسجّلة.",
      });
    }
    if (state.unreconciled) {
      unreconciled.push({
        product_id: pid,
        product_name: product.name,
        quantity: state.qty,
        reason: "recorded_value_disagrees",
      });
      continue;
    }
    const estimate = { qty: 0, value: 0, known: false };
    const byDocument = [...rows].sort((a, b) => String(a.day).localeCompare(String(b.day)) || a.id - b.id);
    for (const row of byDocument) {
      if (!row.day || row.day > asOf) continue;
      const delta = num(row.quantity_delta);
      if (row.movement_type === "purchase_receive") {
        const inbound = takeQueued(estimateQueues.purchaseQueues, row.reference_id, pid);
        if (!inbound || (estimate.qty > QTY_EPS && !estimate.known)) {
          estimate.known = false;
          estimate.value = null;
        } else {
          estimate.value = round2((estimate.known ? estimate.value : 0) + inbound.value);
          estimate.known = true;
        }
        estimate.qty += delta;
      } else if (!estimate.known || estimate.value == null) {
        estimate.qty += delta;
      } else {
        const unit = Math.abs(estimate.qty) > QTY_EPS ? estimate.value / estimate.qty : 0;
        estimate.value = round2(estimate.value + round2(delta * unit));
        estimate.qty += delta;
      }
    }
    if (
      estimate.known &&
      state.known &&
      state.value != null &&
      estimate.value != null &&
      Math.abs(estimate.value - state.value) > 0.001
    ) {
      estimates.push({
        product_id: pid,
        product_name: product.name,
        recorded_value: state.value,
        estimate_value: estimate.value,
        label: "تقدير تاريخ المستند",
      });
    }
    replay.set(pid, state);
  }

  const transferNet = new Map();
  for (const row of transfers) {
    const day = ymd(row.transfer_date);
    if (!day || day > asOf) continue;
    const pid = Number(row.product_id);
    const qty = num(row.quantity);
    const add = (warehouseId, delta) => {
      const key = `${Number(warehouseId)}:${pid}`;
      transferNet.set(key, num(transferNet.get(key)) + delta);
    };
    add(row.from_warehouse_id, -qty);
    add(row.to_warehouse_id, qty);
  }
  const supplierReturns = [];
  for (const row of returnLines) {
    const day = ymd(row.return_date);
    if (!day || day > asOf) continue;
    const product = productById.get(Number(row.product_id));
    supplierReturns.push({
      product_id: Number(row.product_id),
      product_name: product?.name || "",
      quantity: num(row.quantity),
      value: round2(num(row.value)),
      return_date: day,
      owned: false,
    });
  }

  const state = {
    asOf,
    label,
    shopDay,
    warehouseMap: new Map(warehouses.map((w) => [Number(w.id), emptyWarehouse(w)])),
    lines: [],
    excluded,
    unreconciled,
    roundingAdjustments,
    unexplainedRounding,
    documentDateEstimate: estimates.length
      ? {
          label: "تقدير تاريخ المستند",
          note: "هذا تقدير يعيد ترتيب الحركات حسب تاريخ المستند ويعيد حساب الخروج من الرصيد الجاري. ليس قيمة المخزون المسجّلة.",
          lines: estimates,
        }
      : null,
    unclassified: 0,
    supportedFrom: null,
    supplierReturns,
  };
  const supported = await db.get(
    `SELECT MIN(business_day) AS day FROM inventory_ledger WHERE cost_known IS NOT NULL`
  );
  state.supportedFrom = ymd(supported?.day);

  for (const [pid, position] of replay) {
    const product = productById.get(pid);
    if (!product || !matchesSearch(product, options.q)) continue;
    const membership = matchesCatalog(product, options, categoryNames);
    if (membership === "unclassified") {
      if (Math.abs(position.qty) > QTY_EPS) state.unclassified += 1;
      continue;
    }
    if (membership === "out") continue;

    let outside = 0;
    if (roles.main) {
      for (const warehouse of warehouses) {
        if (Number(warehouse.id) === Number(roles.main.id)) continue;
        outside += num(transferNet.get(`${Number(warehouse.id)}:${pid}`));
      }
    }
    const known = position.known === true && position.value != null;
    const parts = [];
    if (roles.main) parts.push({ warehouse: roles.main, qty: position.qty - outside });
    for (const warehouse of warehouses) {
      if (roles.main && Number(warehouse.id) === Number(roles.main.id)) continue;
      parts.push({ warehouse, qty: num(transferNet.get(`${Number(warehouse.id)}:${pid}`)) });
    }
    const ownedQty = parts.reduce((sum, part) => sum + part.qty, 0);
    let assigned = 0;
    const visible = parts.filter((part) => Math.abs(part.qty) > QTY_EPS);
    visible.forEach((part, index) => {
      const last = index === visible.length - 1;
      const share = !known
        ? null
        : last
          ? round2(position.value - assigned)
          : round2(position.value * (part.qty / (ownedQty || part.qty)));
      if (known && !last) assigned = round2(assigned + share);
      const unit = known && Math.abs(part.qty) > QTY_EPS ? round6(share / part.qty) : null;
      pushLine(state, part.warehouse, product, part.qty, unit, share, known);
    });
  }

  state.lines.sort((a, b) => String(a.warehouse_name).localeCompare(String(b.warehouse_name), "ar") || String(a.product_name).localeCompare(String(b.product_name), "ar"));
  return finalize(state);
}

export async function syncDepletionAdjustment(db, { productId, ledgerId, qtyBefore, qtyAfter, movementType }) {
  const pid = Number(productId);
  const id = Number(ledgerId);
  if (!pid || !id) return;
  if (Math.abs(qtyAfter) <= QTY_EPS) {
    const report = await buildHistoricalWarehouseValuation(db, {}, "9999-12-31", "9999-12-31", "9999-12-31");
    const gap = (report.unexplained_rounding || []).find((row) => Number(row.product_id) === pid);
    if (!gap || !(Number(gap.amount) > 0.001)) return;
    await db.run(
      `UPDATE inventory_ledger SET value_adjustment = ? WHERE id = ? AND value_adjustment IS NULL`,
      [round2(-Number(gap.amount)), id]
    );
    return;
  }
  if (movementType === "refund" && Math.abs(qtyBefore) <= QTY_EPS && qtyAfter > QTY_EPS) {
    const open = await db.get(
      `SELECT COALESCE(SUM(value_adjustment), 0) AS total
         FROM inventory_ledger WHERE product_id = ? AND id != ?`,
      [pid, id]
    );
    const outstanding = round2(num(open?.total));
    if (Math.abs(outstanding) <= 0.001) return;
    await db.run(
      `UPDATE inventory_ledger SET value_adjustment = ? WHERE id = ? AND value_adjustment IS NULL`,
      [round2(-outstanding), id]
    );
  }
}

export async function getWarehouseValuationReport(db, options = {}) {
  const shopDay = await shopBusinessToday(db);
  const requested = options.asOf != null ? String(options.asOf).trim() : "";
  const day = !requested || requested === shopDay ? shopDay : ymd(requested);
  if (!day) return { error: "التاريخ يجب أن يكون بصيغة YYYY-MM-DD", status: 400 };
  if (day > shopDay) return { error: "لا يمكن تقييم تاريخ لاحق", status: 400 };
  const label = day === shopDay ? "حتى الآن" : day;
  return buildHistoricalWarehouseValuation(db, options, day, shopDay, label);
}
