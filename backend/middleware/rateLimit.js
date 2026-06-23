import rateLimit from "express-rate-limit";

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "محاولات دخول كثيرة — حاول لاحقاً", code: "RATE_LIMIT" },
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "طلبات كثيرة — حاول لاحقاً", code: "RATE_LIMIT" },
});
