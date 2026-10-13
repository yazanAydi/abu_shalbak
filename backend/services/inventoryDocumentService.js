import { recordMovement } from "../utils/inventory.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { withTransaction } from "../utils/dbTx.js";
import { shopTodayYmd } from "../utils/shopTime.js";
import { listLimitSql } from "../utils/listQuery.js";
import { badRequest } from "../utils/httpError.js";
import { toBaseQuantity } from "../utils/productUnits.js";
import { nextInventoryDocumentNumber } from "../utils/inventoryDocumentNo.js";
import {
  isValidReason,
  ledgerNoteForDocument,
  documentTypeTitleAr,
  reasonLabelAr,
} from "../utils/inventoryDocumentReasons.js";
import { interpretExpiryInput, normalizeExpiryDate } from "../utils/expiryDate.js";
import { batchSourceLabelAr } from "../utils/batchSourceLabel.js";
import {
  listPhysicalSources,
  takeExactDatedQuantity,
  assertUndatedAvailable,
  recordBatchAllocation,
  receiveDatedBatch,
  moveUndatedOnMain,
} from "./stockBatchService.js";

function isYmd(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function mapDocumentRow(row) {
  if (!row) return null;
  return {
    ...row,
    title_ar: documentTypeTitleAr(row.document_type),
    reason_label: reasonLabelAr(row.document_type, row.reason),
  };
}

function mapItemRow(row) {
  return {
    id: row.id,
    document_id: row.document_id,
    product_id: row.product_id,
    product_unit_id: row.product_unit_id,
    quantity: row.quantity,
    conversion_to_base: row.conversion_to_base,
    conversion_used: row.conversion_to_base,
    base_quantity: row.base_quantity,
    product_name: row.product_name_snapshot,
    product_name_snapshot: row.product_name_snapshot,
    sku: row.sku_snapshot,
    sku_snapshot: row.sku_snapshot,
    barcode: row.barcode_snapshot,
    barcode_snapshot: row.barcode_snapshot,
    unit_name: row.unit_name_snapshot,
    unit_name_snapshot: row.unit_name_snapshot,
    batch_source: row.batch_source || null,
    expiry_date: row.expiry_date || null,
    source_label: issueSourceLabel(row.batch_source, row.expiry_date),
  };
}

function issueSourceLabel(source, expiryDate) {
  return batchSourceLabelAr(source, expiryDate);
}

export async function getInventoryDocumentById(db, id) {
  const row = await db.get(
    `SELECT d.*, u.username AS created_by_name
     FROM inventory_documents d
     LEFT JOIN users u ON u.id = d.created_by
     WHERE d.id = ?`,
    [Number(id)]
  );
  if (!row) return null;
  return getInventoryDocument(db, row.document_type, row.id);
}

export async function getInventoryDocument(db, documentType, id) {
  const row = await db.get(
    `SELECT d.*, u.username AS created_by_name
     FROM inventory_documents d
     LEFT JOIN users u ON u.id = d.created_by
     WHERE d.id = ? AND d.document_type = ?`,
    [Number(id), documentType]
  );
  if (!row) return null;
  const items = await db.all(
    `SELECT * FROM inventory_document_items WHERE document_id = ? ORDER BY id`,
    [row.id]
  );
  return {
    ...mapDocumentRow(row),
    items: items.map(mapItemRow),
  };
}

export async function listInventoryDocuments(db, documentType, query = {}) {
  const { search, from, to, reason, created_by, status } = query;
  let sql = `SELECT d.*, u.username AS created_by_name,
              (SELECT COUNT(*) FROM inventory_document_items i WHERE i.document_id = d.id) AS item_count,
              (SELECT COALESCE(SUM(i.base_quantity), 0) FROM inventory_document_items i WHERE i.document_id = d.id) AS total_base_quantity
       FROM inventory_documents d
       LEFT JOIN users u ON u.id = d.created_by
       WHERE d.document_type = ?`;
  const params = [documentType];
  if (search && String(search).trim()) {
    sql += " AND d.document_number LIKE ?";
    params.push(`%${String(search).trim()}%`);
  }
  if (from && isYmd(from)) {
    sql += " AND d.document_date >= ?";
    params.push(from);
  }
  if (to && isYmd(to)) {
    sql += " AND d.document_date <= ?";
    params.push(to);
  }
  if (reason && String(reason).trim()) {
    sql += " AND d.reason = ?";
    params.push(String(reason).trim());
  }
  const creatorId = Number(created_by);
  if (Number.isInteger(creatorId) && creatorId > 0) {
    sql += " AND d.created_by = ?";
    params.push(creatorId);
  }
  if (status && String(status).trim()) {
    sql += " AND d.status = ?";
    params.push(String(status).trim());
  }
  const { sql: limitSql } = listLimitSql(query, 200);
  sql += ` ORDER BY d.document_date DESC, d.id DESC${limitSql}`;
  const rows = await db.all(sql, params);
  return rows.map((row) => ({
    ...mapDocumentRow(row),
    item_count: Number(row.item_count) || 0,
    total_base_quantity: Number(row.total_base_quantity) || 0,
  }));
}

async function resolveLine(db, item) {
  const productId = Number(item.product_id);
  const unitId = Number(item.product_unit_id ?? item.unit_id);
  const quantity = Number(item.quantity);
  if (!productId) throw badRequest("المنتج غير موجود", "MISSING_PRODUCT");
  if (!unitId) throw badRequest("الوحدة مطلوبة", "MISSING_UNIT");
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw badRequest("الكمية يجب أن تكون أكبر من صفر", "VALIDATION_ERROR");
  }

  const product = await db.get(
    "SELECT id, name, sku, barcode FROM products WHERE id = ?",
    [productId]
  );
  if (!product) throw badRequest("المنتج غير موجود", "MISSING_PRODUCT");

  const unit = await db.get(
    `SELECT id, unit_name, conversion_to_base, barcode, sale_enabled, purchase_enabled
     FROM product_units WHERE id = ? AND product_id = ?`,
    [unitId, productId]
  );
  if (!unit) throw badRequest("الوحدة غير موجودة لهذا المنتج", "MISSING_UNIT");
  const saleOn = unit.sale_enabled == null || Number(unit.sale_enabled) === 1;
  const purchaseOn = unit.purchase_enabled == null || Number(unit.purchase_enabled) === 1;
  if (!saleOn && !purchaseOn) {
    throw badRequest("الوحدة غير متاحة", "DISABLED_UNIT");
  }

  const conversion = Number(unit.conversion_to_base);
  if (!Number.isFinite(conversion) || conversion <= 0) {
    throw badRequest("معامل التحويل غير صالح", "VALIDATION_ERROR");
  }
  const baseQuantity = toBaseQuantity(quantity, conversion);
  if (!Number.isFinite(baseQuantity) || baseQuantity <= 0) {
    throw badRequest("الكمية الأساسية غير صالحة", "VALIDATION_ERROR");
  }

  const unitBarcode = unit.barcode != null ? String(unit.barcode).trim() : "";
  return {
    product_id: product.id,
    product_unit_id: unit.id,
    quantity,
    conversion_to_base: conversion,
    base_quantity: baseQuantity,
    product_name_snapshot: product.name || "",
    sku_snapshot: product.sku != null ? String(product.sku) : null,
    barcode_snapshot: unitBarcode || (product.barcode != null ? String(product.barcode) : null),
    unit_name_snapshot: unit.unit_name || "",
  };
}

