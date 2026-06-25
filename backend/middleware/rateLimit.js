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
  max: process.env.NODE_ENV === "development" ? 3000 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "طلبات كثيرة — حاول لاحقاً", code: "RATE_LIMIT" },
  skip: (req) =>
    process.env.NODE_ENV === "development" &&
    (req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1"),
});
