import crypto from "crypto";
import jwt from "jsonwebtoken";
import { JWT_SECRET, JWT_OPTIONS } from "../middleware/auth.js";

const KIOSK_AUDIENCE = "kiosk";

function kioskSecret() {
  return process.env.KIOSK_TOKEN_SECRET || `${JWT_SECRET}:kiosk`;
}

export function timingSafeStringEqual(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function signKioskToken({ enrolledBy } = {}) {
  return jwt.sign({ typ: "kiosk", enrolledBy: enrolledBy ?? null }, kioskSecret(), {
    expiresIn: process.env.KIOSK_TOKEN_EXPIRES_IN || "365d",
    issuer: JWT_OPTIONS.issuer,
    audience: KIOSK_AUDIENCE,
  });
}

export function verifyKioskToken(token) {
  return jwt.verify(token, kioskSecret(), {
    issuer: JWT_OPTIONS.issuer,
    audience: KIOSK_AUDIENCE,
  });
}
