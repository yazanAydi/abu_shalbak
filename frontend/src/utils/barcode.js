import api from "../apiClient";
import { getAuthHeaders } from "./auth";

/** Normalize scanner / manual input (trim, strip invisible chars, Arabic digits → Latin). */
export function normalizeBarcode(raw) {
  let t = String(raw ?? "")
    .trim()
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F]/g, "");
  t = t.replace(/[\u0660-\u0669]/g, (ch) =>
    String(ch.charCodeAt(0) - 0x0660)
  );
  t = t.replace(/[\u06F0-\u06F9]/g, (ch) =>
    String(ch.charCodeAt(0) - 0x06f0)
  );
  return t;
}

/** Whether the device can use the camera scanner (HTTPS + touch or narrow viewport). */
export function supportsCamera() {
  if (typeof window === "undefined") return false;
  if (!window.isSecureContext) return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  const isTouch =
    "ontouchstart" in window || (navigator.maxTouchPoints ?? 0) > 0;
  const isNarrow = window.matchMedia("(max-width: 768px)").matches;
  return isTouch || isNarrow;
}

/**
 * Always-200 barcode probe. Free / empty code → `{ found: false }`.
 * Chrome does not log console errors for 200 responses.
 * @param {unknown} raw
 * @returns {Promise<{ found: boolean, inactive?: boolean } & Record<string, unknown>>}
 */
export async function fetchBarcodeLookup(raw) {
  const code = normalizeBarcode(raw);
  if (!code) return { found: false };
  const { data } = await api.get("/api/products/lookup", {
    params: { barcode: code },
    headers: getAuthHeaders(),
  });
  return data ?? { found: false };
}

/**
 * Look up an active product by barcode. Throws when missing or inactive.
 * @param {unknown} raw
 * @returns {Promise<object>}
 */
export async function lookupProductByBarcode(raw) {
  const code = normalizeBarcode(raw);
  if (!code) throw new Error("باركود فارغ");
  let data;
  try {
    data = await fetchBarcodeLookup(code);
  } catch (e) {
    if (e.response?.status === 404) {
      throw new Error(
        `لم يُعثر على المنتج (${code}) — أضفه من «إدارة المنتجات» أو جرّب 1234567890`
      );
    }
    throw new Error(
      e.response?.data?.error || e.message || "تعذّر البحث"
    );
  }
  if (!data?.found || data.inactive) {
    throw new Error(
      `لم يُعثر على المنتج (${code}) — أضفه من «إدارة المنتجات» أو جرّب 1234567890`
    );
  }
  return data;
}
