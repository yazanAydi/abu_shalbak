import { round2 } from "./format";

function remainingOf(row) {
  const n = Number(row?.remaining);
  return Number.isFinite(n) && n > 0 ? round2(n) : 0;
}

/**
 * Apply outstanding سلف then ذمم (oldest first) to a typed payment.
 * cashPaid = payment − applied deductions, never below 0.
 */
export function allocatePayrollDeductions(payment, advances = [], debts = []) {
  const typed = round2(Number(payment) || 0);
  if (!Number.isFinite(typed) || typed <= 0) {
    return {
      payment: 0,
      advanceDeducted: 0,
      debtDeducted: 0,
      cashPaid: 0,
      deductions: [],
    };
  }

  const lines = [];
  for (const row of advances) {
    const remaining = remainingOf(row);
    if (remaining <= 0 || !row?.id) continue;
    lines.push({
      kind: "advance",
      source_type: "ledger_entry",
      source_id: Number(row.id),
      remaining,
      date: String(row.date || ""),
      order: 0,
      label: row.reason ? `سلفة ${row.date} — ${row.reason}` : `سلفة ${row.date}`,
    });
  }
  for (const row of debts) {
    const remaining = remainingOf(row);
    if (remaining <= 0 || !row?.source_type || !row?.source_id) continue;
    lines.push({
      kind: "debt",
      source_type: row.source_type,
      source_id: Number(row.source_id),
      remaining,
      date: String(row.date || ""),
      order: 1,
      label: row.description || row.invoice_no || `ذمة ${row.date}`,
    });
  }
  lines.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    return a.source_id - b.source_id;
  });

  let room = typed;
  const deductions = [];
  let advanceDeducted = 0;
  let debtDeducted = 0;
  for (const line of lines) {
    if (room <= 0.009) break;
    const take = round2(Math.min(line.remaining, room));
    if (take <= 0.009) continue;
    deductions.push({
      kind: line.kind,
      source_type: line.source_type,
      source_id: line.source_id,
      amount: take,
      label: line.label,
    });
    if (line.kind === "advance") advanceDeducted = round2(advanceDeducted + take);
    else debtDeducted = round2(debtDeducted + take);
    room = round2(room - take);
  }

  return {
    payment: typed,
    advanceDeducted,
    debtDeducted,
    cashPaid: room,
    deductions,
  };
}
