import { round2 } from "../utils/money.js";
import { computeShiftVisa, computeShiftVisaMap } from "../utils/salePayments.js";
import { shopBusinessDayYmd, toSqlUtc } from "../utils/businessDay.js";
import { shopYmdRangeToUtcBounds } from "../utils/shopTime.js";
import { badRequest, conflict, notFound } from "../utils/httpError.js";

export const VISA_MACHINE_HINT =
  "أدخل صافي إجمالي جهاز الفيزا بعد خصم مرتجعات الفيزا، لنفس هذه الوردية.";

export const VISA_RECONCILE_LABELS = Object.freeze({
  receiptCount: "عدد عمليات الفيزا",
  sales: "مبيعات الفيزا",
  other: "تحصيلات فيزا أخرى",
  refunds: "مرتجعات الفيزا",
  expected: "صافي الفيزا المتوقع",
  known: "صافي معروف",
  machine: "صافي إجمالي جهاز الفيزا",
  difference: "فرق الفيزا",
  waiting: "بانتظار المطابقة",
  matched: "مطابق",
  incomplete: "غير مكتمل",
  basisChanged: "تغيّر أساس المطابقة بعد الحفظ",
});

function money(value) {
  return round2(Number(value) || 0);
}

function sameMoney(a, b) {
  return money(a) === money(b);
}

export function visaBasisFromLive(visa) {
  return {
    visa_sales: money(visa?.visa_sales),
    visa_other_receipts: money(visa?.visa_other_receipts),
    visa_refunds: money(visa?.visa_refunds),
    visa_net: money(visa?.visa_net),
    visa_receipt_count: Number(visa?.visa_receipt_count) || 0,
    visa_refund_count: Number(visa?.visa_refund_count) || 0,
  };
}

export function visaBasisMatches(live, submitted) {
  if (!submitted || typeof submitted !== "object") return false;
  const basis = visaBasisFromLive(live);
  return (
    sameMoney(basis.visa_sales, submitted.visa_sales) &&
    sameMoney(basis.visa_other_receipts, submitted.visa_other_receipts) &&
    sameMoney(basis.visa_refunds, submitted.visa_refunds) &&
    sameMoney(basis.visa_net, submitted.visa_net) &&
    basis.visa_receipt_count === (Number(submitted.visa_receipt_count) || 0) &&
    basis.visa_refund_count === (Number(submitted.visa_refund_count) || 0)
  );
}

/**
 * Blank means the counter has not entered a machine total.
 * Explicit zero and a negative net are real entries.
 */
export function readVisaMachineInput(body) {
  if (!body || typeof body !== "object" || !Object.prototype.hasOwnProperty.call(body, "visa_machine_net")) {
    return null;
  }
  const raw = body.visa_machine_net;
  if (raw == null || (typeof raw === "string" && raw.trim() === "")) return null;
  const machineNet = round2(Number(raw));
  if (!Number.isFinite(machineNet)) {
    throw badRequest("صافي جهاز الفيزا غير صالح", "VISA_MACHINE_INVALID");
  }
  if (!body.visa_basis || typeof body.visa_basis !== "object") {
    throw badRequest("أساس مطابقة الفيزا مطلوب", "VISA_BASIS_REQUIRED");
  }
  return { machineNet, basis: body.visa_basis };
}

export function snapshotFromShift(shift) {
  if (!shift || shift.visa_machine_net == null || shift.visa_machine_net === "") return null;
  return {
    sales: money(shift.visa_expected_sales),
    other: money(shift.visa_expected_other),
    refunds: money(shift.visa_expected_refunds),
    net: money(shift.visa_expected_net),
    receipt_count: Number(shift.visa_receipt_count) || 0,
    refund_count: Number(shift.visa_refund_count) || 0,
    machine_net: round2(Number(shift.visa_machine_net)),
    difference: money(shift.visa_difference),
    counted_by: shift.visa_counted_by == null ? null : Number(shift.visa_counted_by),
    counted_at: shift.visa_counted_at || null,
  };
}

export function visaBasisChanged(live, saved) {
  if (!saved) return false;
  if (live?.visa_incomplete) return true;
  const basis = visaBasisFromLive(live);
  return (
    !sameMoney(basis.visa_sales, saved.sales) ||
    !sameMoney(basis.visa_other_receipts, saved.other) ||
    !sameMoney(basis.visa_refunds, saved.refunds) ||
    !sameMoney(basis.visa_net, saved.net) ||
    basis.visa_receipt_count !== saved.receipt_count ||
    basis.visa_refund_count !== saved.refund_count
  );
}

