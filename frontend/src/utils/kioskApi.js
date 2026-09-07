import api from "../apiClient";
import { getAuthHeaders } from "./auth";

const KIOSK_TOKEN_KEY = "kioskToken";

export function getKioskToken() {
  try {
    return localStorage.getItem(KIOSK_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setKioskToken(token) {
  localStorage.setItem(KIOSK_TOKEN_KEY, token);
}

function kioskHeaders() {
  const token = getKioskToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchKioskDescriptors() {
  const { data } = await api.get("/api/attendance/kiosk/descriptors", {
    headers: kioskHeaders(),
  });
  return Array.isArray(data) ? data : [];
}

export async function postKioskPunch(userId) {
  const { data } = await api.post(
    "/api/attendance/kiosk/punch",
    { user_id: userId },
    { headers: { ...kioskHeaders(), "Content-Type": "application/json" } }
  );
  return data;
}

export function isKioskConfigured() {
  return Boolean(getKioskToken());
}

export async function enrollKioskDevice() {
  const { data } = await api.post(
    "/api/attendance/kiosk/session",
    {},
    { headers: getAuthHeaders() }
  );
  const payload = data?.data ?? data;
  const token = payload?.token;
  if (!token) throw new Error("لم يُرجع الخادم رمز الكشك");
  setKioskToken(token);
  return token;
}
