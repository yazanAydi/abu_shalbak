import { documentNumberPrefix } from "./inventoryDocumentReasons.js";

/**
 * Allocate the next GIN-###### / GOUT-###### number from inventory_document_sequences.
 * Must run inside an open transaction.
 * @param {object} db
 * @param {'receipt'|'issue'} documentType
 */
export async function nextInventoryDocumentNumber(db, documentType) {
  const docType = documentType === "issue" ? "issue" : "receipt";
  const prefix = documentNumberPrefix(docType);
  await db.run(
    `INSERT INTO inventory_document_sequences (doc_type, last_seq) VALUES (?, 1)
     ON CONFLICT(doc_type) DO UPDATE SET last_seq = last_seq + 1`,
    [docType]
  );
  const row = await db.get(
    "SELECT last_seq FROM inventory_document_sequences WHERE doc_type = ?",
    [docType]
  );
  const seq = Number(row?.last_seq) || 1;
  return `${prefix}-${String(seq).padStart(6, "0")}`;
}