function parseIssueSource(raw, hasDated) {
  const source = raw?.batch_source == null || String(raw.batch_source).trim() === ""
    ? null
    : String(raw.batch_source).trim();
  if (!hasDated) {
    if (source) {
      throw badRequest("هذا الصنف بلا دفعات مؤرخة", "BATCH_SOURCE_UNEXPECTED");
    }
    return { batch_source: null, expiry_date: null };
  }
  if (source !== "dated" && source !== "undated") {
    throw badRequest(
      "حدد الدفعة أو المخزون غير المحدد. لا يُختار مصدر تلقائياً",
      "BATCH_SOURCE_REQUIRED"
    );
  }
  if (source === "undated") {
    if (raw.expiry_date != null && String(raw.expiry_date).trim() !== "") {
      throw badRequest("المخزون غير المحدد لا يحمل تاريخ صلاحية", "EXPIRY_UNEXPECTED");
    }
    return { batch_source: "undated", expiry_date: null };
  }
  const ymd = normalizeExpiryDate(raw.expiry_date);
  if (!ymd) throw badRequest("تاريخ صلاحية الدفعة غير صالح", "INVALID_EXPIRY");
  return { batch_source: "dated", expiry_date: ymd };
}

/**
 * Create and complete an inventory document in one atomic transaction.
 * Ledger + stock-cache updates happen inside the same transaction.
 */
