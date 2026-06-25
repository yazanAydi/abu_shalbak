import api from "../apiClient";
import { getAuthHeaders } from "./auth";

export function normalizeBarcode(raw) {
  let t = String(raw ?? "")
    .trim()
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F]/g, "");
  t = t.replace(/[\u0660-\u0669]/g, (ch) => String(ch.charCodeAt(0) - 0x0660));
  t = t.replace(/[\u06F0-\u06F9]/g, (ch) => String(ch.charCodeAt(0) - 0x06f0));
  return t;
}

export async function lookupProductByBarcode(raw) {
  const code = normalizeBarcode(raw);
  if (!code) throw new Error("باركود فارغ");
  try {
    const { data } = await api.get(`/api/products/${encodeURIComponent(code)}`, {
      headers: getAuthHeaders(),
    });
    return data;
  } catch (e) {
    if (e.response?.status === 404) {
      throw new Error(`لم يُعثر على المنتج (${code})`);
    }
    throw new Error(e.response?.data?.error || e.message || "تعذّر البحث");
  }
}
