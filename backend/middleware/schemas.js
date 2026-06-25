import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(50),
  password: z.string().min(1).max(100),
  app: z.enum(["office", "pos"]),
});

export const checkoutItemSchema = z.object({
  product_id: z.coerce.number().int().positive(),
  quantity: z.coerce.number().positive(),
  price: z.coerce.number().min(0),
  scanned_barcode: z.string().trim().min(1).max(50).optional().nullable(),
  product_barcode_id: z.coerce.number().int().positive().optional().nullable(),
});

export const checkoutSchema = z.object({
  items: z.array(checkoutItemSchema).min(1),
  payment_method: z.enum(["cash", "visa", "on_account"]),
  customer_id: z.number().int().positive().optional().nullable(),
  // Optional client-generated key to dedupe retries / double submissions.
  idempotency_key: z.string().trim().min(8).max(100).optional().nullable(),
});

export const refundItemSchema = z.object({
  product_id: z.number().int().positive(),
  quantity: z.number().positive(),
});

export const refundRequestCreateSchema = z.object({
  original_transaction_id: z.coerce.number().int().positive(),
  lines: z
    .array(
      z.object({
        product_id: z.coerce.number().int().positive(),
        quantity: z.coerce.number().positive(),
      })
    )
    .min(1),
  reason: z.string().max(500).optional().nullable(),
  payment_method: z.enum(["cash", "visa"]),
});

export const refundRequestReviewSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  review_notes: z.string().max(500).optional().nullable(),
});

export const createUserSchema = z.object({
  username: z.string().trim().min(1).max(50),
  password: z.string().min(6).max(100),
  role: z.string().min(1),
});

export const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(100),
  new_password: z.string().min(6).max(100),
});

export const inventoryAdjustmentSchema = z.object({
  product_id: z.number().int().positive(),
  quantity: z.number(),
  adjustment_type: z.string().min(1).max(50),
  notes: z.string().max(500).optional().nullable(),
});

const SETTINGS_KEYS = new Set([
  "store_name",
  "store_name_ar",
  "store_address",
  "store_phone",
  "receipt_footer",
  "vat_enabled",
  "vat_rate",
  "currency",
  "shift_variance_threshold",
]);

export const settingsPatchSchema = z
  .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .refine(
    (obj) => Object.keys(obj).every((k) => SETTINGS_KEYS.has(k)),
    { message: "مفتاح إعداد غير مسموح" }
  );
