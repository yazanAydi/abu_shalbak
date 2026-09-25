import { loadSaleReceipt } from "../routes/print.js";
import { HttpError } from "../utils/httpError.js";
import { round2 } from "../utils/money.js";
import { buildOperationReceipt } from "../utils/receipt.js";
import { getAppSettings } from "../utils/settings.js";

export const PRINT_FAILED_AR =
  "تم حفظ العملية وتعذرت الطباعة. لا تُعد إدخال العملية؛ استخدم إعادة الطباعة.";

const PENDING_LABEL = "بانتظار الطباعة";

export function printStatusLabel(status) {
  if (status === "pending") return PENDING_LABEL;
  if (status === "failed" || status === "claimed") return PRINT_FAILED_AR;
  return null;
}

export async function enqueueOperationPrint(db, job) {
  const snapshot = JSON.stringify(job.snapshot || {});
  await db.run(
    `INSERT OR IGNORE INTO operation_print_jobs
       (kind, reference_id, cashier_id, shift_id, document_no, snapshot_json, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    [
      job.kind,
      Number(job.referenceId),
      Number(job.cashierId),
      job.shiftId != null ? Number(job.shiftId) : null,
      job.documentNo != null ? String(job.documentNo) : null,
      snapshot,
    ]
  );
  console.log(`[operation-print] stage=queued kind=${job.kind} reference=${Number(job.referenceId)}`);
}

function parseSnapshot(row) {
  try {
    return JSON.parse(row.snapshot_json);
  } catch {
    return {};
  }
}

async function renderJob(db, row, { copy = false } = {}) {
  const snap = parseSnapshot(row);
  if (row.kind === "sale") {
    const receipt = await loadSaleReceipt(db, row.reference_id);
    if (!receipt) throw new HttpError(404, "العملية غير موجودة", "NOT_FOUND");
    let html = receipt.receipt_html;
    const extra = [
      snap.request_id ? `طلب الموافقة: #${snap.request_id}` : "",
      snap.manager_name ? `المدير: ${snap.manager_name}` : "",
    ].filter(Boolean);
    if (extra.length) {
      const block = extra
        .map((line) => `<div>${String(line).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>`)
        .join("");
      html = html.replace('<div class="thanks">', `<div class="payment">${block}</div><div class="thanks">`);
    }
    if (copy) html = html.replace("نسخة أصلية", "نسخة");
    return { receipt_html: html, document_no: receipt.transaction_id };
  }

  const settings = await getAppSettings(db);
  const built = buildOperationReceipt({
    ...snap,
    settings,
    copy,
    documentNo: row.document_no || snap.documentNo,
  });
  return { receipt_html: built.receipt_html, document_no: row.document_no };
}

export async function listCashierPrintJobs(db, cashierId) {
  const rows = await db.all(
    `SELECT id, kind, reference_id, document_no, status, shift_id, created_at
       FROM operation_print_jobs
      WHERE cashier_id = ?
      ORDER BY id DESC
      LIMIT 50`,
    [Number(cashierId)]
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    reference_id: row.reference_id,
    document_no: row.document_no,
    status: row.status,
    shift_id: row.shift_id,
    created_at: row.created_at,
    print_label: printStatusLabel(row.status),
  }));
}

export async function claimNextPrintJob(db, cashierId) {
  const next = await db.get(
    `SELECT * FROM operation_print_jobs
      WHERE cashier_id = ? AND status = 'pending'
      ORDER BY id ASC LIMIT 1`,
    [Number(cashierId)]
  );
  if (!next) return null;
  const claimed = await db.run(
    `UPDATE operation_print_jobs
        SET status = 'claimed', claimed_at = datetime('now')
      WHERE id = ? AND status = 'pending'`,
    [next.id]
  );
  if (!claimed.changes) return null;
  const rendered = await renderJob(db, next, { copy: false });
  return {
    id: next.id,
    kind: next.kind,
    document_no: rendered.document_no,
    receipt_html: rendered.receipt_html,
  };
}

export async function finishPrintJob(db, cashierId, jobId, outcome) {
  const status = outcome === "accepted" ? "accepted" : "failed";
  const info = await db.run(
    `UPDATE operation_print_jobs
        SET status = ?, finished_at = datetime('now')
      WHERE id = ? AND cashier_id = ? AND status = 'claimed'`,
    [status, Number(jobId), Number(cashierId)]
  );
  if (!info.changes) {
    throw new HttpError(409, "لا يمكن تحديث حالة طباعة غير معلقة", "PRINT_NOT_CLAIMED");
  }
  return { id: Number(jobId), status, message: status === "failed" ? PRINT_FAILED_AR : null };
}

export async function reprintPrintJob(db, cashierId, jobId) {
  const row = await db.get(
    "SELECT * FROM operation_print_jobs WHERE id = ? AND cashier_id = ?",
    [Number(jobId), Number(cashierId)]
  );
  if (!row) throw new HttpError(404, "الإيصال غير موجود", "NOT_FOUND");
  return renderCopy(db, row);
}

export async function reprintOperationByReference(db, kind, referenceId) {
  const row = await db.get(
    "SELECT * FROM operation_print_jobs WHERE kind = ? AND reference_id = ?",
    [String(kind), Number(referenceId)]
  );
  if (!row) throw new HttpError(404, "لا يوجد إيصال لهذه العملية", "NOT_FOUND");
  return renderCopy(db, row);
}

async function renderCopy(db, row) {
  const rendered = await renderJob(db, row, { copy: true });
  return {
    id: row.id,
    kind: row.kind,
    copy: true,
    document_no: rendered.document_no,
    receipt_html: rendered.receipt_html,
  };
}

export function shopConsumptionPrintSnapshot({ consumption, cashierName, lines }) {
  return {
    title: "استهلاك داخلي — مصاريف محل",
    documentNo: `EXP-${consumption.id}`,
    timestamp: consumption.created_at,
    businessDay: consumption.business_day,
    cashierName,
    shiftId: consumption.shift_id,
    partyLabel: "المحل",
    lines: (lines || []).map((line) => `${line.name} × ${line.quantity} ${line.unit_name || ""}`.trim()),
    note: consumption.reason || null,
    amountLabel: `إجمالي المصروف ${round2(consumption.total_cost).toFixed(2)} شيقل`,
    footer: "لا توجد حركة نقدية",
  };
}