export function visaState(saved) {
  if (!saved) return "awaiting";
  if (money(saved.difference) === 0) return "matched";
  return "difference";
}

export function visaStatusLabel(state, difference) {
  if (state === "awaiting") return VISA_RECONCILE_LABELS.waiting;
  if (state === "matched") return VISA_RECONCILE_LABELS.matched;
  const diff = money(difference);
  const abs = Math.abs(diff);
  const text = Number.isInteger(abs)
    ? String(abs)
    : abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return diff < 0 ? `ناقص ${text}` : `زائد ${text}`;
}

export function presentShiftVisa(shift, live) {
  const source = live || {
    visa_sales: 0,
    visa_other_receipts: 0,
    visa_refunds: 0,
    visa_net: 0,
    visa_receipt_count: 0,
    visa_refund_count: 0,
    visa_incomplete: false,
  };
  const saved = snapshotFromShift(shift);
  const state = visaState(saved);
  const incomplete = !!source.visa_incomplete;
  return {
    live: visaBasisFromLive(source),
    incomplete,
    known_only: incomplete,
    saved,
    state,
    status_label: visaStatusLabel(state, saved?.difference),
    basis_changed: visaBasisChanged(source, saved),
    can_reconcile: !saved && !incomplete,
    labels: VISA_RECONCILE_LABELS,
    machine_hint: VISA_MACHINE_HINT,
  };
}

function snapshotPayload(shift) {
  const saved = snapshotFromShift(shift);
  return saved;
}

export async function saveVisaReconciliation(db, { shiftId, machineNet, basis, userId }) {
  const shift = await db.get("SELECT * FROM cashier_shifts WHERE id = ?", [shiftId]);
  if (!shift) throw notFound("الوردية غير موجودة");
  const live = await computeShiftVisa(db, shiftId);
  const existing = snapshotFromShift(shift);
  if (existing) {
    if (sameMoney(existing.machine_net, machineNet)) {
      return { idempotent: true, created: false, reconciliation: presentShiftVisa(shift, live) };
    }
    throw conflict(
      "مطابقة الفيزا محفوظة. صحّح المبلغ من تصحيح جهاز الفيزا.",
      "VISA_ALREADY_RECONCILED"
    );
  }
  if (live.visa_incomplete) {
    throw badRequest(
      "سجل الفيزا غير مكتمل. لا تُحفظ المطابقة على المبلغ المعروف فقط.",
      "VISA_INCOMPLETE"
    );
  }
  if (!visaBasisMatches(live, basis)) {
    throw conflict("تغيّرت عمليات الفيزا. حدّث الشاشة قبل الحفظ.", "VISA_BASIS_STALE");
  }
  const basisLive = visaBasisFromLive(live);
  const difference = round2(machineNet - basisLive.visa_net);
  const now = new Date().toISOString();
  const upd = await db.run(
    `UPDATE cashier_shifts SET
       visa_machine_net = ?,
       visa_expected_sales = ?,
       visa_expected_other = ?,
       visa_expected_refunds = ?,
       visa_expected_net = ?,
       visa_receipt_count = ?,
       visa_refund_count = ?,
       visa_difference = ?,
       visa_counted_by = ?,
       visa_counted_at = ?
     WHERE id = ? AND visa_machine_net IS NULL`,
    [
      machineNet,
      basisLive.visa_sales,
      basisLive.visa_other_receipts,
      basisLive.visa_refunds,
      basisLive.visa_net,
      basisLive.visa_receipt_count,
      basisLive.visa_refund_count,
      difference,
      userId ?? null,
      now,
      shiftId,
    ]
  );
  const fresh = await db.get("SELECT * FROM cashier_shifts WHERE id = ?", [shiftId]);
  if (!upd.changes) {
    const raced = snapshotFromShift(fresh);
    if (raced && sameMoney(raced.machine_net, machineNet)) {
      return { idempotent: true, created: false, reconciliation: presentShiftVisa(fresh, live) };
    }
    throw conflict(
      "مطابقة الفيزا محفوظة. صحّح المبلغ من تصحيح جهاز الفيزا.",
      "VISA_ALREADY_RECONCILED"
    );
  }
  return {
    idempotent: false,
    created: true,
    reconciliation: presentShiftVisa(fresh, live),
    audit: {
      old: null,
      next: snapshotPayload(fresh),
    },
  };
}

