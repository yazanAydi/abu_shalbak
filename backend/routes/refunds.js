import { Router } from "express";
import { requireAuth, requirePosAccess, requireRoles } from "../middleware/auth.js";
import { canViewReports } from "../utils/roles.js";
import { parseItemsJson } from "../utils/cogs.js";
import {
  refundedQtyByProduct,
  applyApprovedRefundEffects,
  createRefundRequest,
} from "../services/refundRequestService.js";

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function requirePosOrReports(req, res, next) {
  const r = req.user?.role;
  if (
    canViewReports(r) ||
    r === "admin" ||
    r === "cashier" ||
    r === "shelves_employee" ||
    r === "bakery_employee"
  ) {
    return next();
  }
  return res.status(403).json({ error: "ممنوع" });
}

function buildReceiptHtml(refund, originalTx, cashierName, approverName) {
  let items = [];
  try {
    items = JSON.parse(refund.items_json);
  } catch {
    items = [];
  }
  const lines = (Array.isArray(items) ? items : [])
    .map(
      (it) =>
        `<tr><td>${escapeHtml(it.name || "")}</td><td>${it.quantity}</td><td>${round2(Number(it.price) || 0)}</td></tr>`
    )
    .join("");
  const pm = refund.payment_method === "cash" ? "نقد" : "بطاقة";
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"/><title>إيصال استرجاع #${refund.id}</title>
<style>body{font-family:system-ui,sans-serif;padding:1.2rem;max-width:480px;margin:auto} table{width:100%;border-collapse:collapse} th,td{border:1px solid #ccc;padding:6px;text-align:right} .sig{margin-top:2rem;border-top:1px solid #333;padding-top:8px}</style></head><body>
<h2>استرجاع #${refund.id}</h2>
<p>الفاتورة الأصلية: #${refund.original_transaction_id}<br/>
الكاشير: ${escapeHtml(cashierName)}<br/>
التاريخ: ${escapeHtml(refund.created_at || "")}<br/>
طريقة الرد: ${pm}<br/>
الحالة: ${escapeHtml(refund.status || "")}</p>
<table><thead><tr><th>الصنف</th><th>الكمية</th><th>السعر</th></tr></thead><tbody>${lines}</tbody></table>
<p><strong>الإجمالي: ${round2(Number(refund.total))}</strong></p>
${refund.reason ? `<p>السبب: ${escapeHtml(refund.reason)}</p>` : ""}
<div class="sig">توقيع الموافقة: ${escapeHtml(approverName || "________________")}</div>
<script>window.onload=function(){window.print()}</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function createRefundsRouter(db) {
  const router = Router();

  router.get("/lookup/:transactionId", requireAuth, requirePosOrReports, async (req, res) => {
    const tid = Number(req.params.transactionId);
    if (!tid) return res.status(400).json({ error: "رقم العملية غير صالح" });
    const tx = await db.get("SELECT * FROM transactions WHERE id = ?", [tid]);
    if (!tx) return res.status(404).json({ error: "العملية غير موجودة" });
    let items;
    try {
      items = JSON.parse(tx.items_json);
    } catch {
      return res.status(500).json({ error: "بيانات البيع غير صالحة" });
    }
    if (!Array.isArray(items)) return res.status(500).json({ error: "الأصناف غير صالحة" });
    const already = await refundedQtyByProduct(db, tid);
    const lines = items.map((it) => {
      const pid = Number(it.product_id);
      const sold = Number(it.quantity) || 0;
      const ref = already.get(pid) || 0;
      return {
        product_id: pid,
        name: it.name,
        price: Number(it.price) || 0,
        quantity_sold: sold,
        quantity_already_refunded: ref,
        quantity_returnable: Math.max(0, sold - ref),
      };
    });
    const cashier = await db.get("SELECT username FROM users WHERE id = ?", [tx.cashier_id]);
    res.json({
      transaction_id: tid,
      created_at: tx.created_at,
      payment_method: tx.payment_method,
      subtotal: tx.subtotal,
      total: tx.total,
      cashier_username: cashier?.username || "",
      lines,
    });
  });

  router.post("/", requireAuth, requirePosAccess, async (req, res, next) => {
    const { original_transaction_id, lines, reason, payment_method } = req.body || {};
    const tid = Number(original_transaction_id);
    if (!tid) {
      return res.status(400).json({ error: "مطلوب original_transaction_id" });
    }
    if (payment_method !== "cash" && payment_method !== "visa") {
      return res.status(400).json({ error: "طريقة الدفع يجب أن تكون نقداً أو بطاقة" });
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: "مطلوب مصفوفة lines: { product_id, quantity }" });
    }

    try {
      const result = await createRefundRequest(db, {
        cashierId: req.user.id,
        transactionId: tid,
        lines,
        paymentMethod: payment_method,
        reason: reason != null ? String(reason) : null,
        req,
      });
      res.status(201).json({
        success: true,
        request_id: result.request_id,
        request: result.request,
        telegram: result.telegram,
        refund: {
          id: result.request_id,
          status: "pending",
          total: result.request.total_amount,
        },
        message: result.message,
      });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message, max_returnable: e.max_returnable });
      }
      console.error(e);
      res.status(500).json({ error: e.message || "فشل الاسترجاع" });
    }
  });

  router.get("/summary", requireAuth, requireRoles("admin", "accountant"), async (_req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const allRow = await db.get(
      `SELECT COUNT(*) AS count,
        COALESCE(SUM(CASE WHEN status IN ('approved','pending') THEN total ELSE 0 END),0) AS amount
       FROM refunds`
    );
    const todayRow = await db.get(
      `SELECT COUNT(*) AS count,
        COALESCE(SUM(CASE WHEN status IN ('approved','pending') THEN total ELSE 0 END),0) AS amount
       FROM refunds WHERE date(created_at) = ?`,
      [today]
    );
    const pendingRow = await db.get(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount),0) AS amount FROM refund_requests WHERE status = 'pending'`
    );
    const approvedN = await db.get(`SELECT COUNT(*) AS c FROM refunds WHERE status = 'approved'`);
    const rejectedN = await db.get(`SELECT COUNT(*) AS c FROM refunds WHERE status = 'rejected'`);
    const denom = Number(approvedN?.c || 0) + Number(rejectedN?.c || 0);
    const approval_rate_pct = denom > 0 ? round2((Number(approvedN.c) / denom) * 100) : 100;
    res.json({
      all_time: { count: Number(allRow?.count) || 0, amount: round2(Number(allRow?.amount) || 0) },
      today: { count: Number(todayRow?.count) || 0, amount: round2(Number(todayRow?.amount) || 0) },
      pending: { count: Number(pendingRow?.count) || 0, amount: round2(Number(pendingRow?.amount) || 0) },
      approval_rate_pct,
    });
  });

  router.get("/cashiers", requireAuth, requireRoles("admin", "accountant"), async (_req, res) => {
    const rows = await db.all(
      `SELECT DISTINCT u.id, u.username FROM refunds r JOIN users u ON u.id = r.cashier_id ORDER BY u.username`
    );
    res.json(rows);
  });

  router.post("/bulk", requireAuth, requireRoles("admin", "accountant"), async (req, res) => {
    const { ids, status, review_notes } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "مطلوب مصفوفة ids" });
    }
    if (status !== "approved" && status !== "rejected") {
      return res.status(400).json({ error: "status يجب أن يكون approved أو rejected" });
    }
    const note = review_notes != null ? String(review_notes).trim() : null;
    const results = { ok: [], failed: [] };
    for (const rawId of ids) {
      const id = Number(rawId);
      if (!id) continue;
      try {
        await db.run("BEGIN IMMEDIATE");
        const refund = await db.get("SELECT * FROM refunds WHERE id = ?", [id]);
        if (!refund || refund.status !== "pending") {
          await db.run("ROLLBACK");
          results.failed.push({ id, error: "غير قيد الانتظار" });
          continue;
        }
        const now = new Date().toISOString();
        if (status === "approved") {
          await applyApprovedRefundEffects(db, refund);
          await db.run(
            `UPDATE refunds SET status = 'approved', approved_at = ?, approved_by_id = ?, review_notes = COALESCE(?, review_notes),
             rejected_at = NULL, rejected_by_id = NULL WHERE id = ?`,
            [now, req.user.id, note, id]
          );
        } else {
          await db.run(
            `UPDATE refunds SET status = 'rejected', rejected_at = ?, rejected_by_id = ?, review_notes = COALESCE(?, review_notes),
             approved_at = NULL, approved_by_id = NULL WHERE id = ?`,
            [now, req.user.id, note, id]
          );
        }
        await db.run("COMMIT");
        results.ok.push(id);
      } catch (e) {
        try {
          await db.run("ROLLBACK");
        } catch (_) {}
        results.failed.push({ id, error: e.message || "فشل" });
      }
    }
    res.json({ success: true, results });
  });

  router.get("/", requireAuth, requireRoles("admin", "accountant"), async (req, res) => {
    const from =
      (typeof req.query.from === "string" && req.query.from.trim()) ||
      (typeof req.query.date_from === "string" && req.query.date_from.trim()) ||
      null;
    const to =
      (typeof req.query.to === "string" && req.query.to.trim()) ||
      (typeof req.query.date_to === "string" && req.query.date_to.trim()) ||
      null;
    const statusQ =
      typeof req.query.status === "string" && req.query.status.trim()
        ? req.query.status.trim().toLowerCase()
        : null;
    const cashierId =
      req.query.cashier_id != null && String(req.query.cashier_id).trim() !== ""
        ? Number(req.query.cashier_id)
        : null;
    const cashierNameRaw =
      typeof req.query.cashier_name === "string" ? req.query.cashier_name.trim() : "";
    const minAmount =
      req.query.min_amount != null && String(req.query.min_amount).trim() !== ""
        ? Number(req.query.min_amount)
        : null;
    const maxAmount =
      req.query.max_amount != null && String(req.query.max_amount).trim() !== ""
        ? Number(req.query.max_amount)
        : null;
    const q =
      typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : null;

    let sql = `SELECT r.*, u.username AS cashier_username, t.created_at AS original_sale_at
      FROM refunds r
      JOIN users u ON u.id = r.cashier_id
      JOIN transactions t ON t.id = r.original_transaction_id
      WHERE 1=1`;
    const params = [];
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
      sql += " AND date(r.created_at) >= ?";
      params.push(from);
    }
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
      sql += " AND date(r.created_at) <= ?";
      params.push(to);
    }
    if (statusQ && ["pending", "approved", "rejected"].includes(statusQ)) {
      sql += " AND r.status = ?";
      params.push(statusQ);
    }
    if (cashierId && !Number.isNaN(cashierId)) {
      sql += " AND r.cashier_id = ?";
      params.push(cashierId);
    }
    if (cashierNameRaw) {
      const low = cashierNameRaw.toLowerCase();
      const escaped = low.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
      sql += " AND lower(u.username) LIKE ? ESCAPE '\\'";
      params.push(`%${escaped}%`);
    }
    if (minAmount != null && !Number.isNaN(minAmount)) {
      sql += " AND r.total >= ?";
      params.push(minAmount);
    }
    if (maxAmount != null && !Number.isNaN(maxAmount)) {
      sql += " AND r.total <= ?";
      params.push(maxAmount);
    }
    if (q) {
      const n = Number(q);
      if (n && String(n) === q) {
        sql += " AND (r.original_transaction_id = ? OR r.id = ?)";
        params.push(n, n);
      } else {
        sql += " AND u.username LIKE ?";
        params.push(`%${q}%`);
      }
    }
    sql += " ORDER BY r.created_at DESC, r.id DESC";
    const rows = await db.all(sql, params);
    res.json(rows);
  });

  router.get("/:id/receipt", requireAuth, requireRoles("admin", "accountant"), async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    const refund = await db.get(
      `SELECT r.*, u.username AS cashier_username, au.username AS approved_by_name
       FROM refunds r
       JOIN users u ON u.id = r.cashier_id
       LEFT JOIN users au ON au.id = r.approved_by_id
       WHERE r.id = ?`,
      [id]
    );
    if (!refund) return res.status(404).json({ error: "غير موجود" });
    const originalTx = await db.get("SELECT * FROM transactions WHERE id = ?", [
      refund.original_transaction_id,
    ]);
    const html = buildReceiptHtml(
      refund,
      originalTx,
      refund.cashier_username || "",
      refund.approved_by_name || ""
    );
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  });

  router.get("/:id", requireAuth, requireRoles("admin", "accountant"), async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    const refund = await db.get(
      `SELECT r.*, u.username AS cashier_username,
        au.username AS approved_by_name, ru.username AS rejected_by_name
       FROM refunds r
       JOIN users u ON u.id = r.cashier_id
       LEFT JOIN users au ON au.id = r.approved_by_id
       LEFT JOIN users ru ON ru.id = r.rejected_by_id
       WHERE r.id = ?`,
      [id]
    );
    if (!refund) return res.status(404).json({ error: "غير موجود" });
    const original_transaction = await db.get("SELECT * FROM transactions WHERE id = ?", [
      refund.original_transaction_id,
    ]);
    let items_refunded = [];
    try {
      items_refunded = JSON.parse(refund.items_json);
    } catch {
      items_refunded = [];
    }
    if (!Array.isArray(items_refunded)) items_refunded = [];
    items_refunded = items_refunded.map((it) => ({
      product_name: it.name,
      product_id: it.product_id,
      quantity: it.quantity,
      price: it.price,
      line_total: round2(Number(it.quantity) * Number(it.price)),
    }));
    res.json({
      refund,
      original_transaction,
      items_refunded,
    });
  });

  router.put("/:id", requireAuth, requireRoles("admin", "accountant"), async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    const { status, review_notes } = req.body || {};
    if (status !== "approved" && status !== "rejected") {
      return res.status(400).json({ error: "status يجب أن يكون approved أو rejected" });
    }
    const note = review_notes != null ? String(review_notes).trim() : null;
    try {
      await db.run("BEGIN IMMEDIATE");
      const refund = await db.get("SELECT * FROM refunds WHERE id = ?", [id]);
      if (!refund) {
        await db.run("ROLLBACK");
        return res.status(404).json({ error: "غير موجود" });
      }
      if (refund.status !== "pending") {
        await db.run("ROLLBACK");
        return res.status(400).json({ error: "الطلب ليس قيد المراجعة" });
      }
      const now = new Date().toISOString();
      if (status === "approved") {
        await applyApprovedRefundEffects(db, refund);
        await db.run(
          `UPDATE refunds SET status = 'approved', approved_at = ?, approved_by_id = ?,
           review_notes = COALESCE(?, review_notes), rejected_at = NULL, rejected_by_id = NULL WHERE id = ?`,
          [now, req.user.id, note, id]
        );
      } else {
        await db.run(
          `UPDATE refunds SET status = 'rejected', rejected_at = ?, rejected_by_id = ?,
           review_notes = COALESCE(?, review_notes), approved_at = NULL, approved_by_id = NULL WHERE id = ?`,
          [now, req.user.id, note, id]
        );
      }
      await db.run("COMMIT");
      const row = await db.get(
        `SELECT r.*, u.username AS cashier_username FROM refunds r JOIN users u ON u.id = r.cashier_id WHERE r.id = ?`,
        [id]
      );
      res.json({ success: true, refund: row });
    } catch (e) {
      try {
        await db.run("ROLLBACK");
      } catch (_) {}
      console.error(e);
      res.status(500).json({ error: e.message || "فشل التحديث" });
    }
  });

  router.delete("/:id", requireAuth, requireRoles("admin", "accountant"), async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    const refund = await db.get("SELECT status FROM refunds WHERE id = ?", [id]);
    if (!refund) return res.status(404).json({ error: "غير موجود" });
    if (refund.status !== "pending") {
      return res.status(400).json({ error: "يمكن حذف الطلبات قيد الانتظار فقط" });
    }
    await db.run("DELETE FROM refunds WHERE id = ?", [id]);
    res.json({ success: true });
  });

  return router;
}
