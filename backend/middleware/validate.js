import { ZodError } from "zod";

/**
 * Express middleware factory for Zod schema validation.
 * @param {import('zod').ZodSchema} schema
 * @param {'body'|'query'|'params'} source
 */
export function validate(schema, source = "body") {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req[source]);
      req[source] = parsed;
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const first = err.errors[0];
        const msg = first?.message || "بيانات غير صالحة";
        return res.status(400).json({
          success: false,
          error: msg,
          code: "VALIDATION_ERROR",
          details: err.errors,
        });
      }
      next(err);
    }
  };
}
