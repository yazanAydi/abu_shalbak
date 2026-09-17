const NETWORK_AR =
  process.env.NODE_ENV === "development"
    ? "تعذّر الاتصال بالخادم. شغّل npm start من جذر المشروع."
    : "تعذّر الاتصال بالخادم. للمتجر: افتح http://IP:3000/admin";

function envelopeError(e) {
  const body = e?.response?.data;
  if (!body || typeof body !== "object") return "";
  return body.error || body.data?.error || "";
}

export function apiErrorMessage(e, fallbackAr = "تعذّر إتمام العملية") {
  if (!e) return fallbackAr;
  const fromBody = envelopeError(e);
  if (fromBody) return fromBody;

  const status = e?.response?.status;
  if (status === 401 || status === 403) return "لا تملك صلاحية";
  if (status === 404) return "غير موجود";
  if (status === 409) return "تعارض في البيانات";
  if (status === 400 || status === 422) return "بيانات غير صالحة";
  if (status >= 500) return "خطأ في الخادم، حاول لاحقاً";

  if (e.message === "Network Error") return NETWORK_AR;
  if (typeof e.message === "string" && e.message && !/^\d+$/.test(e.message)) {
    if (/request failed|status code|axios/i.test(e.message)) {
      return fallbackAr;
    }
    return e.message;
  }
  return fallbackAr;
}

export function apiErrorDetails(e) {
  if (!e) return "";
  const status = e?.response?.status;
  const requestId = e?.response?.data?.meta?.requestId || e?.response?.headers?.["x-request-id"] || "";
  const raw = envelopeError(e) || e.message || "";
  const parts = [];
  if (status) parts.push(`status: ${status}`);
  if (requestId) parts.push(`requestId: ${requestId}`);
  if (raw) parts.push(String(raw));
  return parts.join("\n");
}
