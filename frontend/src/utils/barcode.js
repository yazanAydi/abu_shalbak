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
 * Look up a product by barcode via the API.
 * @param {unknown} raw
 * @returns {Promise<object>}
 */
export async function lookupProductByBarcode(raw) {
  const code = normalizeBarcode(raw);
  if (!code) throw new Error("باركود فارغ");
  try {
    const { data } = await api.get(
      `/api/products/${encodeURIComponent(code)}`,
      { headers: { ...getAuthHeaders() } }
    );
    return data;
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
}
