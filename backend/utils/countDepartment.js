/**
 * Stock-count documents are per inventory department.
 *
 * Department is products.inventory_scope: retail (supermarket) or bakery.
 * A bakery material sold at the supermarket POS stays one bakery product.
 * A retail product in a bakery sales category stays one supermarket product.
 * Sale place and POS availability do not create a second stock identity.
 */

import { withTransaction } from "./dbTx.js";

export const COUNT_DEPARTMENT_RETAIL = "retail";
export const COUNT_DEPARTMENT_BAKERY = "bakery";

const DEPARTMENTS = new Set([COUNT_DEPARTMENT_RETAIL, COUNT_DEPARTMENT_BAKERY]);

export function parseCountDepartment(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "supermarket") return COUNT_DEPARTMENT_RETAIL;
  if (DEPARTMENTS.has(raw)) return raw;
  return null;
}

/**
 * @param {{ id?: number, inventory_scope?: string }|null|undefined} product
 */
export function classifyCountProduct(product) {
  if (!product || product.id == null) return { kind: "missing", department: null };
  const scope = String(product.inventory_scope ?? "retail").trim().toLowerCase();
  if (!DEPARTMENTS.has(scope)) return { kind: "unknown_scope", department: null, scope };
  return { kind: scope, department: scope };
}

export function productFitsCountDepartment(classification, department) {
  return Boolean(classification?.department) && classification.department === department;
}

export function countProductMatchSql(department, alias = "p") {
  const col = alias ? `${alias}.inventory_scope` : "inventory_scope";
  return { sql: `COALESCE(${col}, 'retail') = ?`, params: [department] };
}

export async function otherOpenCountForProduct(db, sessionId, productId) {
  return db.get(
    `SELECT s.id AS session_id, s.department
       FROM stock_count_lines l
       JOIN stock_count_sessions s ON s.id = l.session_id
      WHERE l.product_id = ? AND s.status = 'open' AND s.id != ?
      LIMIT 1`,
    [Number(productId), Number(sessionId)]
  );
}

function lineSnapshot(line, classification) {
  return {
    line_id: line.id,
    product_id: line.product_id,
    name: line.name || null,
    kind: classification.kind,
    inventory_scope: line.inventory_scope ?? null,
    counted_qty: line.counted_qty,
    system_qty: line.system_qty,
    variance: line.variance,
    batch_source: line.batch_source ?? null,
    expiry_date: line.expiry_date ?? null,
    warehouse_id: line.warehouse_id ?? null,
  };
}

async function sessionLines(db, sessionId) {
  return db.all(
    `SELECT l.id, l.product_id, l.counted_qty, l.system_qty, l.variance,
            l.batch_source, l.expiry_date, l.warehouse_id,
            p.id AS product_row_id, p.name, p.inventory_scope
       FROM stock_count_lines l
       LEFT JOIN products p ON p.id = l.product_id
      WHERE l.session_id = ?
      ORDER BY l.id`,
    [sessionId]
  );
}

function classifyLines(lines) {
  const ambiguous = [];
  const byDepartment = new Map();
  for (const line of lines) {
    const product = line.product_row_id == null
      ? null
      : { id: line.product_id, inventory_scope: line.inventory_scope };
    const classification = classifyCountProduct(product);
    if (!classification.department) {
      ambiguous.push(lineSnapshot(line, classification));
      continue;
    }
    const bucket = byDepartment.get(classification.department) || [];
    bucket.push(line);
    byDepartment.set(classification.department, bucket);
  }
  return { ambiguous, byDepartment };
}

async function upsertHold(db, sessionId, reason, detail) {
  const json = JSON.stringify(detail);
  await db.run(
    `INSERT INTO stock_count_department_holds (session_id, reason, detail_json, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET
       reason = excluded.reason,
       detail_json = excluded.detail_json,
       updated_at = datetime('now')`,
    [sessionId, reason, json]
  );
  console.warn(
    `[migrate] open stock count ${sessionId} was left unposted and unassigned (${reason}); lines=${detail.lines?.length || 0}`
  );
}

async function clearHold(db, sessionId) {
  await db.run("DELETE FROM stock_count_department_holds WHERE session_id = ?", [sessionId]);
}

async function departmentBusy(db, department, exceptId) {
  return db.get(
    `SELECT id FROM stock_count_sessions
      WHERE status = 'open' AND department = ? AND id != ?`,
    [department, exceptId]
  );
}