export async function correctVisaMachine(db, { shiftId, machineNet, reason, userId }) {
  const text = String(reason || "").trim();
  if (!text) throw badRequest("سبب التصحيح مطلوب", "VISA_CORRECTION_REASON");
  if (text.length > 500) throw badRequest("سبب التصحيح أطول من المسموح", "VISA_CORRECTION_REASON");
  const machine = round2(Number(machineNet));
  if (!Number.isFinite(machine)) throw badRequest("صافي جهاز الفيزا غير صالح", "VISA_MACHINE_INVALID");

  const shift = await db.get("SELECT * FROM cashier_shifts WHERE id = ?", [shiftId]);
  if (!shift) throw notFound("الوردية غير موجودة");
  const existing = snapshotFromShift(shift);
  if (!existing) throw badRequest("لا توجد مطابقة فيزا لتصحيحها", "VISA_NOT_RECONCILED");
  const live = await computeShiftVisa(db, shiftId);
  if (sameMoney(existing.machine_net, machine)) {
    return { idempotent: true, created: false, reconciliation: presentShiftVisa(shift, live) };
  }
  const revisedDifference = round2(machine - existing.net);
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO shift_visa_corrections (
       shift_id, previous_machine_net, revised_machine_net, previous_difference, revised_difference,
       expected_sales, expected_other, expected_refunds, expected_net, receipt_count, refund_count,
       reason, corrected_by, corrected_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      shiftId,
      existing.machine_net,
      machine,
      existing.difference,
      revisedDifference,
      existing.sales,
      existing.other,
      existing.refunds,
      existing.net,
      existing.receipt_count,
      existing.refund_count,
      text,
      userId ?? null,
      now,
    ]
  );
  await db.run(
    `UPDATE cashier_shifts SET visa_machine_net = ?, visa_difference = ? WHERE id = ?`,
    [machine, revisedDifference, shiftId]
  );
  const fresh = await db.get("SELECT * FROM cashier_shifts WHERE id = ?", [shiftId]);
  return {
    idempotent: false,
    created: true,
    reconciliation: presentShiftVisa(fresh, live),
    audit: {
      old: {
        machine_net: existing.machine_net,
        difference: existing.difference,
        expected_net: existing.net,
        counted_by: existing.counted_by,
        counted_at: existing.counted_at,
      },
      next: {
        machine_net: machine,
        difference: revisedDifference,
        expected_net: existing.net,
        reason: text,
        corrected_by: userId ?? null,
        corrected_at: now,
      },
    },
  };
}

export async function listVisaCorrections(db, shiftId) {
  return db.all(
    `SELECT c.id, c.shift_id, c.previous_machine_net, c.revised_machine_net,
            c.previous_difference, c.revised_difference, c.expected_sales, c.expected_other,
            c.expected_refunds, c.expected_net, c.receipt_count, c.refund_count,
            c.reason, c.corrected_by, c.corrected_at, u.username AS corrected_by_name
     FROM shift_visa_corrections c
     LEFT JOIN users u ON u.id = c.corrected_by
     WHERE c.shift_id = ?
     ORDER BY c.id ASC`,
    [shiftId]
  );
}

