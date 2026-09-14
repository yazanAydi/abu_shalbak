export const RECEIPT_PRINT_HELPER_URL = "http://127.0.0.1:17892";

export const HELPER_UNAVAILABLE_AR =
  "تعذر الاتصال بمساعد طباعة ويندوز. تم حفظ البيع. استخدم إعادة الطباعة.";

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Send saved receipt HTML to the cashier-PC helper.
 * Does not change document.title, arm a window, or call /print-receipt/silent.
 * ok means the helper accepted the job, not that paper came out.
 */
export async function printHtmlViaWindowsHelper(html, { transactionId, fetchImpl } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== "function") {
    return { ok: false, error: HELPER_UNAVAILABLE_AR };
  }
  const helper = (path) => `${RECEIPT_PRINT_HELPER_URL}${path}`;

  let health;
  try {
    health = await fetchFn(helper("/health"));
  } catch {
    return { ok: false, error: HELPER_UNAVAILABLE_AR };
  }
  if (!health?.ok) return { ok: false, error: HELPER_UNAVAILABLE_AR };

  let printed;
  try {
    printed = await fetchFn(helper("/print"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html, transactionId }),
    });
  } catch {
    return { ok: false, error: HELPER_UNAVAILABLE_AR };
  }
  const printBody = (await readJson(printed)) || {};
  if (!printed.ok || !printBody.ok) {
    return { ok: false, error: printBody.error || HELPER_UNAVAILABLE_AR };
  }
  return {
    ok: true,
    printed: true,
    printTarget: "windows-helper",
    testMode: Boolean(printBody.testMode),
  };
}
