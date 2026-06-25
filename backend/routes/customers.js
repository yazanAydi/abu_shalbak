import { Router } from "express";

import { requireAuth, requireAdmin, requireRoles } from "../middleware/auth.js";

import { round2 } from "../utils/tax.js";

import { importUploadMiddleware } from "../utils/importUpload.js";

import { handleCustomerBalanceUpload } from "./hesabatiUploadHandlers.js";

import {

  getBalanceGroupById,

  getBalanceGroupBySlug,

  getDefaultBalanceGroupId,

  slugFromLabel,

  uniqueSlug,

} from "../utils/balanceGroups.js";

import { customerHasLedgerActivity } from "../utils/balanceSheetImport.js";
import { ensureEntityCode } from "../utils/entityCodes.js";
import { buildCustomerLedger } from "../utils/customerLedger.js";
import { getAccountStatement } from "../utils/accountStatementService.js";
import {
  createStatementHistoryPreviewHandler,
  createStatementHistoryConfirmHandler,
} from "./statementHistoryHandlers.js";



const requireReports = requireRoles("admin", "accountant");



const CUSTOMER_CATEGORIES = ["retail", "wholesale", "vip", "credit", "corporate"];

function normalizeCategory(c) {

  return CUSTOMER_CATEGORIES.includes(String(c)) ? String(c) : "retail";

}



const CUSTOMER_SELECT = `

  SELECT c.*, g.label_ar AS balance_group_label, g.slug AS balance_group_slug

  FROM customers c

  LEFT JOIN customer_balance_groups g ON g.id = c.balance_group_id

`;



/**

 * @param {object} db

 * @param {import('express').Request} req

 */

async function resolveBalanceGroupFilter(db, req) {

  const { balance_group_id, group } = req.query;

  if (balance_group_id) {

    const id = Number(balance_group_id);

    if (Number.isFinite(id) && id > 0) {

      const row = await getBalanceGroupById(db, id);

      if (row) return { id: row.id, clause: " AND c.balance_group_id = ?", params: [row.id] };

    }

  }

  if (group) {

    const row = await getBalanceGroupBySlug(db, String(group));

    if (row) return { id: row.id, clause: " AND c.balance_group_id = ?", params: [row.id] };

  }

  return { id: null, clause: "", params: [] };

}



