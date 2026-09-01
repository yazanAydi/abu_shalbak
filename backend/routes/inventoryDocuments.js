import { Router } from "express";
import { requireAuth, requireAdmin, requireRoles } from "../middleware/auth.js";
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
import { STORE_NAME_AR } from "../utils/storeBranding.js";

const requireRead = requireRoles("admin", "accountant");

function sendPrintHtml(res, doc) {
  const html = buildInventoryDocumentPrintHtml(doc, { store_name_ar: STORE_NAME_AR });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
}

export function createInventoryDocumentsRouter(db, documentType) {
  const router = Router();
  const createSchema =
    documentType === "issue" ? inventoryIssueCreateSchema : inventoryReceiptCreateSchema;

  router.get("/", requireAuth, requireRead, async (req, res, next) => {
    try {
      const rows = await listInventoryDocuments(db, documentType, req.query);
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  router.get("/reasons", requireAuth, requireRead, (_req, res) => {
    res.json(reasonsForType(documentType));
  });

  router.get("/:id/print", requireAuth, requireRead, async (req, res, next) => {
    try {
      const doc = await getInventoryDocument(db, documentType, req.params.id);
      if (!doc) {
        return res.status(404).json({ error: "السند غير موجود", code: "NOT_FOUND" });
      }
      sendPrintHtml(res, doc);
    } catch (e) {
      next(e);
    }
  });

  router.get("/:id", requireAuth, requireRead, async (req, res, next) => {
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

  router.post("/", requireAuth, requireAdmin, validate(createSchema), async (req, res, next) => {
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
  router.get("/:id/print", requireAuth, requireRead, async (req, res, next) => {
    try {
      const doc = await getInventoryDocumentById(db, req.params.id);
      if (!doc) {
        return res.status(404).json({ error: "السند غير موجود", code: "NOT_FOUND" });
      }
      sendPrintHtml(res, doc);
    } catch (e) {
      next(e);
    }
  });
  return router;
}
