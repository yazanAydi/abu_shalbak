import { Router } from "express";
import { requireAuth, requireReportsPermission, requireAnyReportsPermission } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  inventoryReceiptCreateSchema,
  inventoryIssueCreateSchema,
} from "../middleware/schemas.js";
import {
  listInventoryDocuments,
  getInventoryDocument,
  getInventoryDocumentById,
  createInventoryDocument,
} from "../services/inventoryDocumentService.js";
import { reasonsForType } from "../utils/inventoryDocumentReasons.js";
import { buildInventoryDocumentPrintHtml } from "../utils/inventoryDocumentPrintHtml.js";
import { getAppSettings } from "../utils/settings.js";


async function sendPrintHtml(res, db, doc, printedBy) {
  const settings = await getAppSettings(db);
  const html = buildInventoryDocumentPrintHtml(doc, settings, { printedBy });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
}

export function createInventoryDocumentsRouter(db, documentType) {
  const router = Router();
  const requireDoc = requireReportsPermission(
    db,
    documentType === "issue" ? "inventory_issues" : "inventory_receipts"
  );
  const createSchema =
    documentType === "issue" ? inventoryIssueCreateSchema : inventoryReceiptCreateSchema;

  router.get("/", requireAuth, requireDoc, async (req, res, next) => {
    try {
      const rows = await listInventoryDocuments(db, documentType, req.query);
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  router.get("/reasons", requireAuth, requireDoc, (_req, res) => {
    res.json(reasonsForType(documentType));
  });

  router.get("/:id/print", requireAuth, requireDoc, async (req, res, next) => {
    try {
      const doc = await getInventoryDocument(db, documentType, req.params.id);
      if (!doc) {
        return res.status(404).json({ error: "السند غير موجود", code: "NOT_FOUND" });
      }
      await sendPrintHtml(res, db, doc, req.user?.username);
    } catch (e) {
      next(e);
    }
  });

  router.get("/:id", requireAuth, requireDoc, async (req, res, next) => {
    try {
      const doc = await getInventoryDocument(db, documentType, req.params.id);
      if (!doc) {
        return res.status(404).json({ error: "السند غير موجود", code: "NOT_FOUND" });
      }
      res.json(doc);
    } catch (e) {
      next(e);
    }
  });

  router.post("/", requireAuth, requireDoc, validate(createSchema), async (req, res, next) => {
    try {
      const doc = await createInventoryDocument(db, req, documentType, req.body);
      res.status(201).json(doc);
    } catch (e) {
      next(e);
    }
  });

  return router;
}

/** Print by id regardless of receipt vs issue: GET /inventory-documents/:id/print */
export function createInventoryDocumentPrintRouter(db) {
  const router = Router();
  const requireDocPrint = requireAnyReportsPermission(db, "inventory_receipts", "inventory_issues");
  router.get("/:id/print", requireAuth, requireDocPrint, async (req, res, next) => {
    try {
      const doc = await getInventoryDocumentById(db, req.params.id);
      if (!doc) {
        return res.status(404).json({ error: "السند غير موجود", code: "NOT_FOUND" });
      }
      await sendPrintHtml(res, db, doc, req.user?.username);
    } catch (e) {
      next(e);
    }
  });
  return router;
}
