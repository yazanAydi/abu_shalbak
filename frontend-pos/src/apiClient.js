import axios from "axios";
import { getToken, removeToken } from "./utils/auth";

function getBaseURL() {
  const env = process.env.REACT_APP_API_BASE;
  if (env != null && String(env).trim() !== "") {
    return String(env).trim().replace(/\/$/, "");
  }
  if (process.env.NODE_ENV === "development") {
    return "http://127.0.0.1:5000";
  }
  return "";
}

export const api = axios.create({
  baseURL: getBaseURL(),
});

api.interceptors.request.use((config) => {
  if (config.url && config.url.startsWith("/api/") && !config.url.startsWith("/api/v1/")) {
    config.url = config.url.replace(/^\/api\//, "/api/v1/");
  }
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

function unwrapResponse(data) {
  if (data && typeof data === "object" && data.success === true && "data" in data) {
    return data.data;
  }
  return data;
}

api.interceptors.response.use(
  (r) => {
    r.data = unwrapResponse(r.data);
    return r;
  },
  (e) => {
    if (e?.response?.status === 401) {
      const url = String(e.config?.url || "");
      if (!url.includes("/auth/login")) {
        removeToken();
        const loginPath = `${process.env.PUBLIC_URL || ""}/login`;
        const onLogin = window.location.pathname === loginPath || window.location.pathname.endsWith("/login");
        if (!onLogin) {
          window.location.replace(`${loginPath}?session=expired`);
        }
      }
    }
    if (e?.response?.data && typeof e.response.data === "object") {
      const body = e.response.data;
      const msg = body.error || body.data?.error;
      if (msg) e.message = msg;
    }
    if (e && e.message === "Network Error") {
      e.message =
        "تعذّر الاتصال بالخادم. للتطوير: شغّل npm start من جذر المشروع (المنفذ 5000). للمتجر: افتح http://IP:3000/pos";
    }
    return Promise.reject(e);
  }
);

export default api;
