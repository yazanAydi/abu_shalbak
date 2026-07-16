import { Router } from "express";
import XLSX from "xlsx";
import { requireAuth, requireAdmin, requireReportsPermission } from "../middleware/auth.js";
import { round2 } from "../utils/tax.js";
import { getAccountStatement, parseStatementDate } from "../utils/accountStatementService.js";
import { importUploadMiddleware } from "../utils/importUpload.js";
import { handleSupplierBalanceUpload } from "./hesabatiUploadHandlers.js";
import { ensureEntityCode } from "../utils/entityCodes.js";
import { buildSupplierLedger } from "../utils/supplierLedger.js";
import { buildSupplierStatementLedger } from "../utils/supplierStatementLedger.js";
import { shopTodayYmd } from "../utils/shopTime.js";
import {
  createStatementHistoryPreviewHandler,
  createStatementHistoryConfirmHandler,
} from "./statementHistoryHandlers.js";
import {
  STORE_LICENSE_LINE,
  STORE_NAME_AR,
  STORE_PHONE,
} from "../utils/storeBranding.js";

const MOVEMENT_TYPE_AR = {
  opening_balance: "رصيد افتتاحي",
  purchase_invoice: "فاتورة مشتريات",
  supplier_payment: "سند دفع",
  purchase_return: "مرتجع مشتريات",
  adjustment: "تسوية يدوية",
};

/**
 * Supplier master data + ledger.
 * supplier.balance is positive when WE OWE the supplier (a payable).
 */
