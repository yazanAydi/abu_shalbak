/**
 * Typed HTTP error for centralized error handling.
 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message User-facing message (Arabic)
   * @param {string} [code]
   * @param {object} [details]
   */
  constructor(status, message, code = "INTERNAL_ERROR", details = null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.statusCode = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message, code = "VALIDATION_ERROR", details = null) {
  return new HttpError(400, message, code, details);
}

export function unauthorized(message = "غير مصرّح", code = "UNAUTHORIZED") {
  return new HttpError(401, message, code);
}

export function forbidden(message = "صلاحيات غير كافية", code = "FORBIDDEN") {
  return new HttpError(403, message, code);
}

export function notFound(message = "غير موجود", code = "NOT_FOUND") {
  return new HttpError(404, message, code);
}

export function conflict(message, code = "CONFLICT") {
  return new HttpError(409, message, code);
}

export function dbError(message = "خطأ في قاعدة البيانات") {
  return new HttpError(500, message, "DB_ERROR");
}
