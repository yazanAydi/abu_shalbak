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
 *
 * Grouping uses the product's current category (التصنيف الحالي). A later
 * category edit changes how older dates are grouped. It does not change
 * quantities, posted costs, or ledger rows. A product with no current
 * category is غير مصنف and its known value stays in the total.
 *
 * Valuation totals are owned by inventory scope, not by category, warehouse,
 * or where the product was sold. Retail scope stays in the supermarket total
 * even when the current category is a bakery sales category. Bakery scope
 * stays in the bakery total. The bakery report may also list those retail
 * bakery products, labeled as outside the bakery total.
 *
 * A selected date is a shop business day (Asia/Hebron, business_day_cutoff_hour).
 * It includes movements whose effective inventory date is on or before that
 * day. Sales keep the stored shift business day. A purchase, purchase return,
 * or transfer whose document date is the posting calendar date uses the
 * business day of the posting instant, so a post before the cutoff stays on
 * that business day in both the live view and the replay. The document date
 * is not rewritten. The live business day does not include a movement whose
 * inventory date is still after that day.
 */

import { businessDayFromTimestamp, effectiveInventoryDay } from "./businessDay.js";
import { round2 } from "./money.js";
import { purchaseBaseQty, purchaseLineGross, round6 } from "./purchaseInventoryCost.js";
import { getAppSettings } from "./settings.js";
import { shopYmdFromTimestamp } from "./shopTime.js";
import { classifyBakeryProduct } from "./bakeryMembership.js";
import { resolveBakeryReportCategories } from "../services/bakeryReportService.js";
import { isProductCostKnown } from "./productUnits.js";
import {
  catalogStockLines,
  loadWarehouses,
  postedPurchaseReturnLines,
  productSearchClause,
  quantitiesOutsideMain,
  resolveWarehouseCatalog,
  transferStockLines,
  warehouseRoles,
} from "./warehouseInventory.js";

const QTY_EPS = 0.0001;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export const CURRENT_BASIS = "current_inventory_cost";
export const RECORDED_BASIS = "recorded_posting";
export const CURRENT_BASIS_LABEL_AR = "القيمة الحالية حسب تكلفة المخزون";
export const RECORDED_BASIS_LABEL_AR = "التقييم حسب الحركات المسجّلة";
export const PARTIAL_VALUATION_AR = "التقييم جزئي: بعض الأصناف لا تتوفر لها بيانات كافية لهذا التاريخ.";
export const UNAVAILABLE_VALUATION_AR = "لا تتوفر بيانات كافية للتقييم";
export const UNKNOWN_COST_AR = "التكلفة غير محددة";
export const CURRENT_UNKNOWN_COST_AR = "بعض الأصناف تكلفتها غير محددة ولا تدخل في المجموع.";
export const CURRENT_CATEGORY_LABEL_AR = "التصنيف الحالي";
export const UNCATEGORIZED_CATEGORY_AR = "غير مصنف";
export const CURRENT_CATEGORY_NOTE_AR =
  "التجميع حسب التصنيف الحالي للمنتج. تغيير التصنيف لاحقاً يغيّر تجميع تقارير التواريخ السابقة، دون تغيير الكميات أو قيم التكلفة.";
export const KNOWN_VALUE_LABEL_AR = "القيمة المعروفة";
export const KNOWN_VALUE_INCOMPLETE_AR =
  "التقييم غير مكتمل: القيمة المعروفة لا تشمل مخزوناً تكلفته غير محددة.";
export const SCOPE_OWNERSHIP_NOTE_AR =
  "مجموع التقييم يتبع نطاق المخزون. التصنيف الحالي للتجميع فقط، والمستودع ومكان البيع لا ينقلان ملكية المجموع.";
export const CROSS_SCOPE_LABEL_AR =
  "نطاق سوبرماركت — معروض ضمن تصنيف المخبز وغير داخل في مجموع المخبز";
export const CROSS_SCOPE_NOTE_AR =
  "أصناف نطاقها سوبرماركت وتصنيفها الحالي من تصنيفات المخبز تظهر هنا للبيان. قيمتها داخل مجموع السوبرماركت مرة واحدة، وليست داخل مجموع المخبز.";
