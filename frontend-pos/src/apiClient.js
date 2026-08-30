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
    // A write may have changed settings, currencies, categories or unit names,
    // so drop the GET cache rather than try to guess which entry is affected.
    if (r.config?.method && r.config.method.toLowerCase() !== "get") {
      invalidateCacheForWrite(r.config.url || "");
    }
    return r;
  },
  (e) => {
    if (e?.response?.status === 401) {
      clearApiCache();
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

/**
 * Small in-memory GET cache for the handful of endpoints that are re-fetched on
 * almost every page mount but effectively never change mid-session.
 *
 * Any successful write clears the cache, so an edit made in this tab is visible
 * immediately; the TTL only bounds staleness from edits made elsewhere.
 */
const CACHEABLE_PATHS = new Set([
  "/api/settings",
  "/api/currencies",
  "/api/products/categories",
  "/api/products/unit-names",
]);

const CACHE_TTL_MS = 60_000;

const cachedResponses = new Map();
const inFlightRequests = new Map();

export function clearApiCache() {
  cachedResponses.clear();
  inFlightRequests.clear();
}

function invalidateCacheForWrite(url) {
  const path = String(url || "");
  const keys = [];
  if (path.includes("/settings")) keys.push("/api/settings");
  if (path.includes("/currencies")) keys.push("/api/currencies");
  if (path.includes("/categories")) keys.push("/api/products/categories");
  if (path.includes("/unit-names")) keys.push("/api/products/unit-names");
  if (!keys.length) return;
  for (const cacheKey of [...cachedResponses.keys()]) {
    if (keys.some((prefix) => cacheKey.startsWith(prefix))) cachedResponses.delete(cacheKey);
  }
}

export function createAbortController() {
  return new AbortController();
}

function serializeParams(params) {
  if (!params || typeof params !== "object") return "";
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([key, value]) => `${key}=${String(value)}`).join("&");
}

// Callers routinely pass the response body straight into state and components may
// mutate it, so hand out a copy rather than letting one screen corrupt another's.
function copyResponse(response) {
  let data = response.data;
  try {
    data = typeof structuredClone === "function"
      ? structuredClone(data)
      : JSON.parse(JSON.stringify(data));
  } catch {
    /* non-cloneable payload: fall through and share the reference */
  }
  return { ...response, data };
}

const passthroughGet = api.get.bind(api);

api.get = function cachingGet(url, config) {
  const path = String(url ?? "").split("?")[0];
  if (!CACHEABLE_PATHS.has(path)) return passthroughGet(url, config);

  const key = `${url}|${serializeParams(config?.params)}`;

  const cached = cachedResponses.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(copyResponse(cached.response));
  }

  // Several components mounting at once should share one request, not race.
  const pending = inFlightRequests.get(key);
  if (pending) return pending.then(copyResponse);

  const request = passthroughGet(url, config)
    .then((response) => {
      cachedResponses.set(key, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        response,
      });
      return response;
    })
    .finally(() => {
      inFlightRequests.delete(key);
    });

  inFlightRequests.set(key, request);
  return request.then(copyResponse);
};

export default api;
