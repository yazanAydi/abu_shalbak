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
    employee_id: z.number().int().positive().optional().nullable(),
    cash_tendered: z.coerce.number().nonnegative().optional().nullable(),
    currency_id: z.coerce.number().int().positive().optional().nullable(),
    currency_code: z.string().trim().min(1).max(10).optional().nullable(),
    original_amount: z.coerce.number().nonnegative().optional().nullable(),
    change_currency_id: z.coerce.number().int().positive().optional().nullable(),
    change_currency_code: z.string().trim().min(1).max(10).optional().nullable(),
    idempotency_key: z
      .string({ required_error: "مفتاح التكرار مطلوب" })
      .trim()
      .min(8, "مفتاح التكرار مطلوب (8–100 حرفاً)")
      .max(100),
    suspended_sale_id: z.coerce.number().int().positive().optional().nullable(),
    notes: z.string().max(500, "الملاحظات يجب ألا تتجاوز 500 حرف").optional().nullable(),
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
  payment_method: z.enum(["cash", "visa", "on_account"]),
});

export const refundRequestReviewSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  review_notes: z.string().max(500).optional().nullable(),
});

export const advanceRequestCreateSchema = z.object({
  employee_id: z
    .any()
    .transform((v) => (v == null || v === "" ? NaN : Number(v)))
    .refine((n) => Number.isInteger(n) && n > 0, { message: "اختر الموظف" }),
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
    employee_id: z.preprocess(
      (v) => (v == null || v === "" ? undefined : v),
      z.coerce.number().int().positive().optional()
    ),
    employee_name: z.string().trim().min(1).max(120).optional(),
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

export const userPermissionsSchema = z.object({
  permissions: z.record(z.any()).nullable(),
});

export const productDeletePasswordSchema = z.object({
  password: z.string().min(6, "كلمة المرور يجب أن تكون 6 أحرف على الأقل").max(100),
});

export const inventoryAdjustmentSchema = z.object({
  product_id: z.number().int().positive(),
  quantity: z.number(),
  adjustment_type: z.string().min(1).max(50),
  notes: z.string().max(500).optional().nullable(),
});

const optionalPositiveInt = z.preprocess(
  (v) => (v == null || v === "" ? undefined : v),
  z.coerce.number().int().positive().optional()
);

const inventoryDocumentItemSchema = z
  .object({
    product_id: z.coerce.number({ invalid_type_error: "المنتج غير موجود" }).int().positive({
      message: "المنتج غير موجود",
    }),
    product_unit_id: optionalPositiveInt,
    unit_id: optionalPositiveInt,
    quantity: z.coerce.number({ invalid_type_error: "الكمية يجب أن تكون أكبر من صفر" }).positive({
      message: "الكمية يجب أن تكون أكبر من صفر",
    }),
  })
  .superRefine((data, ctx) => {
    if (!data.product_unit_id && !data.unit_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "الوحدة مطلوبة",
        path: ["product_unit_id"],
      });
    }
  });

function inventoryDocumentCreateSchema(reasonCodes) {
  return z.object({
    document_date: z.preprocess(
      (v) => (v == null || String(v).trim() === "" ? undefined : String(v).trim()),
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ غير صالح").optional()
    ),
    reason: z.enum(reasonCodes, {
      errorMap: () => ({ message: "سبب غير صالح" }),
    }),
    notes: z.preprocess(
      (v) => (v == null || String(v).trim() === "" ? null : String(v).trim()),
      z.string().max(2000).nullable().optional()
    ),
    store_id: z.coerce.number().int().positive().optional(),
    items: z.array(inventoryDocumentItemSchema).min(1, "يجب إضافة صنف واحد على الأقل"),
  });
}

export const inventoryReceiptCreateSchema = inventoryDocumentCreateSchema([
  "opening",
  "correction",
  "free",
  "branch_return",
  "other",
]);

export const inventoryIssueCreateSchema = inventoryDocumentCreateSchema([
  "damaged",
  "internal",
  "samples",
  "giveaway",
  "transfer",
  "correction",
  "other",
]);

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

