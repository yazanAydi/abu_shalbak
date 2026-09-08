import api from "../apiClient";
import { getAuthHeaders } from "./auth";
import { printDocumentWhenReady } from "./printDocument";

const inFlight = new Set();

export const STORE_PRINT_UNAVAILABLE_AR =
  "تعذر الاتصال بطابعة الإيصالات. تأكد من تشغيل خدمة الطباعة ثم حاول مرة أخرى.";

let testEnv = null;

/** Test-only: override process.env so production vs development print can be asserted. */
export function setPrintEnvForTests(env) {
  testEnv = env;
}

function printEnv() {
  return testEnv || process.env;
}

/** Store POS is a production CRA build. Dev `npm start` is NODE_ENV=development. */
export function isDevelopmentPrintMode(env = printEnv()) {
  return env.NODE_ENV === "development";
}

function normalizeReceiptInput(receiptOrPayload, options = {}) {
  if (typeof receiptOrPayload === "string") {
    return { transactionId: null };
  }
  if (receiptOrPayload && typeof receiptOrPayload === "object") {
    const transactionId = Number(
      receiptOrPayload.transaction_id || receiptOrPayload.transactionId || receiptOrPayload.id
    );
    return {
      transactionId: Number.isFinite(transactionId) && transactionId > 0 ? transactionId : null,
    };
  }
  const fromOptions = Number(options.transactionId);
  return {
    transactionId: Number.isFinite(fromOptions) && fromOptions > 0 ? fromOptions : null,
  };
}

export function shouldFallbackToBrowser(err, env = printEnv()) {
  if (!isDevelopmentPrintMode(env)) return false;
  const status = err?.response?.status;
  const code = err?.response?.data?.code;
  return (
    status === 501 ||
    status === 503 ||
    code === "SILENT_PRINT_UNSUPPORTED" ||
    code === "AGENT_UNAVAILABLE"
  );
}

function isAgentUnavailableError(err) {
  const status = err?.response?.status;
  const code = err?.response?.data?.code;
  return (
    status === 501 ||
    status === 503 ||
    code === "SILENT_PRINT_UNSUPPORTED" ||
    code === "AGENT_UNAVAILABLE"
  );
}

function authHeaders() {
  return { ...getAuthHeaders(), "Content-Type": "application/json" };
}

function receiptHtmlFromResponse(res) {
  const payload = res?.data?.data ?? res?.data;
  return payload?.receipt_html || null;
}

function cashierPrintError(err) {
  if (isAgentUnavailableError(err)) return STORE_PRINT_UNAVAILABLE_AR;
  return err?.response?.data?.error || err?.message || "فشلت طباعة الإيصال";
}

/** Development-only Edge preview. Never used in store/production builds. */
function browserPrint(html) {
  const w = window.open("", "_blank", "width=420,height=720");
  if (!w) {
    window.alert("اسمح بفتح النافذة المنبثقة لطباعة الإيصال.");
    return;
  }
  try {
    w.opener = null;
  } catch {
    /* ignore */
  }
  w.document.write(html);
  w.document.close();
  printDocumentWhenReady(w.document, {
    onAfterPrint: () => {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    },
  });
}

async function printViaBrowserFallback(transactionId) {
  const htmlRes = await api.post(
    "/api/print-receipt",
    { transaction_id: transactionId },
    { headers: authHeaders() }
  );
  const html = receiptHtmlFromResponse(htmlRes);
  if (!html) {
    window.alert("فشلت طباعة الإيصال");
    return;
  }
  browserPrint(html);
}

/**
 * Print a sale receipt via silent print.
 * Store/production: never window.print(). Development may fall back to Edge preview.
 */
export async function printReceipt(receiptOrPayload, options = {}) {
  const { transactionId } = normalizeReceiptInput(receiptOrPayload, options);
  if (!transactionId) {
    window.alert("لا يوجد رقم عملية للطباعة");
    return;
  }
  if (inFlight.has(transactionId)) return;
  inFlight.add(transactionId);

  try {
    await api.post(
      "/api/print-receipt/silent",
      { transaction_id: transactionId },
      { headers: authHeaders() }
    );
  } catch (e) {
    if (shouldFallbackToBrowser(e)) {
      try {
        await printViaBrowserFallback(transactionId);
      } catch (fallbackErr) {
        window.alert(cashierPrintError(fallbackErr));
      }
      return;
    }
    window.alert(cashierPrintError(e));
  } finally {
    inFlight.delete(transactionId);
  }
}