export const VALUATION_DATE_RULE_AR =
  "التاريخ يوم عمل في Asia/Hebron حسب ساعة بداية اليوم. يشمل الحركات التي تاريخ مخزونها في ذلك اليوم أو قبله. بيع يحفظ يوم الوردية. شراء أو تحويل تاريخ مستنده هو يوم التقويم لحظة الترحيل يُنسب إلى يوم العمل، فيدخل ما رُحّل قبل ساعة البداية في يوم العمل السابق ويبقى ظاهراً في العرض الحي وفي إعادة الحركة. تاريخ الفاتورة وتاريخ التحويل لا يُعاد كتابتهما.";

const REASON_AR = {
  no_opening_history: "لا توجد حركة افتتاحية موثّقة",
  stock_differs_from_ledger: "كمية المخزون لا تطابق سجل الحركات",
  recorded_value_disagrees: "القيمة المسجّلة لا تطابق الكمية",
  unknown_cost: UNKNOWN_COST_AR,
};

const WAREHOUSE_TYPE_ORDER = { main: 0, store: 1, returns: 2, damaged: 3 };

function currentCategoryClassification() {
  return {
    mode: "current_product_category",
    historical_category_snapshot: false,
    label: CURRENT_CATEGORY_LABEL_AR,
    uncategorized_label: UNCATEGORIZED_CATEGORY_AR,
    note: CURRENT_CATEGORY_NOTE_AR,
  };
}

function currentCategoryName(category) {
  const name = String(category ?? "").trim();
  return name || null;
}

function categoryFields(category) {
  const category_name = currentCategoryName(category);
  return {
    category_name,
    category_label: category_name || UNCATEGORIZED_CATEGORY_AR,
    grouping_label: CURRENT_CATEGORY_LABEL_AR,
  };
}

function compareValuationLines(a, b) {
  const aBare = !a.category_name;
  const bBare = !b.category_name;
  if (aBare !== bBare) return aBare ? 1 : -1;
  if (!aBare) {
    const byCat = String(a.category_label).localeCompare(String(b.category_label), "ar");
    if (byCat !== 0) return byCat;
  }
  const typeA = WAREHOUSE_TYPE_ORDER[a.warehouse_type] ?? 9;
  const typeB = WAREHOUSE_TYPE_ORDER[b.warehouse_type] ?? 9;
  if (typeA !== typeB) return typeA - typeB;
  const byWh = String(a.warehouse_name || "").localeCompare(String(b.warehouse_name || ""), "ar");
  if (byWh !== 0) return byWh;
  return String(a.product_name || "").localeCompare(String(b.product_name || ""), "ar");
}

function isOwnedLine(line) {
  return line?.ownership !== "cross_scope" && line?.included_in_catalog_total !== false;
}

function scopeOf(product) {
  return String(product?.inventory_scope || "retail") === "bakery" ? "bakery" : "retail";
}

function scopeOwnership(product, options, categoryNames) {
  const scope = scopeOf(product);
  const bakeryView = String(options?.membership || "").toLowerCase() === "bakery";
  const workspace = classifyBakeryProduct(
    { inventory_scope: product?.inventory_scope, category: product?.category },
    new Set(categoryNames || [])
  ).workspace;
  if (!bakeryView) {
    if (scope !== "retail") return null;
    return { ownership: "owned", included_in_catalog_total: true, cross_scope_label: null };
  }
  if (scope === "bakery") {
    return { ownership: "owned", included_in_catalog_total: true, cross_scope_label: null };
  }
  if (workspace) {
    return { ownership: "cross_scope", included_in_catalog_total: false, cross_scope_label: CROSS_SCOPE_LABEL_AR };
  }
  return null;
}