const ymd = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "التاريخ يجب أن يكون بصيغة YYYY-MM-DD");

const optionalYmd = z.union([ymd, z.literal(""), z.null()]).optional();

export const employeeCreateSchema = z.object({
  name: z.string().trim().min(1, "اسم الموظف مطلوب").max(120),
  phone: z.string().trim().max(40).optional().nullable(),
  start_on: optionalYmd,
  end_on: optionalYmd,
  active: z.union([z.boolean(), z.number(), z.string()]).optional(),
  user_id: z.coerce.number().int().positive().optional().nullable(),
});

export const employeePatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(40).optional().nullable(),
  start_on: optionalYmd,
  end_on: optionalYmd,
  active: z.union([z.boolean(), z.number(), z.string()]).optional(),
  user_id: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
  customer_id: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
});

export const employeeCompensationSchema = z.object({
  effective_from: ymd,
  compensation_type: z.enum(["monthly", "daily", "hourly"], {
    errorMap: () => ({ message: "نوع التعويض غير صالح" }),
  }),
  amount: z.coerce.number().positive("المبلغ يجب أن يكون أكبر من صفر"),
  expected_days: z.coerce.number().min(0).optional().nullable(),
  expected_hours: z.coerce.number().min(0).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
});

export const employeeOpeningBalanceSchema = z.object({
  kind: z.enum(["unpaid_salary", "prepaid_salary"], {
    errorMap: () => ({ message: "نوع الرصيد غير صالح" }),
  }),
  amount: z.coerce.number().positive("المبلغ يجب أن يكون أكبر من صفر"),
  as_of: ymd,
  reason: z.string().trim().min(1, "سبب الرصيد الافتتاحي مطلوب").max(500),
  operating_expense_id: z.coerce.number().int().positive().optional().nullable(),
});

export const employeeStatementQuerySchema = z
  .object({
    from: ymd.optional(),
    to: ymd.optional(),
  })
  .refine((d) => !d.from || !d.to || d.from <= d.to, {
    message: "تاريخ البداية يجب أن يكون قبل تاريخ النهاية أو مساوياً له",
  });

export const employeeHoursPreviewQuerySchema = z
  .object({
    from: ymd,
    to: ymd,
  })
  .refine((d) => d.from <= d.to, {
    message: "تاريخ البداية يجب أن يكون قبل تاريخ النهاية أو مساوياً له",
  });

export const employeeEntitlementCreateSchema = z
  .object({
    period_from: ymd,
    period_to: ymd,
    amount: z.coerce.number().positive("المبلغ يجب أن يكون أكبر من صفر").optional().nullable(),
    reason: z.string().trim().max(500).optional().nullable(),
    confirm_manual: z.boolean().optional(),
    confirm_incomplete: z.boolean().optional(),
  })
  .refine((d) => d.period_from <= d.period_to, {
    message: "بداية الفترة يجب أن تكون قبل نهايتها أو مساوية لها",
  });

export const employeeEntitlementReverseSchema = z.object({
  reason: z.string().trim().min(1, "سبب التصحيح مطلوب").max(500),
  correction_date: ymd.optional(),
});

export const employeeEntitlementReplaceSchema = z.object({
  amount: z.coerce.number().positive("المبلغ يجب أن يكون أكبر من صفر").optional().nullable(),
  reason: z.string().trim().min(1, "سبب التصحيح مطلوب").max(500),
  correction_date: ymd.optional(),
  confirm_manual: z.boolean().optional(),
  confirm_incomplete: z.boolean().optional(),
});

export const employeePaymentCreateSchema = z.object({
  purpose: z.enum(["salary_payment", "salary_advance"], {
    errorMap: () => ({ message: "نوع الدفعة غير صالح" }),
  }),
  amount: z.coerce.number().positive("المبلغ يجب أن يكون أكبر من صفر"),
  occurred_on: ymd,
  payment_method: z.enum(["cash", "transfer", "check", "other"], {
    errorMap: () => ({ message: "طريقة الدفع غير صالحة" }),
  }),
  reference_note: z.string().trim().max(500).optional().nullable(),
  category_id: z.coerce.number().int().positive().optional().nullable(),
});