export function createCustomersRouter(db) {

  const router = Router();



  router.get("/", requireAuth, async (req, res) => {

    const { q } = req.query;

    const groupFilter = await resolveBalanceGroupFilter(db, req);

    const params = [...groupFilter.params];



    let sql = `${CUSTOMER_SELECT} WHERE 1=1${groupFilter.clause}`;

    if (q) {

      const like = `%${q}%`;

      sql += " AND (c.name LIKE ? OR c.phone LIKE ? OR c.customer_code LIKE ?)";

      params.push(like, like, like);

    }

    sql += q ? " ORDER BY c.id ASC LIMIT 100" : " ORDER BY c.id ASC LIMIT 500";



    const rows = await db.all(sql, params);

    res.json(rows);

  });



  router.get("/meta/categories", requireAuth, (_req, res) => {

    res.json({

      categories: CUSTOMER_CATEGORIES,

      labels: {

        retail: "مفرق",

        wholesale: "جملة",

        vip: "مميز VIP",

        credit: "عميل آجل",

        corporate: "شركات",

      },

    });

  });



  router.get("/meta/balance-groups", requireAuth, async (_req, res) => {

    const rows = await db.all(

      `SELECT id, slug, label_ar, sort_order, is_system, active, created_at

       FROM customer_balance_groups

       WHERE active = 1

       ORDER BY sort_order, id`

    );

    res.json(rows);

  });



  router.post("/meta/balance-groups", requireAuth, requireAdmin, async (req, res) => {

    const label_ar = String(req.body?.label_ar || "").trim();

    if (!label_ar) {

      return res.status(400).json({ error: "اسم الفئة مطلوب", code: "VALIDATION_ERROR" });

    }

    const maxSort = await db.get("SELECT COALESCE(MAX(sort_order), 0) AS m FROM customer_balance_groups");

    const sort_order = Number(req.body?.sort_order) || Number(maxSort?.m || 0) + 1;

    const baseSlug = slugFromLabel(label_ar);

    const slug = await uniqueSlug(db, baseSlug);

    const ins = await db.run(

      "INSERT INTO customer_balance_groups (slug, label_ar, sort_order, is_system) VALUES (?, ?, ?, 0)",

      [slug, label_ar, sort_order]

    );

    const row = await db.get("SELECT * FROM customer_balance_groups WHERE id = ?", [ins.lastID]);

    res.status(201).json(row);

  });



  router.put("/meta/balance-groups/:id", requireAuth, requireAdmin, async (req, res) => {

    const existing = await getBalanceGroupById(db, req.params.id);

    if (!existing) {

      return res.status(404).json({ error: "الفئة غير موجودة", code: "NOT_FOUND" });

    }

    const label_ar =

      req.body?.label_ar !== undefined ? String(req.body.label_ar).trim() : existing.label_ar;

    if (!label_ar) {

      return res.status(400).json({ error: "اسم الفئة مطلوب", code: "VALIDATION_ERROR" });

    }

    const sort_order =

      req.body?.sort_order !== undefined ? Number(req.body.sort_order) : existing.sort_order;

    const active = req.body?.active !== undefined ? (req.body.active ? 1 : 0) : existing.active;

    await db.run(

      "UPDATE customer_balance_groups SET label_ar = ?, sort_order = ?, active = ? WHERE id = ?",

      [label_ar, sort_order, active, existing.id]

    );

    const row = await db.get("SELECT * FROM customer_balance_groups WHERE id = ?", [existing.id]);

    res.json(row);

  });



  router.delete("/meta/balance-groups/:id", requireAuth, requireAdmin, async (req, res) => {

    const existing = await getBalanceGroupById(db, req.params.id);

    if (!existing) {

      return res.status(404).json({ error: "الفئة غير موجودة", code: "NOT_FOUND" });

    }

    if (existing.is_system) {

      return res.status(400).json({ error: "لا يمكن حذف فئة النظام", code: "SYSTEM_GROUP" });

    }

    const usage = await db.get(

      "SELECT COUNT(*) AS c FROM customers WHERE balance_group_id = ?",

      [existing.id]

    );

    if (usage.c > 0) {

      return res.status(400).json({

        error: "لا يمكن حذف فئة مرتبطة بعملاء",

        code: "GROUP_IN_USE",

      });

    }

    await db.run("DELETE FROM customer_balance_groups WHERE id = ?", [existing.id]);

    res.json({ success: true });

  });



  router.get("/balances", requireAuth, requireReports, async (req, res) => {

    const onlyOpen = String(req.query.only_open || "") === "1";

    const groupFilter = await resolveBalanceGroupFilter(db, req);

    const params = [...groupFilter.params];



    const whereParts = [];

    if (onlyOpen) whereParts.push("ABS(c.balance) > 0.009");

    if (groupFilter.clause) whereParts.push("c.balance_group_id = ?");

    const whereSql = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";



    const rows = await db.all(

      `SELECT c.id, c.customer_code, c.name, c.phone, c.price_category, c.credit_limit, c.balance,

              c.balance_group_id, g.label_ar AS balance_group_label, g.slug AS balance_group_slug

       FROM customers c

       LEFT JOIN customer_balance_groups g ON g.id = c.balance_group_id

       ${whereSql}

       ORDER BY c.balance DESC, c.name`,

      params

    );



    const totalsParams = [...groupFilter.params];

    const totalsWhere = groupFilter.clause

      ? `WHERE c.balance_group_id = ?`

      : "";

    const totals = await db.get(

      `SELECT COALESCE(SUM(CASE WHEN c.balance > 0 THEN c.balance ELSE 0 END),0) AS total_due,

              COALESCE(SUM(CASE WHEN c.balance < 0 THEN -c.balance ELSE 0 END),0) AS total_credit

       FROM customers c

       ${totalsWhere}`,

      totalsParams

    );



    const groupTotals = await db.all(

      `SELECT g.id, g.slug, g.label_ar,

              COALESCE(SUM(CASE WHEN c.balance > 0 THEN c.balance ELSE 0 END),0) AS total_due,

              COALESCE(SUM(CASE WHEN c.balance < 0 THEN -c.balance ELSE 0 END),0) AS total_credit,

              COUNT(c.id) AS customer_count

       FROM customer_balance_groups g

       LEFT JOIN customers c ON c.balance_group_id = g.id

       WHERE g.active = 1

       GROUP BY g.id

       ORDER BY g.sort_order, g.id`

    );



    res.json({

      customers: rows,

      total_due: round2(Number(totals?.total_due) || 0),

      total_credit: round2(Number(totals?.total_credit) || 0),

      group_totals: groupTotals.map((g) => ({

        ...g,

        total_due: round2(Number(g.total_due) || 0),

        total_credit: round2(Number(g.total_credit) || 0),

      })),

    });

  });



  router.post("/upload", requireAuth, requireAdmin, importUploadMiddleware(), async (req, res) => {

    await handleCustomerBalanceUpload(db, req, res);

  });



  router.get("/:id", requireAuth, async (req, res) => {

    const row = await db.get(`${CUSTOMER_SELECT} WHERE c.id = ?`, [req.params.id]);

    if (!row) return res.status(404).json({ error: "العميل غير موجود", code: "NOT_FOUND" });

    res.json(row);

  });



  router.post("/", requireAuth, requireAdmin, async (req, res) => {

    const {

      name, phone, phone2, address, city, price_category, credit_limit, notes,

      customer_code, payment_terms, opening_balance, balance_group_id,

    } = req.body || {};

    if (!name || !String(name).trim()) {

      return res.status(400).json({ error: "اسم العميل مطلوب", code: "VALIDATION_ERROR" });

    }

    const limit = Number(credit_limit) || 0;

    const opening = round2(Number(opening_balance) || 0);

    let groupId = balance_group_id != null ? Number(balance_group_id) : null;

    if (!groupId || !Number.isFinite(groupId)) {

      groupId = await getDefaultBalanceGroupId(db);

    } else {

      const g = await getBalanceGroupById(db, groupId);

      if (!g) groupId = await getDefaultBalanceGroupId(db);

    }

    const ins = await db.run(

      `INSERT INTO customers

        (name, phone, phone2, address, city, price_category, credit_limit, notes,

         customer_code, payment_terms, opening_balance, balance, balance_group_id)

       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

      [

        String(name).trim(),

        phone || null,

        phone2 || null,

        address || null,

        city || null,

        normalizeCategory(price_category),

        limit,

        notes || null,

        await ensureEntityCode(db, "customer", customer_code),

        payment_terms || null,

        opening,

        opening,

        groupId,

      ]

    );

    const row = await db.get(`${CUSTOMER_SELECT} WHERE c.id = ?`, [ins.lastID]);

    res.status(201).json(row);

  });



  router.put("/:id", requireAuth, requireAdmin, async (req, res) => {

    const existing = await db.get("SELECT * FROM customers WHERE id = ?", [req.params.id]);

    if (!existing) return res.status(404).json({ error: "العميل غير موجود", code: "NOT_FOUND" });

    const b = req.body || {};

    const name = b.name !== undefined ? String(b.name).trim() : existing.name;

    const phone = b.phone !== undefined ? (b.phone || null) : existing.phone;

    const phone2 = b.phone2 !== undefined ? (b.phone2 || null) : existing.phone2;

    const address = b.address !== undefined ? (b.address || null) : existing.address;

    const city = b.city !== undefined ? (b.city || null) : existing.city;

    const price_category = b.price_category !== undefined ? normalizeCategory(b.price_category) : existing.price_category;

    const credit_limit = b.credit_limit !== undefined ? Number(b.credit_limit) : existing.credit_limit;

    const no_credit = b.no_credit !== undefined ? (b.no_credit ? 1 : 0) : existing.no_credit;

    const notes = b.notes !== undefined ? (b.notes || null) : existing.notes;

    const customer_code = b.customer_code !== undefined ? (b.customer_code ? String(b.customer_code).trim() : null) : existing.customer_code;

    const payment_terms = b.payment_terms !== undefined ? (b.payment_terms || null) : existing.payment_terms;

    let balance_group_id = existing.balance_group_id;

    if (b.balance_group_id !== undefined) {

      const gid = Number(b.balance_group_id);

      if (Number.isFinite(gid) && gid > 0) {

        const g = await getBalanceGroupById(db, gid);

        if (g) balance_group_id = g.id;

      }

    }

    await db.run(

      `UPDATE customers SET name=?, phone=?, phone2=?, address=?, city=?, price_category=?,

          credit_limit=?, no_credit=?, notes=?, customer_code=?, payment_terms=?, balance_group_id=? WHERE id=?`,

      [name, phone, phone2, address, city, price_category, credit_limit, no_credit, notes, customer_code, payment_terms, balance_group_id, req.params.id]

    );

    const row = await db.get(`${CUSTOMER_SELECT} WHERE c.id = ?`, [req.params.id]);

    res.json(row);

  });



  router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {

    const existing = await db.get("SELECT * FROM customers WHERE id = ?", [req.params.id]);

    if (!existing) return res.status(404).json({ error: "العميل غير موجود", code: "NOT_FOUND" });

    const hasActivity = await customerHasLedgerActivity(db, existing.id);

    if (hasActivity) {

      return res.status(400).json({

        error: "لا يمكن حذف عميل له حركات محاسبية (مبيعات أو سندات)",

        code: "HAS_LEDGER_ACTIVITY",

      });

    }

    await db.run("DELETE FROM customers WHERE id = ?", [req.params.id]);

    res.json({ success: true });

  });



  router.get("/:id/ledger", requireAuth, requireReports, async (req, res) => {

    const { from, to } = req.query;

    const customer = await db.get(`${CUSTOMER_SELECT} WHERE c.id = ?`, [req.params.id]);

    if (!customer) return res.status(404).json({ error: "العميل غير موجود", code: "NOT_FOUND" });

    const ledger = await buildCustomerLedger(db, customer, from, to);

    res.json({ customer, ...ledger });

  });

  router.post(
    "/:id/statement-history/preview",
    requireAuth,
    requireAdmin,
    importUploadMiddleware(),
    createStatementHistoryPreviewHandler(db, "customer")
  );

  router.post(
    "/:id/statement-history/confirm",
    requireAuth,
    requireAdmin,
    importUploadMiddleware(),
    createStatementHistoryConfirmHandler(db, "customer")
  );



  router.get("/:id/statement", requireAuth, requireReports, async (req, res) => {

    const { from, to, page, pageSize } = req.query;

    const customer = await db.get(`${CUSTOMER_SELECT} WHERE c.id = ?`, [req.params.id]);

    if (!customer) return res.status(404).json({ error: "العميل غير موجود", code: "NOT_FOUND" });

    try {
      const report = await getAccountStatement(db, {
        partyType: "customer",
        partyId: customer.id,
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



  router.get("/:id/payments", requireAuth, requireReports, async (req, res) => {

    const customer = await db.get("SELECT * FROM customers WHERE id = ?", [req.params.id]);

    if (!customer) return res.status(404).json({ error: "العميل غير موجود", code: "NOT_FOUND" });

    const rows = await db.all(

      `SELECT v.id AS voucher_id, v.voucher_no, v.voucher_date, v.status,

              vl.amount, vl.amount_nis, vl.line_type, vl.description, u.username AS recorded_by

       FROM voucher_lines vl

       JOIN vouchers v ON v.id = vl.voucher_id

       LEFT JOIN users u ON u.id = v.recorded_by_id

       WHERE vl.customer_id = ? AND v.voucher_type = 'receipt'

       ORDER BY v.voucher_date DESC, v.id DESC`,

      [req.params.id]

    );

    res.json(rows);

  });



  router.post("/:id/payment", requireAuth, requireAdmin, async (req, res) => {

    const customer = await db.get("SELECT * FROM customers WHERE id = ?", [req.params.id]);

    if (!customer) return res.status(404).json({ error: "العميل غير موجود", code: "NOT_FOUND" });

    const amount = Number(req.body?.amount);

    if (!Number.isFinite(amount) || amount <= 0) {

      return res.status(400).json({ error: "المبلغ غير صالح", code: "VALIDATION_ERROR" });

    }

    const newBalance = round2(customer.balance - amount);

    await db.run("UPDATE customers SET balance = ? WHERE id = ?", [newBalance, customer.id]);

    res.json({ success: true, new_balance: newBalance });

  });



  return router;

}

