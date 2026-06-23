import { Router } from "express";
import multer from "multer";
import bcrypt from "bcrypt";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { isValidRole, USER_ROLES } from "../utils/roles.js";
import {
  csvBufferToRecords,
  normalizeProductRow,
  xlsxBufferToHeaderRows,
} from "../utils/productImport.js";
import { logAudit, AUDIT_ACTIONS } from "../utils/auditLog.js";
import { createBackup } from "../utils/backup.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALLOWED_IMPORT_MIMES = new Set([
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream", // some browsers send this for .csv/.xlsx
  "",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  // 10MB is ample for product catalogs; smaller cap reduces DoS surface.
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || "").toLowerCase();
    const okExt = name.endsWith(".csv") || name.endsWith(".xlsx");
    const okMime = ALLOWED_IMPORT_MIMES.has(String(file.mimetype || ""));
    if (okExt && okMime) return cb(null, true);
    cb(new Error("صيغة الملف غير مدعومة. استخدم CSV أو XLSX فقط."));
  },
});

export function createAdminRouter(db, dbPath) {
  const router = Router();

  router.use(requireAuth, requireAdmin);

  router.post(
    "/products/upload",
    (req, res, next) => {
      upload.single("file")(req, res, (err) => {
        if (err) {
          return res.status(400).json({
            error: err.message || "فشل الرفع",
            code: err.code,
          });
        }
        next();
      });
    },
    async (req, res, next) => {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "الملف مطلوب (اسم الحقل: file)" });
    }

    const name = String(req.file.originalname || "").toLowerCase();
    const mime = String(req.file.mimetype || "");
    const isXlsx =
      name.endsWith(".xlsx") ||
      mime ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    let records;
    try {
      if (isXlsx) {
        records = xlsxBufferToHeaderRows(req.file.buffer);
      } else {
        records = csvBufferToRecords(req.file.buffer);
      }
    } catch (e) {
      return res.status(400).json({
        error: isXlsx ? "فشل تحليل ملف Excel" : "فشل تحليل ملف CSV",
        detail: e.message,
      });
    }

    if (!records.length) {
      return res.status(400).json({ error: "لا توجد صفوف بيانات" });
    }

    const errors = [];
    let inserted = 0;
    let skipped = 0;

    /** Barcodes already queued in this upload — avoids SQLITE_CONSTRAINT when the file repeats a barcode */
    const seenInFile = new Set();

    const validRows = [];
    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const norm = normalizeProductRow(row);
      if (!norm.ok) {
        errors.push({ row: i + 2, reason: norm.reason });
        skipped++;
        continue;
      }
      const { barcode, name, name_en, price, cost, category, stock, tax_rate, unit, expiry_date, min_price, max_price } = norm.row;

      if (seenInFile.has(barcode)) {
        errors.push({
          row: i + 2,
          barcode,
          reason: "باركود مكرر في الملف — تُركت أول مرة",
        });
        skipped++;
        continue;
      }

      const dup = await db.get("SELECT id FROM products WHERE barcode = ?", [barcode]);
      if (dup) {
        errors.push({ row: i + 2, barcode, reason: "الباركود مكرر — موجود في قاعدة البيانات" });
        skipped++;
        continue;
      }

      seenInFile.add(barcode);
      validRows.push({ barcode, name, name_en, price, cost, category, stock, tax_rate, unit, expiry_date, min_price, max_price });
    }

    try {
      await db.run("BEGIN IMMEDIATE");
      for (const r of validRows) {
        await db.run(
          `INSERT INTO products (barcode, name, name_en, price, cost, category, stock, tax_rate, unit, expiry_date, min_price, max_price)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.barcode, r.name, r.name_en ?? null, r.price, r.cost, r.category, r.stock,
           r.tax_rate ?? null, r.unit ?? null, r.expiry_date ?? null, r.min_price ?? null, r.max_price ?? null]
        );
        inserted++;
      }
      await db.run("COMMIT");
    } catch (e) {
      try {
        await db.run("ROLLBACK");
      } catch (_) {}
      return next(e);
    }

    res.json({
      success: true,
      inserted,
      skipped,
      errors,
      message: `تم رفع ${inserted} منتجاً بنجاح`,
    });
    }
  );

  router.delete("/products/:id", async (req, res, next) => {
    try {
      const existing = await db.get("SELECT * FROM products WHERE id = ?", [req.params.id]);
      if (!existing) return res.status(404).json({ error: "غير موجود" });
      const info = await db.run("DELETE FROM products WHERE id = ?", [req.params.id]);
      if (info.changes === 0) return res.status(404).json({ error: "غير موجود" });
      await logAudit(db, req, AUDIT_ACTIONS.PRODUCT_DELETE, "products", req.params.id, existing, null);
      res.status(204).send();
    } catch (e) {
      next(e);
    }
  });

  router.get("/roles", (_req, res) => {
    res.json({ roles: USER_ROLES });
  });

  router.get("/users", async (_req, res) => {
    const rows = await db.all(
      "SELECT id, username, role, created_at FROM users ORDER BY username"
    );
    res.json(rows);
  });

  router.post("/users", async (req, res) => {
    const { username, password, role } = req.body || {};
    if (!username?.trim() || !password || !role) {
      return res.status(400).json({ error: "اسم المستخدم وكلمة المرور والدور مطلوبة" });
    }
    if (!isValidRole(role)) {
      return res.status(400).json({ error: "دور غير صالح", allowed: USER_ROLES });
    }
    const hash = await bcrypt.hash(String(password), 10);
    try {
      const info = await db.run(
        "INSERT INTO users (username, password, role) VALUES (?, ?, ?)",
        [String(username).trim(), hash, role]
      );
      const row = await db.get(
        "SELECT id, username, role, created_at FROM users WHERE id = ?",
        [info.lastID]
      );
      await logAudit(db, req, AUDIT_ACTIONS.USER_CREATE, "users", row.id, null, { username: row.username, role: row.role });
      res.status(201).json(row);
    } catch (e) {
      if (e && e.code === "SQLITE_CONSTRAINT") {
        return res.status(409).json({ error: "اسم المستخدم موجود مسبقاً" });
      }
      throw e;
    }
  });

  router.patch("/users/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "المعرّف غير صالح" });
    const ex = await db.get("SELECT * FROM users WHERE id = ?", [id]);
    if (!ex) return res.status(404).json({ error: "المستخدم غير موجود" });
    const { role, password } = req.body || {};
    if (role === undefined && (password === undefined || String(password) === "")) {
      return res.status(400).json({ error: "مطلوب تعديل الدور و/أو كلمة مرور جديدة" });
    }
    if (role !== undefined) {
      if (!isValidRole(role)) {
        return res.status(400).json({ error: "دور غير صالح", allowed: USER_ROLES });
      }
      if (ex.role === "admin" && role !== "admin") {
        const n = await db.get("SELECT COUNT(*) as c FROM users WHERE role = 'admin'");
        if (n.c <= 1) {
          return res
            .status(400)
            .json({ error: "لا يمكن تغيير دور آخر مدير في النظام" });
        }
      }
    }
    if (role !== undefined) {
      await db.run("UPDATE users SET role = ? WHERE id = ?", [role, id]);
    }
    if (password !== undefined && String(password).length > 0) {
      const hash = await bcrypt.hash(String(password), 10);
      await db.run("UPDATE users SET password = ? WHERE id = ?", [hash, id]);
    }
    const row = await db.get("SELECT id, username, role, created_at FROM users WHERE id = ?", [
      id,
    ]);
    await logAudit(db, req, AUDIT_ACTIONS.USER_UPDATE, "users", id, { role: ex.role }, { role: row.role });
    res.json(row);
  });

  router.delete("/users/:id", async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "المعرّف غير صالح" });
    if (id === req.user.id) {
      return res.status(400).json({ error: "لا يمكنك حذف حسابك" });
    }
    const ex = await db.get("SELECT * FROM users WHERE id = ?", [id]);
    if (!ex) return res.status(404).json({ error: "المستخدم غير موجود" });
    if (ex.role === "admin") {
      const n = await db.get("SELECT COUNT(*) as c FROM users WHERE role = 'admin'");
      if (n.c <= 1) {
        return res.status(400).json({ error: "لا يمكن حذف آخر مدير في النظام" });
      }
    }
    const tx = await db.get("SELECT COUNT(*) as c FROM transactions WHERE cashier_id = ?", [id]);
    if (tx.c > 0) {
      return res
        .status(400)
        .json({ error: "لا يمكن حذف مستخدم له سجل مبيعات؛ غيّر الدور بدلاً من ذلك" });
    }
    await db.run("DELETE FROM users WHERE id = ?", [id]);
    await logAudit(db, req, AUDIT_ACTIONS.USER_DELETE, "users", id, { username: ex.username, role: ex.role }, null);
    res.status(204).send();
  });

  router.get("/audit-logs", async (req, res, next) => {
    try {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const { action, user_id, entity_type, date_from, date_to } = req.query;

      let sql = "SELECT * FROM audit_logs WHERE 1=1";
      const params = [];
      if (action) {
        sql += " AND action = ?";
        params.push(String(action));
      }
      if (user_id) {
        sql += " AND user_id = ?";
        params.push(Number(user_id));
      }
      if (entity_type) {
        sql += " AND entity_type = ?";
        params.push(String(entity_type));
      }
      if (date_from) {
        sql += " AND date(created_at) >= ?";
        params.push(String(date_from));
      }
      if (date_to) {
        sql += " AND date(created_at) <= ?";
        params.push(String(date_to));
      }
      sql += " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?";
      params.push(limit, offset);

      const rows = await db.all(sql, params);
      res.json({ rows, limit, offset });
    } catch (e) {
      next(e);
    }
  });

  router.post("/backup", async (req, res, next) => {
    try {
      const resolvedPath =
        dbPath ||
        path.resolve(__dirname, "..", "..", "data", "supermarket.db");
      const result = await createBackup(resolvedPath);
      await logAudit(db, req, AUDIT_ACTIONS.BACKUP_CREATE, "backup", null, null, result);
      res.status(201).json(result);
    } catch (e) {
      next(e);
    }
  });

  return router;
}