export const employeePaymentCorrectSchema = z
  .object({
    mode: z.enum(["reverse", "replace", "annotate_recipient"], {
      errorMap: () => ({ message: "نوع التصحيح غير صالح" }),
    }),
    reason: z.string().trim().min(1, "سبب التصحيح مطلوب").max(500),
    correction_date: ymd.optional(),
    amount: z.coerce.number().positive("المبلغ يجب أن يكون أكبر من صفر").optional(),
    intended_employee_id: z.coerce.number().int().positive().optional(),
    employee_id: z.coerce.number().int().positive().optional(),
  })
  .superRefine((d, ctx) => {
    if (d.mode === "replace" && d.amount == null) {
      ctx.addIssue({ code: "custom", message: "المبلغ الجديد مطلوب", path: ["amount"] });
    }
    if (d.mode === "annotate_recipient" && d.intended_employee_id == null) {
      ctx.addIssue({
        code: "custom",
        message: "الموظف المقصود مطلوب",
        path: ["intended_employee_id"],
      });
    }
  });

export const employeeFromCashierUserSchema = z.object({
  user_id: z.coerce.number().int().positive(),
  name: z.string().trim().min(1).max(120).optional(),
  employee_id: optionalPositiveInt,
  phone: z.string().trim().max(40).optional().nullable(),
  start_on: optionalYmd,
  end_on: optionalYmd,
});

export const userEmployeeSetupSchema = z.object({
  employee_id: optionalPositiveInt,
  employee_name: z.string().trim().min(1).max(120).optional(),
  name: z.string().trim().min(1).max(120).optional(),
});

export const employeeLinkCashierUserSchema = z.object({
  user_id: z.coerce.number().int().positive(),
});

export const employeeLinkCustomerSchema = z.object({
  customer_id: z.union([z.coerce.number().int().positive(), z.null()]),
});

export const employeePayrollPreviewQuerySchema = z
  .object({
    period_from: ymd,
    period_to: ymd,
    as_of: ymd.optional(),
  })
  .refine((d) => d.period_from <= d.period_to, {
    message: "بداية الفترة يجب أن تكون قبل نهايتها أو مساوية لها",
  });

export const employeePayrollPayoutSchema = z
  .object({
    period_from: ymd,
    period_to: ymd,
    occurred_on: ymd.optional(),
    cash_paid: z.coerce.number().min(0, "المبلغ لا يمكن أن يكون سالباً").optional().default(0),
    payment_method: z.enum(["cash", "transfer", "check", "other"]).optional().nullable(),
    reference_note: z.string().trim().max(500).optional().nullable(),
    salary_before_deductions: z.coerce.number().min(0).optional().nullable(),
    confirm_manual: z.boolean().optional(),
    confirm_incomplete: z.boolean().optional(),
    reason: z.string().trim().max(500).optional().nullable(),
    idempotency_key: z.string().trim().min(1).max(80).optional(),
    deductions: z
      .array(
        z.object({
          kind: z.enum(["advance", "debt"]),
          source_type: z.enum(["ledger_entry", "pos_sale", "sales_invoice"]),
          source_id: z.coerce.number().int().positive(),
          amount: z.coerce.number().positive(),
        })
      )
      .optional()
      .default([]),
  })
  .refine((d) => d.period_from <= d.period_to, {
    message: "بداية الفترة يجب أن تكون قبل نهايتها أو مساوية لها",
  });

export const employeeDebtPaymentSchema = z.object({
  amount: z.coerce.number().positive("المبلغ يجب أن يكون أكبر من صفر"),
  occurred_on: ymd.optional(),
  payment_method: z.enum(["cash", "transfer", "check", "other"], {
    errorMap: () => ({ message: "طريقة الدفع غير صالحة" }),
  }),
  reference_note: z.string().trim().max(500).optional().nullable(),
  idempotency_key: z.string().trim().min(1).max(80).optional(),
});
