import api from "../apiClient";

function getKioskKey() {
  return process.env.REACT_APP_KIOSK_API_KEY && String(process.env.REACT_APP_KIOSK_API_KEY).trim();
}

function kioskHeaders() {
  const key = getKioskKey();
  return key ? { "X-Kiosk-Key": key } : {};
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
  return Boolean(getKioskKey());
}