export async function listShiftVisaActivity(db, shiftId) {
  const saleRows = await db.all(
    `SELECT t.id AS transaction_id, t.receipt_number, t.created_at, t.payment_method AS sale_method,
            sp.id AS payment_id, COALESCE(sp.nis_equivalent, sp.amount) AS visa_amount
     FROM sale_payments sp
     INNER JOIN transactions t ON t.id = sp.transaction_id
     WHERE t.shift_id = ? AND sp.payment_method = 'visa' AND t.status = 'completed'
     ORDER BY t.created_at ASC, t.id ASC, sp.id ASC`,
    [shiftId]
  );
  const refundRows = await db.all(
    `SELECT r.id AS refund_id, r.original_transaction_id, r.total, r.created_at, r.shift_id,
            t.receipt_number AS original_receipt_number
     FROM refunds r
     LEFT JOIN transactions t ON t.id = r.original_transaction_id
     WHERE r.shift_id = ? AND r.status = 'approved' AND r.payment_method = 'visa'
     ORDER BY r.created_at ASC, r.id ASC`,
    [shiftId]
  );
  const bySale = new Map();
  for (const row of saleRows) {
    const key = Number(row.transaction_id);
    const prev = bySale.get(key) || {
      kind: "sale",
      type_label: "بيع",
      transaction_id: key,
      receipt_number: row.receipt_number || null,
      reference: row.receipt_number ? String(row.receipt_number) : `#${key}`,
      created_at: row.created_at,
      sale_method: row.sale_method,
      visa_amount: 0,
      reversal: null,
    };
    prev.visa_amount = round2(prev.visa_amount + (Number(row.visa_amount) || 0));
    bySale.set(key, prev);
  }
  const refundsBySale = new Map();
  const refundLines = refundRows.map((row) => {
    const originalId = row.original_transaction_id == null ? null : Number(row.original_transaction_id);
    const line = {
      kind: "refund",
      type_label: "مرتجع",
      refund_id: Number(row.refund_id),
      transaction_id: originalId,
      receipt_number: row.original_receipt_number || null,
      reference: row.original_receipt_number
        ? String(row.original_receipt_number)
        : originalId
          ? `#${originalId}`
          : `#${row.refund_id}`,
      created_at: row.created_at,
      visa_amount: money(row.total),
      reversal: {
        refund_id: Number(row.refund_id),
        original_transaction_id: originalId,
        original_receipt_number: row.original_receipt_number || null,
        shift_id: Number(row.shift_id),
      },
    };
    if (originalId) {
      const list = refundsBySale.get(originalId) || [];
      list.push(line.reversal);
      refundsBySale.set(originalId, list);
    }
    return line;
  });
  for (const [id, line] of bySale) {
    const reversals = refundsBySale.get(id);
    if (reversals?.length) line.reversal = reversals[0];
  }
  return [...bySale.values(), ...refundLines];
}

function shiftBusinessDay(shift) {
  return shopBusinessDayYmd({
    business_day: shift.business_day,
    start_time: shift.start_time,
  });
}

export function buildVisaShiftRow(shift, live) {
  const saved = snapshotFromShift(shift);
  const state = visaState(saved);
  const incomplete = !!live?.visa_incomplete;
  const current = {
    sales: money(live?.visa_sales),
    other: money(live?.visa_other_receipts),
    refunds: money(live?.visa_refunds),
    net: money(live?.visa_net),
    receipt_count: Number(live?.visa_receipt_count) || 0,
    refund_count: Number(live?.visa_refund_count) || 0,
    incomplete,
  };
  const display = saved
    ? {
        sales: saved.sales,
        other: saved.other,
        refunds: saved.refunds,
        expected_net: saved.net,
        receipt_count: saved.receipt_count,
        refund_count: saved.refund_count,
        machine_net: saved.machine_net,
        difference: saved.difference,
      }
    : {
        sales: current.sales,
        other: current.other,
        refunds: current.refunds,
        expected_net: current.net,
        receipt_count: current.receipt_count,
        refund_count: current.refund_count,
        machine_net: null,
        difference: null,
      };
  return {
    shift_id: Number(shift.id),
    cashier_id: Number(shift.cashier_id),
    cashier_name: shift.cashier_name || "",
    business_day: shiftBusinessDay(shift),
    shift_status: shift.status,
    state,
    status_label: visaStatusLabel(state, saved?.difference),
    incomplete,
    known_only: incomplete && !saved,
    basis_changed: visaBasisChanged(live, saved),
    counted_by: saved?.counted_by ?? null,
    counted_at: saved?.counted_at ?? null,
    current,
    ...display,
  };
}

