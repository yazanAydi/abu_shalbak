import multer from "multer";

export const ALLOWED_STATEMENT_MIMES = new Set([
  "application/pdf",
  "application/x-pdf",
  "application/octet-stream",
  "",
]);

export const statementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || "").toLowerCase();
    if (!name.endsWith(".pdf")) {
      return cb(new Error("صيغة الملف غير مدعومة. استخدم PDF فقط."));
    }
    const mime = String(file.mimetype || "");
    if (mime && !ALLOWED_STATEMENT_MIMES.has(mime) && !mime.includes("pdf")) {
      return cb(new Error("صيغة الملف غير مدعومة. استخدم PDF فقط."));
    }
    cb(null, true);
  },
});

/**
 * Express middleware for supplier statement PDF upload (field name: file).
 */
export function statementUploadMiddleware() {
  return (req, res, next) => {
    statementUpload.single("file")(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          error: err.message || "فشل الرفع",
          code: err.code,
        });
      }
      next();
    });
  };
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function requireStatementFile(req, res) {
  if (!req.file || !req.file.buffer) {
    res.status(400).json({ error: "الملف مطلوب (اسم الحقل: file)" });
    return null;
  }
  return req.file;
}
