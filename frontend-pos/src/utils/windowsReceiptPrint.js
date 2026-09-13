export const RECEIPT_PRINT_HELPER_URL = "http://127.0.0.1:17892";
export const POS_PRINT_OWNER_PREFIX = "أبو شلبك — نقطة البيع";

export const HELPER_UNAVAILABLE_AR =
  "تعذر الاتصال بمساعد طباعة ويندوز. تم حفظ البيع. استخدم إعادة الطباعة.";

function newRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `print-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Arm the local Windows helper, print this receipt HTML, then disarm.
 * Does not use Edge preview or /print-receipt/silent.
 */
export async function printHtmlViaWindowsHelper(html, { transactionId, fetchImpl } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== "function") {
    return { ok: false, error: HELPER_UNAVAILABLE_AR };
  }
  const requestId = newRequestId();
  const ownerTitle = `${POS_PRINT_OWNER_PREFIX} · ${requestId}`;
  const prevTitle = typeof document !== "undefined" ? document.title : "";
  if (typeof document !== "undefined") document.title = ownerTitle;
  const helper = (path) => `${RECEIPT_PRINT_HELPER_URL}${path}`;

  try {
    let health;
    try {
      health = await fetchFn(helper("/health"));
    } catch {
      return { ok: false, error: HELPER_UNAVAILABLE_AR };
    }
    if (!health?.ok) return { ok: false, error: HELPER_UNAVAILABLE_AR };
    const info = (await readJson(health)) || {};
    const printerName = info.printer || "";

    let armed;
    try {
      armed = await fetchFn(helper("/arm"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId,
          transactionId,
          ownerTitle,
          printerName,
        }),
      });
    } catch {
      return { ok: false, error: HELPER_UNAVAILABLE_AR };
    }
    const armBody = (await readJson(armed)) || {};
    if (!armed.ok || !armBody.ok) {
      return { ok: false, error: armBody.error || HELPER_UNAVAILABLE_AR };
    }

    let printed;
    try {
      printed = await fetchFn(helper("/print"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, html, transactionId }),
      });
    } catch {
      return { ok: false, error: HELPER_UNAVAILABLE_AR };
    }
    const printBody = (await readJson(printed)) || {};
    if (!printed.ok || !printBody.ok) {
      return { ok: false, error: printBody.error || HELPER_UNAVAILABLE_AR };
    }
    return { ok: true, printed: true, printTarget: "windows-helper", requestId };
  } finally {
    if (typeof document !== "undefined") document.title = prevTitle;
    try {
      await fetchFn(helper("/disarm"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
    } catch {
      /* ignore */
    }
  }
}