export function summarizeVisaRows(rows) {
  let expectedNet = 0;
  let liveExpected = 0;
  let receiptCount = 0;
  let machine = 0;
  let countedExpected = 0;
  let difference = 0;
  let awaiting = 0;
  let awaitingShifts = 0;
  let countedShifts = 0;
  let differenceShifts = 0;
  let matchedShifts = 0;
  let incompleteShifts = 0;
  let basisChangedShifts = 0;
  let coverageIncomplete = false;

  for (const row of rows) {
    liveExpected = round2(liveExpected + row.current.net);
    receiptCount += row.current.receipt_count;
    if (row.current.incomplete) {
      incompleteShifts += 1;
      coverageIncomplete = true;
    }
    if (row.basis_changed) basisChangedShifts += 1;
    if (row.state === "awaiting") {
      awaitingShifts += 1;
      awaiting = round2(awaiting + row.current.net);
      expectedNet = round2(expectedNet + row.current.net);
    } else {
      countedShifts += 1;
      machine = round2(machine + row.machine_net);
      countedExpected = round2(countedExpected + row.expected_net);
      difference = round2(difference + row.difference);
      expectedNet = round2(expectedNet + row.expected_net);
      if (row.state === "matched") matchedShifts += 1;
      else differenceShifts += 1;
    }
  }

  return {
    coverage: coverageIncomplete ? "incomplete" : "complete",
    expected_label: coverageIncomplete ? VISA_RECONCILE_LABELS.known : "صافي تحصيلات الفيزا",
    expected_net: expectedNet,
    live_expected_net: liveExpected,
    receipt_count: receiptCount,
    machine_net: countedShifts ? machine : null,
    counted_expected_net: countedShifts ? countedExpected : null,
    difference: countedShifts ? difference : null,
    awaiting_expected_net: awaiting,
    awaiting_shifts: awaitingShifts,
    counted_shifts: countedShifts,
    difference_shifts: differenceShifts,
    matched_shifts: matchedShifts,
    incomplete_shifts: incompleteShifts,
    basis_changed_shifts: basisChangedShifts,
    shift_count: rows.length,
  };
}

function parseYmd(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  return value.trim();
}

export async function queryVisaReport(db, { from, to, cashierId = null, shiftId = null, state = null }) {
  const fromYmd = parseYmd(from);
  const toYmd = parseYmd(to);
  if (!fromYmd || !toYmd || fromYmd > toYmd) {
    throw badRequest("فترة التقرير غير صالحة", "VISA_RANGE_INVALID");
  }
  const allowed = new Set(["awaiting", "matched", "difference"]);
  const stateFilter = state && state !== "all" ? String(state) : null;
  if (stateFilter && !allowed.has(stateFilter)) {
    throw badRequest("حالة المطابقة غير صالحة", "VISA_STATE_INVALID");
  }
  const { startIso, endIso } = shopYmdRangeToUtcBounds(fromYmd, toYmd);
  const params = [fromYmd, toYmd, toSqlUtc(startIso), toSqlUtc(endIso)];
  let sql = `
    SELECT s.*, u.username AS cashier_name
    FROM cashier_shifts s
    JOIN users u ON u.id = s.cashier_id
    WHERE (
      (s.business_day IS NOT NULL AND s.business_day >= ? AND s.business_day <= ?)
      OR (s.business_day IS NULL AND datetime(s.start_time) >= datetime(?) AND datetime(s.start_time) <= datetime(?))
    )`;
  sql += " ORDER BY COALESCE(s.business_day, s.start_time), s.id";
  const allShifts = await db.all(sql, params);
  const cashiers = [];
  const seenCashiers = new Set();
  for (const shift of allShifts) {
    const id = Number(shift.cashier_id);
    if (seenCashiers.has(id)) continue;
    seenCashiers.add(id);
    cashiers.push({ id, name: shift.cashier_name || "" });
  }
  let shifts = allShifts;
  if (cashierId) shifts = shifts.filter((shift) => Number(shift.cashier_id) === Number(cashierId));
  if (shiftId) {
    const wanted = Number(shiftId);
    if (!Number.isInteger(wanted) || wanted <= 0) {
      throw badRequest("معرّف الوردية غير صالح", "VISA_SHIFT_INVALID");
    }
    shifts = shifts.filter((shift) => Number(shift.id) === wanted);
  }
  const liveMap = await computeShiftVisaMap(
    db,
    shifts.map((row) => row.id)
  );
  let rows = shifts.map((shift) => buildVisaShiftRow(shift, liveMap.get(Number(shift.id))));
  if (stateFilter) rows = rows.filter((row) => row.state === stateFilter);
  return {
    from: fromYmd,
    to: toYmd,
    summary: summarizeVisaRows(rows),
    cashiers,
    shifts: rows,
  };
}
