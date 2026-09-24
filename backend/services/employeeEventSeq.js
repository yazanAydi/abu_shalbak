/**
 * Per-employee monotonic event sequence.
 *
 * Replay / as-of order is (event_date, event_seq) — never (date, kind_rank).
 * kind_rank is stored only as a label for later payroll kinds. Same-day
 * allocate → reverse → reallocate must sort by event_seq (1, 2, 3).
 *
 * Phase 3 (not implemented here):
 * - wrong_employee reclass changes recipient only; it does not void cash
 *   that the original person still holds.
 * - never_occurred POS payments must correct an erroneous drawer line
 *   separately from an explicit cash_returned movement; closed shifts stay
 *   closed.
 */

export const EVENT_KIND_RANK = {
  opening_unpaid: 10,
  opening_prepaid: 10,
  payroll_earn: 10,
  salary_payment: 10,
  salary_payment_reversal: 40,
  apply_salary: 20,
  allocation_reversal: 30,
  ledger_reversal: 40,
  payroll_earn_reversal: 40,
  payroll_run_reversal: 50,
};

export function compareEmployeeEvents(a, b) {
  const da = String(a.event_date || "");
  const db = String(b.event_date || "");
  if (da < db) return -1;
  if (da > db) return 1;
  return Number(a.event_seq) - Number(b.event_seq);
}

export function sortEmployeeEvents(events) {
  return [...events].sort(compareEmployeeEvents);
}

/**
 * Next seq for an employee. Must run inside withTransaction.
 * @param {object} db
 * @param {number} employeeId
 * @returns {Promise<number>}
 */
export async function nextEmployeeEventSeq(db, employeeId) {
  const row = await db.get(
    "SELECT next_seq FROM employee_event_clock WHERE employee_id = ?",
    [employeeId]
  );
  if (!row) {
    await db.run(
      "INSERT INTO employee_event_clock (employee_id, next_seq) VALUES (?, 2)",
      [employeeId]
    );
    return 1;
  }
  const seq = Number(row.next_seq);
  await db.run(
    "UPDATE employee_event_clock SET next_seq = next_seq + 1 WHERE employee_id = ?",
    [employeeId]
  );
  return seq;
}

/**
 * @param {object} db
 * @param {{ employeeId: number, eventDate: string, kind: string, eventSeq?: number, sourceTable?: string|null, sourceId?: number|null }} ev
 */
export async function appendEmployeeEvent(db, ev) {
  const kindRank = EVENT_KIND_RANK[ev.kind];
  if (kindRank == null) {
    throw new Error(`unknown employee event kind: ${ev.kind}`);
  }
  const eventSeq = ev.eventSeq != null ? Number(ev.eventSeq) : await nextEmployeeEventSeq(db, ev.employeeId);
  const ins = await db.run(
    `INSERT INTO employee_events
       (employee_id, event_seq, event_date, kind, kind_rank, source_table, source_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      ev.employeeId,
      eventSeq,
      ev.eventDate,
      ev.kind,
      kindRank,
      ev.sourceTable || null,
      ev.sourceId != null ? ev.sourceId : null,
    ]
  );
  return { id: ins.lastID, event_seq: eventSeq, kind_rank: kindRank };
}