export async function createInventoryDocument(db, req, documentType, body) {
  const reason = String(body?.reason || "").trim();
  if (!isValidReason(documentType, reason)) {
    throw badRequest("سبب غير صالح", "VALIDATION_ERROR");
  }
  const items = Array.isArray(body?.items) ? body.items : [];
  if (items.length === 0) {
    throw badRequest("يجب إضافة صنف واحد على الأقل", "VALIDATION_ERROR");
  }
  const documentDate = isYmd(body?.document_date) ? body.document_date : shopTodayYmd();
  const notes = body?.notes != null && String(body.notes).trim() !== "" ? String(body.notes).trim() : null;
  const storeId = Number(body?.store_id) > 0 ? Number(body.store_id) : 1;
  const userId = req.user?.id != null ? Number(req.user.id) : null;
  const movementType = documentType === "issue" ? "adjust_out" : "adjust_in";
  const sign = documentType === "issue" ? -1 : 1;
  const refType = documentType === "issue" ? "inventory_issue" : "inventory_receipt";

  const created = await withTransaction(db, async () => {
    const documentNumber = await nextInventoryDocumentNumber(db, documentType);
    const ins = await db.run(
      `INSERT INTO inventory_documents
         (document_number, document_type, document_date, store_id, reason, notes, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)`,
      [documentNumber, documentType, documentDate, storeId, reason, notes, userId]
    );
    const docId = ins.lastID;
    const ledgerNote = ledgerNoteForDocument(documentType, documentNumber);

    for (const raw of items) {
      const line = await resolveLine(db, raw);
      if (documentType === "receipt" && (raw?.batch_source != null && String(raw.batch_source).trim() !== "")) {
        throw badRequest("سند الإدخال لا يخصص دفعة", "BATCH_SOURCE_UNEXPECTED");
      }
      let source = documentType === "issue"
        ? parseIssueSource(raw, (await listPhysicalSources(db, line.product_id)).has_dated_batches)
        : { batch_source: null, expiry_date: null };
      if (documentType === "receipt") {
        const parsed = interpretExpiryInput(raw?.expiry_date);
        if (!parsed.ok) throw badRequest("تاريخ الصلاحية غير صالح", "INVALID_EXPIRY");
        const ymd = parsed.date;
        if (ymd) {
          await receiveDatedBatch(db, {
            productId: line.product_id,
            expiryDate: ymd,
            quantity: line.base_quantity,
          });
          source = { batch_source: "dated", expiry_date: ymd };
        } else {
          await moveUndatedOnMain(db, line.product_id, line.base_quantity);
        }
        await recordBatchAllocation(
          db,
          { expiry_date: ymd, quantity: line.base_quantity },
          {
            productId: line.product_id,
            direction: "in",
            referenceType: "inventory_receipt",
            referenceId: docId,
          }
        );
      }
      if (documentType === "issue" && source.batch_source === "dated") {
        const taken = await takeExactDatedQuantity(db, line.product_id, source.expiry_date, line.base_quantity);
        const parts = taken.parts?.length ? taken.parts : [{ expiry_date: source.expiry_date, quantity: line.base_quantity }];
        for (const part of parts) {
          await recordBatchAllocation(db, part, {
            productId: line.product_id,
            direction: "out",
            referenceType: "inventory_issue",
            referenceId: docId,
          });
        }
      } else if (documentType === "issue" && source.batch_source === "undated") {
        await assertUndatedAvailable(db, line.product_id, line.base_quantity);
        const parts = await moveUndatedOnMain(db, line.product_id, -line.base_quantity);
        const rows = parts?.length ? parts : [{ expiry_date: null, quantity: line.base_quantity }];
        for (const part of rows) {
          await recordBatchAllocation(db, part, {
            productId: line.product_id,
            direction: "out",
            referenceType: "inventory_issue",
            referenceId: docId,
          });
        }
      }
      await db.run(
        `INSERT INTO inventory_document_items
           (document_id, product_id, product_unit_id, quantity, conversion_to_base, base_quantity,
            product_name_snapshot, sku_snapshot, barcode_snapshot, unit_name_snapshot,
            batch_source, expiry_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          docId,
          line.product_id,
          line.product_unit_id,
          line.quantity,
          line.conversion_to_base,
          line.base_quantity,
          line.product_name_snapshot,
          line.sku_snapshot,
          line.barcode_snapshot,
          line.unit_name_snapshot,
          source.batch_source,
          source.expiry_date,
        ]
      );
      await recordMovement(db, {
        productId: line.product_id,
        movementType,
        quantity: sign * line.base_quantity,
        refType,
        refId: docId,
        notes: ledgerNote,
        userId,
        applyStock: true,
        businessDay: documentDate,
      });
    }

    await logAudit(db, req, AUDIT_ACTIONS.INVENTORY_ADJUST, "inventory_documents", docId, null, {
      document_number: documentNumber,
      document_type: documentType,
      reason,
      lines: items.length,
    });

    return docId;
  });

  return getInventoryDocument(db, documentType, created);
}
