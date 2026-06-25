import multer from "multer";

export const ALLOWED_IMPORT_MIMES = new Set([
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/pdf",
  "application/x-pdf",
  "application/octet-stream",
  "",
]);

export const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || "").toLowerCase();
    const okExt = name.endsWith(".csv") || name.endsWith(".xlsx") || name.endsWith(".pdf");
    const mime = String(file.mimetype || "");
    const okMime =
      ALLOWED_IMPORT_MIMES.has(mime) || mime.includes("pdf");
    if (okExt && okMime) return cb(null, true);
    cb(new Error("صيغة الملف غير مدعومة. استخدم CSV أو XLSX أو PDF."));
  },
});

/**
 * Express middleware for single-file import upload (field name: file).
 */
export function importUploadMiddleware() {
  return (req, res, next) => {
    importUpload.single("file")(req, res, (err) => {
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
 */
export function requireImportFile(req, res) {
  if (!req.file || !req.file.buffer) {
    res.status(400).json({ error: "الملف مطلوب (اسم الحقل: file)" });
    return null;
  }
  return req.file;
}
