import axios from "axios";
import { getToken, removeToken } from "./utils/auth";

/**
 * API base URL — server root; requests to /api/* are rewritten to /api/v1/*.
 */
function getBaseURL() {
  if (process.env.NODE_ENV === "development") {
    // Always same-origin in dev — setupProxy.js forwards /api → backend :5001.
    // Ignore REACT_APP_API_BASE here so a stale frontend/.env.development cannot bypass the proxy.
    return "";
  }
  const env = process.env.REACT_APP_API_BASE;
  if (env != null && String(env).trim() !== "") {
    return String(env).trim().replace(/\/$/, "");
  }
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
  if (data instanceof Blob || typeof data === "string") {
    return data;
  }
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
      const onKiosk =
        window.location.pathname.endsWith("/kiosk") ||
        window.location.pathname.includes("/kiosk");
      if (!url.includes("/auth/login") && !onKiosk) {
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
        process.env.NODE_ENV === "development"
          ? "تعذّر الاتصال بالخادم. شغّل npm start من جذر المشروع وتأكد من ظهور [api] Server running على المنفذ 5001. ثم نفّذ: npm run verify:dev"
          : "تعذّر الاتصال بالخادم. للمتجر: افتح http://IP:3000/admin";
    }
    return Promise.reject(e);
  }
);

export default api;