export function createSuppliersRouter(db) {
  const requireFinance = requireReportsPermission(db, "finance");
  const requireAccountStatement = requireReportsPermission(db, "account_statement");
  const router = Router();

  router.get("/", requireAuth, async (req, res) => {
    const { q } = req.query;
    let rows;
    if (q) {
      const like = `%${q}%`;
      rows = await db.all(
        `SELECT * FROM suppliers WHERE name LIKE ? OR contact_phone LIKE ? OR supplier_code LIKE ? ORDER BY id ASC LIMIT 200`,
        [like, like, like]
      );
    } else {
      rows = await db.all("SELECT * FROM suppliers ORDER BY id ASC LIMIT 500");
    }
    res.json(rows);
  });

  router.get("/balances", requireAuth, requireFinance, async (req, res) => {
    const onlyOpen = String(req.query.only_open || "") === "1";
    const rows = await db.all(
      `SELECT id, supplier_code, name, contact_phone, balance
       FROM suppliers
       ${onlyOpen ? "WHERE ABS(balance) > 0.009" : ""}
       ORDER BY balance DESC, name`
    );
    const totals = await db.get(
      `SELECT COALESCE(SUM(CASE WHEN balance > 0 THEN balance ELSE 0 END),0) AS total_payable,
              COALESCE(SUM(CASE WHEN balance < 0 THEN -balance ELSE 0 END),0) AS total_advance
       FROM suppliers`
    );
    res.json({
      suppliers: rows,
      total_payable: round2(Number(totals?.total_payable) || 0),
      total_advance: round2(Number(totals?.total_advance) || 0),
    });
  });

  router.post("/upload", requireAuth, requireAdmin, importUploadMiddleware(), async (req, res) => {
    await handleSupplierBalanceUpload(db, req, res);
  });

  router.post(
    "/:id/statement-history/preview",
    requireAuth,
    requireAdmin,
    importUploadMiddleware(),
    createStatementHistoryPreviewHandler(db, "supplier")
  );

  router.post(
    "/:id/statement-history/confirm",
    requireAuth,
    requireAdmin,
    importUploadMiddleware(),
    createStatementHistoryConfirmHandler(db, "supplier")
  );

  router.get("/:id", requireAuth, async (req, res) => {
    const row = await db.get("SELECT * FROM suppliers WHERE id = ?", [req.params.id]);
    if (!row) return res.status(404).json({ error: "المورد غير موجود", code: "NOT_FOUND" });
    res.json(row);
  });

  router.post("/", requireAuth, requireAdmin, async (req, res) => {
    const b = req.body || {};
    const name = b.name ? String(b.name).trim() : "";
    if (!name) return res.status(400).json({ error: "اسم المورد مطلوب", code: "VALIDATION_ERROR" });
    const phone = b.contact_phone ?? b.phone ?? null;
    const opening = round2(Number(b.opening_balance) || 0);
    const ins = await db.run(
      `INSERT INTO suppliers
         (name, contact_phone, contact_email, notes, supplier_code, address, payment_terms, opening_balance, balance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        phone || null,
        b.contact_email || null,
        b.notes || null,
        await ensureEntityCode(db, "supplier", b.supplier_code),
        b.address || null,
        b.payment_terms || null,
        opening,
        opening,
      ]
    );
    const row = await db.get("SELECT * FROM suppliers WHERE id = ?", [ins.lastID]);
    res.status(201).json(row);
  });

  router.put("/:id", requireAuth, requireAdmin, async (req, res) => {
    const ex = await db.get("SELECT * FROM suppliers WHERE id = ?", [req.params.id]);
    if (!ex) return res.status(404).json({ error: "المورد غير موجود", code: "NOT_FOUND" });
    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : ex.name;
    if (!name) return res.status(400).json({ error: "اسم المورد مطلوب", code: "VALIDATION_ERROR" });
    const phone = b.contact_phone !== undefined ? (b.contact_phone || null) : (b.phone !== undefined ? (b.phone || null) : ex.contact_phone);
    const email = b.contact_email !== undefined ? (b.contact_email || null) : ex.contact_email;
    const notes = b.notes !== undefined ? (b.notes || null) : ex.notes;
    const code = b.supplier_code !== undefined ? (b.supplier_code ? String(b.supplier_code).trim() : null) : ex.supplier_code;
    const address = b.address !== undefined ? (b.address || null) : ex.address;
    const terms = b.payment_terms !== undefined ? (b.payment_terms || null) : ex.payment_terms;
    await db.run(
      `UPDATE suppliers SET name=?, contact_phone=?, contact_email=?, notes=?, supplier_code=?, address=?, payment_terms=? WHERE id=?`,
      [name, phone, email, notes, code, address, terms, req.params.id]
    );
    const row = await db.get("SELECT * FROM suppliers WHERE id = ?", [req.params.id]);
    res.json(row);
  });

  router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
    const ex = await db.get("SELECT * FROM suppliers WHERE id = ?", [req.params.id]);
    if (!ex) return res.status(404).json({ error: "المورد غير موجود", code: "NOT_FOUND" });
    if (Math.abs(Number(ex.balance) || 0) > 0.009) {
      return res.status(400).json({ error: "لا يمكن حذف مورد برصيد غير صفري", code: "NON_ZERO_BALANCE" });
    }
    const inv = await db.get("SELECT COUNT(*) AS n FROM purchase_invoices WHERE supplier_id = ?", [req.params.id]);
    if (inv.n > 0) return res.status(400).json({ error: "لا يمكن حذف مورد له فواتير", code: "HAS_INVOICES" });
    await db.run("DELETE FROM suppliers WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  router.get("/:id/ledger", requireAuth, requireFinance, async (req, res) => {
    const supplier = await db.get("SELECT * FROM suppliers WHERE id = ?", [req.params.id]);
    if (!supplier) return res.status(404).json({ error: "المورد غير موجود", code: "NOT_FOUND" });
    const { from, to } = req.query;
    const led = await buildSupplierLedger(db, supplier, from, to);
    res.json({ supplier, ...led });
  });

  router.get("/:id/statement", requireAuth, requireAccountStatement, async (req, res) => {
    const supplier = await db.get("SELECT * FROM suppliers WHERE id = ?", [req.params.id]);
    if (!supplier) return res.status(404).json({ error: "المورد غير موجود", code: "NOT_FOUND" });
    const { from, to, page, pageSize } = req.query;
    try {
      const report = await getAccountStatement(db, {
        partyType: "supplier",
        partyId: supplier.id,
        from,
        to,
        page,
        pageSize,
        useDefaultRange: false,
      });
      res.json(report);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, code: e.code || "INTERNAL_ERROR" });
    }
  });

  // Detailed supplier statement / ledger (system sign, enriched, drill-down ready).
  // Separate from /statement (Hesabati format) to avoid breaking the existing modal.
  async function buildStatementResponse(req, supplier) {
    const from = parseStatementDate(req.query.from);
    const to = parseStatementDate(req.query.to);
    if (req.query.from && !from) {
      const err = new Error("from تاريخ غير صالح");
      err.status = 400;
      throw err;
    }
    if (req.query.to && !to) {
      const err = new Error("to تاريخ غير صالح");
      err.status = 400;
      throw err;
    }
    if (from && to && from > to) {
      const err = new Error("تاريخ البداية يجب أن يكون قبل تاريخ النهاية");
      err.status = 400;
      throw err;
    }

    const ledger = await buildSupplierStatementLedger(db, supplier, { from, to });

    const typeFilter = req.query.type ? String(req.query.type).trim() : null;
    const search = req.query.search ? String(req.query.search).trim().toLowerCase() : null;

    let movements = ledger.movements;
    if (typeFilter) movements = movements.filter((m) => m.type === typeFilter);
    if (search) {
      movements = movements.filter(
        (m) =>
          (m.documentNo && String(m.documentNo).toLowerCase().includes(search)) ||
          (m.documentId != null && String(m.documentId).includes(search)) ||
          (m.description && m.description.toLowerCase().includes(search))
      );
    }

    return {
      from,
      to,
      filteredMovements: movements,
      ledger,
    };
  }

  function statementEnvelope(supplier, from, to, ledger, movements, pagination) {
    return {
      store_name: STORE_NAME_AR,
      store_phone: STORE_PHONE,
      store_license: STORE_LICENSE_LINE,
      report_title: "كشف حساب المورد",
      generated_at: new Date().toISOString(),
      date_from: from,
      date_to: to,
      supplier: {
        id: supplier.id,
        name: supplier.name,
        phone: supplier.contact_phone || null,
        address: supplier.address || null,
        currentBalance: round2(Number(supplier.balance) || 0),
      },
      summary: {
        openingBalance: ledger.openingBalance,
        totalDebit: ledger.totalDebit,
        totalCredit: ledger.totalCredit,
        totalInvoices: ledger.totalInvoices,
        totalPayments: ledger.totalPayments,
        finalBalance: ledger.finalBalance,
      },
      movements,
      pagination,
    };
  }

  router.get("/:id/statement-ledger", requireAuth, requireAccountStatement, async (req, res) => {
    const supplier = await db.get("SELECT * FROM suppliers WHERE id = ?", [req.params.id]);
    if (!supplier) return res.status(404).json({ error: "المورد غير موجود", code: "NOT_FOUND" });
    try {
      const { from, to, filteredMovements, ledger } = await buildStatementResponse(req, supplier);

      const limit = req.query.limit
        ? Math.min(1000, Math.max(1, Number(req.query.limit) || 0))
        : null;
      const page = limit ? Math.max(1, Number(req.query.page) || 1) : 1;
      const totalRows = filteredMovements.length;
      let movements = filteredMovements;
      let pagination = null;
      if (limit) {
        const start = (page - 1) * limit;
        movements = filteredMovements.slice(start, start + limit);
        pagination = { page, limit, totalRows, totalPages: Math.ceil(totalRows / limit) || 1 };
      }

      res.json(statementEnvelope(supplier, from, to, ledger, movements, pagination));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, code: e.code || "INTERNAL_ERROR" });
    }
  });

  router.get("/:id/statement-ledger/excel", requireAuth, requireAccountStatement, async (req, res) => {
    const supplier = await db.get("SELECT * FROM suppliers WHERE id = ?", [req.params.id]);
    if (!supplier) return res.status(404).json({ error: "المورد غير موجود", code: "NOT_FOUND" });
    try {
      const { filteredMovements, ledger } = await buildStatementResponse(req, supplier);
      const sheetRows = [
        [
          "التاريخ",
          "نوع الحركة",
          "رقم المستند",
          "البيان",
          "مدين",
          "دائن",
          "الرصيد",
          "طريقة الدفع",
          "المستخدم",
        ],
        ...filteredMovements.map((m) => [
          m.date || "",
          MOVEMENT_TYPE_AR[m.type] || m.type,
          m.documentNo || "",
          m.description || "",
          m.debit || 0,
          m.credit || 0,
          m.runningBalance,
          m.paymentMethod || "",
          m.createdBy || "",
        ]),
        [],
        ["", "", "", "الإجمالي", ledger.totalDebit, ledger.totalCredit, ledger.finalBalance, "", ""],
      ];
      const ws = XLSX.utils.aoa_to_sheet(sheetRows);
      ws["!rtl"] = true;
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "كشف حساب المورد");
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      const fname = `supplier-statement-${supplier.id}.xlsx`;
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
      res.send(buf);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, code: e.code || "INTERNAL_ERROR" });
    }
  });

  // Products purchased from this supplier, grouped by each posted purchase invoice.
  router.get("/:id/purchase-items", requireAuth, requireFinance, async (req, res) => {
    const supplier = await db.get("SELECT id, name FROM suppliers WHERE id = ?", [req.params.id]);
    if (!supplier) return res.status(404).json({ error: "المورد غير موجود", code: "NOT_FOUND" });
    const { from, to } = req.query;
    const params = [supplier.id];
    let dateFilter = "";
    if (from) { dateFilter += " AND pi.invoice_date >= ?"; params.push(from); }
    if (to) { dateFilter += " AND pi.invoice_date <= ?"; params.push(to); }
    const rows = await db.all(
      `SELECT pi.id AS invoice_id, pi.invoice_no, pi.invoice_date, pi.total AS invoice_total,
              pii.product_id, p.name AS product_name, p.barcode,
              pii.quantity, pii.unit_cost, pii.line_total
       FROM purchase_invoice_items pii
       JOIN purchase_invoices pi ON pi.id = pii.invoice_id AND pi.status = 'posted'
       JOIN products p ON p.id = pii.product_id
       WHERE pi.supplier_id = ?${dateFilter}
       ORDER BY pi.invoice_date DESC, pi.id DESC, pii.id ASC`,
      params
    );
    const byInvoice = new Map();
    for (const r of rows) {
      if (!byInvoice.has(r.invoice_id)) {
        byInvoice.set(r.invoice_id, {
          invoice_id: r.invoice_id,
          invoice_no: r.invoice_no,
          invoice_date: r.invoice_date,
          invoice_total: r.invoice_total,
          items: [],
        });
      }
      byInvoice.get(r.invoice_id).items.push({
        product_id: r.product_id,
        product_name: r.product_name,
        barcode: r.barcode,
        quantity: r.quantity,
        unit_cost: r.unit_cost,
        line_total: r.line_total,
      });
    }
    res.json({ supplier, invoices: Array.from(byInvoice.values()) });
  });

  // Manual balance adjustment. credit raises what we owe; debit lowers it.
  router.post("/:id/adjustments", requireAuth, requireAdmin, async (req, res) => {
    const supplier = await db.get("SELECT * FROM suppliers WHERE id = ?", [req.params.id]);
    if (!supplier) return res.status(404).json({ error: "المورد غير موجود", code: "NOT_FOUND" });

    const b = req.body || {};
    const direction = String(b.direction || "").trim().toLowerCase();
    if (direction !== "credit" && direction !== "debit") {
      return res.status(400).json({ error: "نوع التسوية غير صالح", code: "VALIDATION_ERROR" });
    }
    const amount = round2(Number(b.amount) || 0);
    if (!(amount > 0)) {
      return res.status(400).json({ error: "المبلغ يجب أن يكون أكبر من صفر", code: "VALIDATION_ERROR" });
    }
    const entryDate = b.entry_date
      ? parseStatementDate(b.entry_date)
      : shopTodayYmd();
    if (b.entry_date && !entryDate) {
      return res.status(400).json({ error: "التاريخ غير صالح", code: "VALIDATION_ERROR" });
    }
    const notes = b.notes ? String(b.notes).trim() || null : null;
    const credit = direction === "credit" ? amount : 0;
    const debit = direction === "debit" ? amount : 0;

    await db.run("BEGIN IMMEDIATE");
    try {
      const ins = await db.run(
        `INSERT INTO supplier_adjustments (supplier_id, entry_date, debit, credit, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [supplier.id, entryDate, debit, credit, notes, req.user.id]
      );
      await db.run(
        "UPDATE suppliers SET balance = balance + ? - ? WHERE id = ?",
        [credit, debit, supplier.id]
      );
      await db.run("COMMIT");
      res.status(201).json(await db.get("SELECT * FROM supplier_adjustments WHERE id = ?", [ins.lastID]));
    } catch (e) {
      try { await db.run("ROLLBACK"); } catch (_) {}
      res.status(500).json({ error: e.message, code: "DB_ERROR" });
    }
  });

  return router;
}
