import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(50),
  password: z.string().min(1).max(100),
  app: z.enum(["office", "pos"]),
});

export const checkoutItemSchema = z.object({
  product_id: z.coerce.number().int().positive(),
  unit_id: z.coerce.number().int().positive().optional().nullable(),
  quantity: z.coerce.number().positive(),
  price: z.coerce.number().min(0),
  scanned_barcode: z.string().trim().min(1).max(50).optional().nullable(),
  product_barcode_id: z.coerce.number().int().positive().optional().nullable(),
  product_unit_id: z.coerce.number().int().positive().optional().nullable(),
});

export const checkoutPaymentLineSchema = z
  .object({
    method: z.enum(["cash", "visa", "on_account"]),
    amount: z.coerce.number().nonnegative().optional(),
    original_amount: z.coerce.number().nonnegative().optional(),
    currency_id: z.coerce.number().int().positive().optional().nullable(),
    currency_code: z.string().trim().min(1).max(10).optional().nullable(),
  })
  .refine((d) => d.amount != null || d.original_amount != null, {
    message: "amount أو original_amount مطلوب",
  });

export const checkoutSchema = z
  .object({
    items: z.array(checkoutItemSchema).min(1),
    payment_method: z.enum(["cash", "visa", "on_account", "mixed"]).optional(),
    payments: z.array(checkoutPaymentLineSchema).min(1).optional(),
    customer_id: z.number().int().positive().optional().nullable(),
    cash_tendered: z.coerce.number().nonnegative().optional().nullable(),
    currency_id: z.coerce.number().int().positive().optional().nullable(),
    currency_code: z.string().trim().min(1).max(10).optional().nullable(),
    original_amount: z.coerce.number().nonnegative().optional().nullable(),
    idempotency_key: z.string().trim().min(8).max(100).optional().nullable(),
    suspended_sale_id: z.coerce.number().int().positive().optional().nullable(),
  })
  .refine((data) => data.payment_method || (data.payments && data.payments.length > 0), {
    message: "payment_method أو payments مطلوب",
  });

export const suspendedSaleCreateSchema = z.object({
  note: z.string().trim().max(500).optional().nullable(),
  items: z.array(checkoutItemSchema).min(1),
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

export const advanceRequestCreateSchema = z.object({
  employee_name: z.string().trim().min(1).max(100),
  amount: z.coerce.number().positive(),
  notes: z.string().max(500).optional().nullable(),
});

export const advanceRequestReviewSchema = refundRequestReviewSchema;
export const onAccountRequestReviewSchema = refundRequestReviewSchema;

export const createUserSchema = z
  .object({
    username: z.string().trim().min(1).max(50),
    password: z.string().min(6).max(100).optional(),
    role: z.string().min(1),
  })
  .superRefine((data, ctx) => {
    const kioskOnly =
      data.role === "bakery_employee" || data.role === "shelves_employee";
    if (!kioskOnly && (!data.password || data.password.length < 6)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "كلمة المرور مطلوبة لهذا الدور",
        path: ["password"],
      });
    }
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