/**
 * Assign or split open counts by inventory_scope. Does not post stock.
 * Posted and cancelled counts keep their lines; a single clear department is
 * recorded on the session so history can be reopened by that screen.
 * Repeated runs only touch sessions whose department is still unset.
 */
export async function assignStockCountDepartments(db) {
  const openSessions = await db.all(
    `SELECT id, status, notes, created_by, created_at
       FROM stock_count_sessions
      WHERE status = 'open' AND department IS NULL
      ORDER BY id`
  );

  for (const session of openSessions) {
    const lines = await sessionLines(db, session.id);
    if (!lines.length) continue;
    const { ambiguous, byDepartment } = classifyLines(lines);
    if (ambiguous.length) {
      await upsertHold(db, session.id, "ambiguous_lines", {
        session_id: session.id,
        reason: "ambiguous_lines",
        lines: ambiguous,
      });
      continue;
    }
    const departments = [...byDepartment.keys()];
    if (departments.length === 1) {
      const department = departments[0];
      const busy = await departmentBusy(db, department, session.id);
      if (busy) {
        await upsertHold(db, session.id, "department_busy", {
          session_id: session.id,
          reason: "department_busy",
          department,
          occupied_by: busy.id,
          lines: lines.map((line) => lineSnapshot(line, { kind: department })),
        });
        continue;
      }
      await db.run(
        `UPDATE stock_count_sessions
            SET department = ?
          WHERE id = ? AND status = 'open' AND department IS NULL`,
        [department, session.id]
      );
      await clearHold(db, session.id);
      continue;
    }

    const busy = [];
    for (const department of departments) {
      const other = await departmentBusy(db, department, session.id);
      if (other) busy.push({ department, occupied_by: other.id });
    }
    if (busy.length) {
      await upsertHold(db, session.id, "department_busy", {
        session_id: session.id,
        reason: "department_busy",
        busy,
        lines: lines.map((line) => lineSnapshot(line, classifyCountProduct(
          line.product_row_id == null ? null : { id: line.product_id, inventory_scope: line.inventory_scope }
        ))),
      });
      continue;
    }

    const keepDepartment = classifyCountProduct({
      id: lines[0].product_id,
      inventory_scope: lines[0].inventory_scope,
    }).department;
    const moving = departments.filter((department) => department !== keepDepartment);

    await withTransaction(db, async () => {
      for (const department of moving) {
        const movingLines = byDepartment.get(department) || [];
        const created = await db.run(
          `INSERT INTO stock_count_sessions
             (status, notes, created_by, created_at, department, split_from_session_id)
           VALUES ('open', ?, ?, ?, ?, ?)`,
          [session.notes ?? null, session.created_by ?? null, session.created_at, department, session.id]
        );
        const ids = movingLines.map((line) => line.id);
        const placeholders = ids.map(() => "?").join(", ");
        const updated = await db.run(
          `UPDATE stock_count_lines
              SET session_id = ?
            WHERE session_id = ? AND id IN (${placeholders})`,
          [created.lastID, session.id, ...ids]
        );
        if (Number(updated?.changes) !== ids.length) {
          throw new Error(`stock count split moved ${updated?.changes} of ${ids.length} lines`);
        }
      }
      const claimed = await db.run(
        `UPDATE stock_count_sessions
            SET department = ?
          WHERE id = ? AND status = 'open' AND department IS NULL`,
        [keepDepartment, session.id]
      );
      if (Number(claimed?.changes) !== 1) {
        throw new Error(`stock count ${session.id} could not keep department ${keepDepartment}`);
      }
    });
    await clearHold(db, session.id);
    console.info(
      `[migrate] split open stock count ${session.id} by inventory department without posting`
    );
  }

  const historical = await db.all(
    `SELECT id, status FROM stock_count_sessions
      WHERE department IS NULL AND status != 'open'
      ORDER BY id`
  );
  for (const session of historical) {
    const lines = await sessionLines(db, session.id);
    if (!lines.length) continue;
    const { ambiguous, byDepartment } = classifyLines(lines);
    if (ambiguous.length || byDepartment.size !== 1) continue;
    const department = [...byDepartment.keys()][0];
    await db.run(
      `UPDATE stock_count_sessions
          SET department = ?
        WHERE id = ? AND department IS NULL AND status = ?`,
      [department, session.id, session.status]
    );
  }
}
