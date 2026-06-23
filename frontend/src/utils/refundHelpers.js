/** @typedef {{ id: number, status?: string, total?: number, created_at?: string, approved_at?: string, rejected_at?: string, cashier_username?: string }} RefundRow */

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

const REASON_HINTS = {
  damaged: "تالف",
  wrong_item: "صنف خاطئ",
  customer_request: "طلب العميل",
  quality: "جودة",
  other: "أخرى",
};

/** Map free-text or code reason to Arabic label */
export function formatRefundReason(reason) {
  if (reason == null || String(reason).trim() === "") return "—";
  const k = String(reason).trim().toLowerCase().replace(/\s+/g, "_");
  if (REASON_HINTS[k]) return REASON_HINTS[k];
  return String(reason);
}

/** @param {RefundRow} r */
export function statusLabelAr(r) {
  const s = String(r?.status || "approved").toLowerCase();
  if (s === "pending") return { text: "قيد المراجعة", icon: "⏳", tone: "pending" };
  if (s === "rejected") return { text: "مرفوض", icon: "✗", tone: "rejected" };
  return { text: "موافَق عليه", icon: "✓", tone: "approved" };
}

/**
 * Client-side sort
 * @param {RefundRow[]} rows
 * @param {string} key
 * @param {'asc'|'desc'} dir
 */
export function sortRefunds(rows, key, dir) {
  const mult = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = a[key];
    const vb = b[key];
    if (["total", "id", "original_transaction_id"].includes(key)) {
      return (Number(va) - Number(vb)) * mult;
    }
    if (key === "created_at") {
      const ta = new Date(va).getTime() || 0;
      const tb = new Date(vb).getTime() || 0;
      return (ta - tb) * mult;
    }
    return String(va ?? "").localeCompare(String(vb ?? ""), "ar") * mult;
  });
}

/** Build CSV string (UTF-8 BOM) */
export function refundsToCsv(rows) {
  const headers = [
    "id",
    "original_transaction_id",
    "cashier_username",
    "reason",
    "total",
    "status",
    "payment_method",
    "created_at",
    "approved_at",
    "rejected_at",
  ];
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.original_transaction_id,
        r.cashier_username,
        r.reason,
        r.total,
        r.status,
        r.payment_method,
        r.created_at,
        r.approved_at ?? "",
        r.rejected_at ?? "",
      ]
        .map(esc)
        .join(",")
    );
  }
  return "\uFEFF" + lines.join("\r\n");
}

export function downloadCsv(filename, csvContent) {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export { ils };
