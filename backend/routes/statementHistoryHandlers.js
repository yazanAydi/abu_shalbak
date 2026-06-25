import { requireImportFile } from "../utils/importUpload.js";
import { parseHesabatiStatementFile } from "../utils/statementHistoryImport.js";
import {
  buildStatementHistoryImportPlan,
  applyStatementHistoryImport,
} from "../utils/statementHistoryService.js";

/**
 * @param {object} db
 * @param {"supplier"|"customer"} partyType
 */
export function createStatementHistoryPreviewHandler(db, partyType) {
  return async (req, res) => {
    try {
      const partyId = Number(req.params.id);
      if (!Number.isFinite(partyId) || partyId <= 0) {
        return res.status(400).json({ error: "معرّف غير صالح", code: "VALIDATION_ERROR" });
      }

      const file = requireImportFile(req, res);
      if (!file) return;

      const overwriteExisting =
        String(req.query.overwrite_existing || req.body?.overwrite_existing || "") === "1" ||
        req.body?.overwriteExisting === true;

      const parsed = await parseHesabatiStatementFile(file.buffer, file.originalname);
      const plan = await buildStatementHistoryImportPlan(db, partyType, partyId, parsed.rows, {
        overwriteExisting,
        invalidRows: parsed.invalid,
        duplicateRows: parsed.duplicates,
        sourceFileName: file.originalname,
      });

      res.json(plan);
    } catch (e) {
      res.status(e.status || 400).json({
        error: e.message || "فشلت المعاينة",
        code: e.code || "PREVIEW_ERROR",
      });
    }
  };
}

/**
 * @param {object} db
 * @param {"supplier"|"customer"} partyType
 */
export function createStatementHistoryConfirmHandler(db, partyType) {
  return async (req, res) => {
    try {
      const partyId = Number(req.params.id);
      if (!Number.isFinite(partyId) || partyId <= 0) {
        return res.status(400).json({ error: "معرّف غير صالح", code: "VALIDATION_ERROR" });
      }

      const file = requireImportFile(req, res);
      if (!file) return;

      const overwriteExisting =
        String(req.query.overwrite_existing || req.body?.overwrite_existing || "") === "1" ||
        req.body?.overwriteExisting === true;

      const parsed = await parseHesabatiStatementFile(file.buffer, file.originalname);
      const result = await applyStatementHistoryImport(db, partyType, partyId, parsed.rows, {
        overwriteExisting,
        sourceFileName: file.originalname,
      });

      res.json({ success: true, ...result });
    } catch (e) {
      res.status(e.status || 400).json({
        error: e.message || "فشل الاستيراد",
        code: e.code || "IMPORT_ERROR",
      });
    }
  };
}