function buildCategoryGroups(lines) {
  const groups = [];
  const byKey = new Map();
  for (const line of lines) {
    const key = line.category_name || "";
    let group = byKey.get(key);
    if (!group) {
      group = {
        category_name: line.category_name || null,
        category_label: line.category_label || UNCATEGORIZED_CATEGORY_AR,
        grouping_label: line.grouping_label || CURRENT_CATEGORY_LABEL_AR,
        lines: [],
        total_qty: 0,
        known_value: 0,
        valued_count: 0,
        unvalued_count: 0,
        cross_scope_qty: 0,
        cross_scope_known_value: 0,
        cross_scope_valued_count: 0,
        cross_scope_unvalued_count: 0,
        warehouseMap: new Map(),
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.lines.push(line);
    const valued = line.cost_known === true && line.value != null && Math.abs(num(line.quantity)) > QTY_EPS;
    const unvalued = line.cost_known !== true && Math.abs(num(line.quantity)) > QTY_EPS;
    const owned = isOwnedLine(line);
    if (owned) {
      group.total_qty += num(line.quantity);
      if (valued) {
        group.known_value = round2(group.known_value + num(line.value));
        group.valued_count += 1;
      } else if (unvalued) group.unvalued_count += 1;
    } else {
      group.cross_scope_qty += num(line.quantity);
      if (valued) {
        group.cross_scope_known_value = round2(group.cross_scope_known_value + num(line.value));
        group.cross_scope_valued_count += 1;
      } else if (unvalued) group.cross_scope_unvalued_count += 1;
    }
    if (!owned) continue;
    const whKey = Number(line.warehouse_id);
    let wh = group.warehouseMap.get(whKey);
    if (!wh) {
      wh = {
        warehouse_id: line.warehouse_id,
        warehouse_name: line.warehouse_name,
        warehouse_type: line.warehouse_type || null,
        total_qty: 0,
        known_value: 0,
        valued_count: 0,
        unvalued_count: 0,
      };
      group.warehouseMap.set(whKey, wh);
    }
    wh.total_qty += num(line.quantity);
    if (valued) {
      wh.known_value = round2(wh.known_value + num(line.value));
      wh.valued_count += 1;
    } else if (unvalued) wh.unvalued_count += 1;
  }
  return groups.map((group) => {
    const knownValue = group.valued_count ? round2(group.known_value) : null;
    const showKnownLabel = (group.unvalued_count > 0 || group.cross_scope_unvalued_count > 0) && knownValue != null;
    return {
      category_name: group.category_name,
      category_label: group.category_label,
      grouping_label: group.grouping_label,
      total_qty: group.total_qty,
      known_value: knownValue,
      money_label: showKnownLabel ? KNOWN_VALUE_LABEL_AR : null,
      unvalued_count: group.unvalued_count,
      cross_scope_qty: group.cross_scope_qty,
      cross_scope_known_value: group.cross_scope_valued_count ? round2(group.cross_scope_known_value) : null,
      cross_scope_unvalued_count: group.cross_scope_unvalued_count,
      warehouses: [...group.warehouseMap.values()].map((wh) => {
        const whKnown = wh.valued_count ? round2(wh.known_value) : null;
        return {
          warehouse_id: wh.warehouse_id,
          warehouse_name: wh.warehouse_name,
          warehouse_type: wh.warehouse_type,
          total_qty: wh.total_qty,
          known_value: whKnown,
          money_label: wh.unvalued_count > 0 && whKnown != null ? KNOWN_VALUE_LABEL_AR : null,
          unvalued_count: wh.unvalued_count,
        };
      }),
      lines: group.lines,
    };
  });
}

export const BACKDATED_VALUATION_NOTE_AR =
  "تاريخ المستند ليس لقطة لما كان النظام يعرفه في ذلك اليوم. مستند مرحّل لاحقاً بتاريخ أقدم يغيّر تقرير ذلك التاريخ. القيمة تستخدم التكاليف المحفوظة وقت الترحيل ولا تعيد كتابة المبيعات. تقدير إعادة الترتيب حسب تاريخ المستند، إن وُجد، منفصل عن القيمة المسجّلة.";

export const COSTING_NOTE_AR =
  "قيمة المخزون تجمع قيم الحركات المسجّلة. فرق التقريب عند نفاد الكمية يُحفظ على حركة المخزون الجديدة فقط، ولا يُحسب عند قراءة التقرير ولا يُعاد كتابته على تكلفة بيع قديمة.";

export const HISTORY_GAP_NOTE_AR =
  "بعض الكميات الحالية بلا حركة مخزون تبدأ من صفر، ولم يُفترض لها رصيد افتتاحي أو تكلفة تاريخية. التقييم التاريخي يعرض الحركات الموثقة فقط، والتكلفة غير المعروفة تظهر «غير مكتمل» ولا تُحسب صفراً.";

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

function decorateValuation(report) {
  const lines = report.lines || [];
  const unvalued = lines.filter((line) => line.cost_known !== true && Math.abs(num(line.quantity)) > QTY_EPS).length;
  const cross = lines.filter((line) => line.ownership === "cross_scope");
  const crossValued = cross.filter((line) => line.cost_known === true && line.value != null && Math.abs(num(line.quantity)) > QTY_EPS);
  report.unvalued_count = unvalued;
  report.cross_scope_count = cross.length;
  report.cross_scope_known_value = crossValued.length
    ? round2(crossValued.reduce((sum, line) => round2(sum + num(line.value)), 0))
    : null;
  report.cross_scope_note = cross.length ? CROSS_SCOPE_NOTE_AR : null;
  report.ownership_note = SCOPE_OWNERSHIP_NOTE_AR;
  report.date_rule = VALUATION_DATE_RULE_AR;
  if (unvalued > 0 && report.status !== "empty" && report.status !== "unavailable") {
    report.status = "partial";
    report.valuation_complete = false;
    report.grand_total = null;
    report.history_limited = true;
    report.money_label = report.known_subtotal != null ? KNOWN_VALUE_LABEL_AR : null;
    report.status_message = KNOWN_VALUE_INCOMPLETE_AR;
  } else if (!report.money_label) {
    report.money_label = null;
  }
  return report;
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
  const complete = excluded.length === 0 && unvalued === 0 && unreconciled.length === 0 && (payload.unexplainedRounding || []).length === 0;
  const valuedCount = payload.lines.filter((line) => line.cost_known === true && Math.abs(num(line.quantity)) > QTY_EPS).length;
  const quantityKnown = payload.lines.length > 0;
  const nothingHeld = !quantityKnown && excluded.length === 0 && unreconciled.length === 0;
  let status = "complete";
  let statusMessage = null;
  let knownSubtotal = valuedCount > 0 ? known : null;
  if (nothingHeld) {
    status = "empty";
    statusMessage = "لا يوجد مخزون في هذا التاريخ";
    knownSubtotal = 0;
  } else if (!quantityKnown) {
    status = "unavailable";
    statusMessage = UNAVAILABLE_VALUATION_AR;
    knownSubtotal = null;
  } else if (!complete) {
    status = "partial";
    statusMessage = PARTIAL_VALUATION_AR;
  }
  return decorateValuation({
    as_of: payload.asOf,
    as_of_label: payload.label,
    shop_business_day: payload.shopDay,
    basis: RECORDED_BASIS,
    basis_label: RECORDED_BASIS_LABEL_AR,
    status,
    status_message: statusMessage,
    valued_as: RECORDED_BASIS,
    costing_method: RECORDED_BASIS,
    document_date_estimate: payload.documentDateEstimate || null,
    unreconciled_products: payload.unreconciled || [],
    rounding_adjustments: payload.roundingAdjustments || [],
    unexplained_rounding: payload.unexplainedRounding || [],
    costing_note: COSTING_NOTE_AR,
    warehouses,
    lines: payload.lines,
    category_groups: buildCategoryGroups(payload.lines),
    classification: currentCategoryClassification(),
    unclassified_lines: [],
    grand_total: complete ? known : null,
    known_subtotal: knownSubtotal,
    valuation_complete: complete,
    unvalued_count: unvalued,
    unexplained_count: excluded.length,
    excluded_products: excluded,
    supplier_returns: payload.supplierReturns || [],
    unclassified_count: 0,
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
    classification_message: CURRENT_CATEGORY_NOTE_AR,
    backdated_note: BACKDATED_VALUATION_NOTE_AR,
    read_only: true,
  });
}

function appendOwnedLines(state, product, position, roles, warehouses, transferNet, ownership) {
  let outside = 0;
  if (roles.main) {
    for (const warehouse of warehouses) {
      if (Number(warehouse.id) === Number(roles.main.id)) continue;
      outside += num(transferNet.get(`${Number(warehouse.id)}:${pidOf(product)}`));
    }
  }
  const known = position.known === true && position.value != null;
  const parts = [];
  if (roles.main) parts.push({ warehouse: roles.main, qty: position.qty - outside });
  for (const warehouse of warehouses) {
    if (roles.main && Number(warehouse.id) === Number(roles.main.id)) continue;
    parts.push({ warehouse, qty: num(transferNet.get(`${Number(warehouse.id)}:${pidOf(product)}`)) });
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
    const line = lineRecord(state, part.warehouse, product, part.qty, unit, share, known, ownership);
    if (!line) return;
    const bucket = ownership?.ownership === "owned" ? state.warehouseMap.get(Number(part.warehouse.id)) : null;
    if (bucket) {
      bucket.total_qty += part.qty;
      if (known) bucket.total_value = round2(bucket.total_value + num(share));
      else bucket.unvalued_count += 1;
    }
    if (!known) line.missing = [UNKNOWN_COST_AR];
    state.lines.push(line);
  });
}

function pidOf(product) {
  return Number(product.id);
}

function lineRecord(state, warehouse, product, quantity, unitCost, value, costKnown, ownership) {
  if (!warehouse || Math.abs(quantity) <= QTY_EPS) return null;
  const own = ownership || { ownership: "owned", included_in_catalog_total: true, cross_scope_label: null };
  return {
    warehouse_id: warehouse.id,
    warehouse_name: warehouse.name,
    warehouse_type: warehouse.type,
    product_id: product.id,
    product_name: product.name,
    barcode: product.barcode,
    sku: product.sku,
    unit_name: product.unit_name || null,
    inventory_scope: scopeOf(product),
    ...categoryFields(product.category),
    quantity,
    unit_cost: costKnown ? unitCost : null,
    value: costKnown ? round2(num(value)) : null,
    cost_known: costKnown,
    as_of: state.asOf,
    as_of_label: state.label,
    ownership: own.ownership,
    included_in_catalog_total: own.included_in_catalog_total !== false,
    cross_scope_label: own.cross_scope_label || null,
    missing: [],
  };
}

function pushLine(state, warehouse, product, quantity, unitCost, value, costKnown) {
  const line = lineRecord(state, warehouse, product, quantity, unitCost, value, costKnown);
  if (!line) return;
  const bucket = state.warehouseMap.get(Number(warehouse.id));
  if (!bucket) return;
  bucket.total_qty += quantity;
  if (costKnown) bucket.total_value = round2(bucket.total_value + num(value));
  else bucket.unvalued_count += 1;
  state.lines.push(line);
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

const ASSIGNED_DAY_TYPES = new Set(["sale", "refund"]);
const DOCUMENT_DAY_TYPES = new Set(["purchase_receive", "supplier_return"]);

/**
 * Sales and refunds keep the stored business day. Purchases and supplier
 * returns use the inventory date: a stored day that already differs from the
 * document date is kept; otherwise the document date is read through the cutoff.
 */
export function inventoryDayForMovement(row, documentDay, cutoffHour) {
  const stored = ymd(row?.business_day);
  const doc = ymd(documentDay);
  if (ASSIGNED_DAY_TYPES.has(row?.movement_type) || row?.reference_type === "shop_consumption" || row?.reference_type === "transaction") {
    if (stored) return stored;
    if (doc) return doc;
    return shopYmdFromTimestamp(row?.created_at);
  }
  if (DOCUMENT_DAY_TYPES.has(row?.movement_type) || row?.reference_type === "purchase_invoice" || row?.reference_type === "purchase_return") {
    if (stored && doc && stored !== doc) return stored;
    return effectiveInventoryDay(doc || stored, row?.created_at, cutoffHour) || shopYmdFromTimestamp(row?.created_at);
  }
  if (stored) return stored;
  if (doc) return doc;
  return shopYmdFromTimestamp(row?.created_at);
}

export function transferInventoryDay(row, cutoffHour) {
  const stored = ymd(row?.inventory_business_day);
  const doc = ymd(row?.transfer_date);
  if (stored && doc && stored !== doc) return stored;
  return effectiveInventoryDay(doc || stored, row?.posted_at || row?.created_at, cutoffHour);
}

function attributionDay(row, maps, cutoffHour) {
  const ref = maps[row.reference_type]?.get(Number(row.reference_id)) || null;
  return inventoryDayForMovement(row, ref, cutoffHour);
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
  return scopeOwnership(product, options, categoryNames);
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
  const settings = await getAppSettings(db);
  const cutoffHour = settings.business_day_cutoff_hour;
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
      `SELECT t.transfer_date, t.inventory_business_day, t.posted_at, t.created_at,
              t.from_warehouse_id, t.to_warehouse_id, i.product_id, i.quantity
         FROM warehouse_transfers t
         JOIN warehouse_transfer_items i ON i.transfer_id = t.id
        WHERE t.status = 'posted'`
    ),
    db.all(
      `SELECT pr.return_date, pr.posted_at, pr.created_at, pri.product_id,
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
  const productById = new Map(products.map((row) => [Number(row.id), { ...row }]));
  const movements = ledger.map((row) => ({ ...row, day: attributionDay(row, maps, cutoffHour) }));
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
        const reason = !explained ? "no_opening_history" : "stock_differs_from_ledger";
        excluded.push({
          product_id: pid,
          product_name: product.name,
          stock: num(product.stock),
          reason,
          reason_ar: REASON_AR[reason],
        });
      }
      continue;
    }
    const state = { qty: 0, value: 0, unit: null, known: false, rounding_remainder: 0, unreconciled: false };
    const posted = [...rows].sort((a, b) => a.id - b.id);
    for (const row of posted) {
      if (!row.day || row.day > asOf) continue;
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
        reason_ar: REASON_AR.recorded_value_disagrees,
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
    const day = transferInventoryDay(row, cutoffHour);
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
    const day = effectiveInventoryDay(row.return_date, row.posted_at || row.created_at, cutoffHour);
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

  const units = await loadBaseUnits(db);
  for (const product of productById.values()) {
    product.unit_name = unitName(units, product.id);
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
    if (!membership) continue;
    appendOwnedLines(state, product, position, roles, warehouses, transferNet, membership);
  }

  state.lines.sort(compareValuationLines);
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

async function loadBaseUnits(db) {
  const rows = await db.all(
    `SELECT product_id, unit_name, conversion_to_base
       FROM product_units
      ORDER BY is_default DESC, id`
  );
  const exact = new Map();
  const fallback = new Map();
  for (const row of rows) {
    const pid = Number(row.product_id);
    if (!fallback.has(pid)) fallback.set(pid, row.unit_name || null);
    if (!exact.has(pid) && Math.abs((Number(row.conversion_to_base) || 1) - 1) < QTY_EPS) {
      exact.set(pid, row.unit_name || null);
    }
  }
  return { exact, fallback };
}

function unitName(units, productId) {
  const pid = Number(productId);
  return units.exact.get(pid) || units.fallback.get(pid) || null;
}

export async function buildCurrentWarehouseValuation(db, options, shopDay) {
  const catalog = await resolveWarehouseCatalog(db, options);
  const warehouses = await loadWarehouses(db);
  const { main, returns: returnsWh } = warehouseRoles(warehouses);
  const outside = await quantitiesOutsideMain(db, catalog, [main?.id]);
  const derivedIds = main ? [main.id] : [];
  const filterId = options.warehouseId != null && options.warehouseId !== "" ? Number(options.warehouseId) : null;
  const [mainLines, extraLines, returnLines, units, flags, bakery] = await Promise.all([
    main ? catalogStockLines(db, main, catalog, outside) : [],
    transferStockLines(db, { excludeIds: derivedIds, catalog }),
    returnsWh ? postedPurchaseReturnLines(db, returnsWh, catalog) : [],
    loadBaseUnits(db),
    db.all(
      `SELECT id, cost, cost_known, category, COALESCE(inventory_scope, 'retail') AS inventory_scope
         FROM products`
    ),
    resolveBakeryReportCategories(db),
  ]);
  const categoryNames = (bakery.categories || []).map((row) => String(row.name || "").trim()).filter(Boolean);
  const flagById = new Map(flags.map((row) => [Number(row.id), row]));
  const typeById = new Map(warehouses.map((w) => [Number(w.id), w.type]));
  const warehouseMap = new Map(warehouses.map((w) => [Number(w.id), emptyWarehouse(w)]));
  const lines = [];
  for (const row of [...mainLines, ...extraLines]) {
    if (filterId && Number(row.warehouse_id) !== filterId) continue;
    const flag = flagById.get(Number(row.product_id));
    const ownership = scopeOwnership(
      { inventory_scope: flag?.inventory_scope, category: flag?.category },
      options,
      categoryNames
    );
    if (!ownership) continue;
    const known = isProductCostKnown({ cost: flag?.cost ?? row.cost, cost_known: flag?.cost_known });
    const quantity = num(row.quantity);
    const unitCost = known ? num(flag?.cost ?? row.cost) : null;
    const value = known ? round2(quantity * unitCost) : null;
    const owned = ownership.ownership === "owned";
    const bucket = owned ? warehouseMap.get(Number(row.warehouse_id)) : null;
    if (bucket) {
      bucket.total_qty += quantity;
      if (known) bucket.total_value = round2(bucket.total_value + num(value));
      else bucket.unvalued_count += 1;
    }
    lines.push({
      warehouse_id: row.warehouse_id,
      warehouse_name: row.warehouse_name,
      warehouse_type: typeById.get(Number(row.warehouse_id)) || null,
      product_id: row.product_id,
      product_name: row.product_name,
      barcode: row.barcode,
      sku: row.sku,
      unit_name: unitName(units, row.product_id),
      inventory_scope: scopeOf({ inventory_scope: flag?.inventory_scope }),
      ...categoryFields(flag?.category),
      quantity,
      unit_cost: unitCost,
      value,
      cost_known: known,
      as_of: shopDay,
      as_of_label: "حتى الآن",
      ownership: ownership.ownership,
      included_in_catalog_total: ownership.included_in_catalog_total !== false,
      cross_scope_label: ownership.cross_scope_label,
      missing: known ? [] : [UNKNOWN_COST_AR],
    });
  }
  lines.sort(compareValuationLines);
  const valued = lines.filter((line) => isOwnedLine(line) && line.cost_known === true && line.value != null && Math.abs(num(line.quantity)) > QTY_EPS);
  const unvalued = lines.filter((line) => line.cost_known !== true && Math.abs(num(line.quantity)) > QTY_EPS).length;
  const known = round2(valued.reduce((sum, line) => round2(sum + num(line.value)), 0));
  const empty = lines.length === 0;
  const complete = empty || unvalued === 0;
  const knownSubtotal = empty ? 0 : valued.length ? known : (unvalued ? null : 0);
  const whRows = [...warehouseMap.values()].map((row) => ({
    ...row,
    total_value: round2(row.total_value),
  }));
  whRows.sort((a, b) => b.total_value - a.total_value || a.warehouse_id - b.warehouse_id);
  return decorateValuation({
    as_of: shopDay,
    as_of_label: "حتى الآن",
    shop_business_day: shopDay,
    basis: CURRENT_BASIS,
    basis_label: CURRENT_BASIS_LABEL_AR,
    status: empty ? "empty" : complete ? "complete" : "partial",
    status_message: empty ? "لا يوجد مخزون" : unvalued ? CURRENT_UNKNOWN_COST_AR : null,
    valued_as: CURRENT_BASIS,
    costing_method: CURRENT_BASIS,
    document_date_estimate: null,
    unreconciled_products: [],
    rounding_adjustments: [],
    unexplained_rounding: [],
    warehouses: whRows,
    lines,
    category_groups: buildCategoryGroups(lines),
    classification: currentCategoryClassification(),
    unclassified_lines: [],
    grand_total: complete ? known : null,
    known_subtotal: knownSubtotal,
    valuation_complete: complete,
    unvalued_count: unvalued,
    unexplained_count: 0,
    excluded_products: [],
    supplier_returns: returnLines.map((row) => ({
      product_id: Number(row.product_id),
      product_name: row.product_name,
      quantity: num(row.quantity),
      value: round2(num(row.value)),
      owned: false,
    })),
    unclassified_count: 0,
    supported_from: null,
    history_limited: false,
    history_message: null,
    classification_message: CURRENT_CATEGORY_NOTE_AR,
    backdated_note: null,
    costing_note: null,
    read_only: true,
  });
}

export async function getWarehouseValuationReport(db, options = {}) {
  const shopDay = await shopBusinessToday(db);
  const requested = options.asOf != null ? String(options.asOf).trim() : "";
  const day = !requested || requested === shopDay ? shopDay : ymd(requested);
  if (!day) return { error: "التاريخ يجب أن يكون بصيغة YYYY-MM-DD", status: 400 };
  if (day > shopDay) return { error: "لا يمكن تقييم تاريخ لاحق", status: 400 };
  if (day === shopDay) return presentBusinessDay(db, options, shopDay);
  return buildHistoricalWarehouseValuation(db, options, day, shopDay, day);
}

async function productsWithInventoryDayAfter(db, shopDay) {
  const settings = await getAppSettings(db);
  const cutoffHour = settings.business_day_cutoff_hour;
  const maps = await loadAttributionMaps(db);
  const rows = await db.all(
    `SELECT product_id, movement_type, reference_type, reference_id, business_day, created_at
       FROM inventory_ledger
      WHERE movement_type IN ('purchase_receive', 'supplier_return')`
  );
  const ids = new Set();
  for (const row of rows) {
    const day = attributionDay(row, maps, cutoffHour);
    if (day && day > shopDay) ids.add(Number(row.product_id));
  }
  const transfers = await db.all(
    `SELECT t.transfer_date, t.inventory_business_day, t.posted_at, t.created_at, i.product_id
       FROM warehouse_transfers t
       JOIN warehouse_transfer_items i ON i.transfer_id = t.id
      WHERE t.status = 'posted'`
  );
  for (const row of transfers) {
    const day = transferInventoryDay(row, cutoffHour);
    if (day && day > shopDay) ids.add(Number(row.product_id));
  }
  return ids;
}

function retotalCurrent(report, lines) {
  const sorted = [...lines].sort(compareValuationLines);
  const warehouseMap = new Map((report.warehouses || []).map((row) => [Number(row.warehouse_id), {
    warehouse_id: row.warehouse_id,
    warehouse_name: row.warehouse_name,
    warehouse_type: row.warehouse_type,
    total_qty: 0,
    total_value: 0,
    unvalued_count: 0,
  }]));
  for (const line of sorted) {
    if (!isOwnedLine(line)) continue;
    const bucket = warehouseMap.get(Number(line.warehouse_id));
    if (!bucket) continue;
    bucket.total_qty += num(line.quantity);
    if (line.cost_known === true && line.value != null) bucket.total_value = round2(bucket.total_value + num(line.value));
    else if (Math.abs(num(line.quantity)) > QTY_EPS) bucket.unvalued_count += 1;
  }
  const warehouses = [...warehouseMap.values()].map((row) => ({ ...row, total_value: round2(row.total_value) }));
  warehouses.sort((a, b) => num(b.total_value) - num(a.total_value) || a.warehouse_id - b.warehouse_id);
  const ownedValued = sorted.filter((line) => isOwnedLine(line) && line.cost_known === true && line.value != null && Math.abs(num(line.quantity)) > QTY_EPS);
  const unvalued = sorted.filter((line) => line.cost_known !== true && Math.abs(num(line.quantity)) > QTY_EPS).length;
  const known = round2(ownedValued.reduce((sum, line) => round2(sum + num(line.value)), 0));
  const empty = sorted.length === 0;
  const complete = empty || unvalued === 0;
  return decorateValuation({
    ...report,
    lines: sorted,
    warehouses,
    category_groups: buildCategoryGroups(sorted),
    status: empty ? "empty" : complete ? "complete" : "partial",
    status_message: empty ? "لا يوجد مخزون" : unvalued ? KNOWN_VALUE_INCOMPLETE_AR : null,
    grand_total: complete ? known : null,
    known_subtotal: empty ? 0 : ownedValued.length ? known : (unvalued ? null : 0),
    valuation_complete: complete,
    unvalued_count: unvalued,
    boundary_note: "حركات تاريخ مخزونها بعد يوم العمل بقيت على تاريخها ولم تدخل في عرض هذا اليوم.",
  });
}

async function presentBusinessDay(db, options, shopDay) {
  const futureIds = await productsWithInventoryDayAfter(db, shopDay);
  const live = await buildCurrentWarehouseValuation(db, options, shopDay);
  if (!futureIds.size) return live;
  const visible = new Set();
  for (const line of live.lines || []) {
    if (futureIds.has(Number(line.product_id))) visible.add(Number(line.product_id));
  }
  if (!visible.size) return live;
  const replay = await buildHistoricalWarehouseValuation(db, options, shopDay, shopDay, "حتى الآن");
  const lines = [];
  for (const line of live.lines || []) {
    if (visible.has(Number(line.product_id))) continue;
    lines.push(line);
  }
  for (const line of replay.lines || []) {
    if (visible.has(Number(line.product_id))) lines.push({ ...line, as_of_label: "حتى الآن" });
  }
  return retotalCurrent(live, lines);
}
