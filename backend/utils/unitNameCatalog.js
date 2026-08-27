import { CANONICAL_UNIT_NAMES } from "./unitNames.js";

export function normalizeCatalogUnitName(raw) {
  if (raw == null) return null;
  const name = String(raw).trim();
  return name || null;
}

export async function findUnitNameByName(db, rawName) {
  const name = normalizeCatalogUnitName(rawName);
  if (!name) return null;
  return db.get(
    "SELECT * FROM unit_names WHERE LOWER(name) = LOWER(?) LIMIT 1",
    [name]
  );
}

export async function ensureUnitName(db, rawName) {
  const name = normalizeCatalogUnitName(rawName);
  if (!name) return null;
  const existing = await findUnitNameByName(db, name);
  if (existing) {
    if (!existing.active) {
      await db.run("UPDATE unit_names SET active = 1 WHERE id = ?", [existing.id]);
      return { ...existing, active: 1 };
    }
    return existing;
  }
  const ins = await db.run("INSERT INTO unit_names (name, active) VALUES (?, 1)", [name]);
  return db.get("SELECT * FROM unit_names WHERE id = ?", [ins.lastID]);
}

export async function listUnitNames(db, { activeOnly = false } = {}) {
  if (activeOnly) {
    return db.all("SELECT * FROM unit_names WHERE active = 1 ORDER BY name COLLATE NOCASE");
  }
  return db.all("SELECT * FROM unit_names ORDER BY active DESC, name COLLATE NOCASE");
}

export async function seedUnitNamesCatalog(db) {
  const names = new Set(CANONICAL_UNIT_NAMES);
  try {
    const fromUnits = await db.all(
      `SELECT DISTINCT TRIM(unit_name) AS name FROM product_units
       WHERE unit_name IS NOT NULL AND TRIM(unit_name) != ''`
    );
    for (const row of fromUnits) {
      if (row.name) names.add(row.name);
    }
  } catch {
    /* product_units may not exist yet */
  }
  try {
    const fromProducts = await db.all(
      `SELECT DISTINCT TRIM(unit) AS name FROM products
       WHERE unit IS NOT NULL AND TRIM(unit) != ''`
    );
    for (const row of fromProducts) {
      if (row.name) names.add(row.name);
    }
  } catch {
    /* products.unit may not exist yet */
  }
  for (const name of names) {
    await db.run("INSERT OR IGNORE INTO unit_names (name) VALUES (?)", [name]);
  }
}

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

export async function createUnitName(db, rawName) {
  const name = normalizeCatalogUnitName(rawName);
  if (!name) throw httpError(400, "اسم الوحدة مطلوب", "VALIDATION_ERROR");
  const existing = await findUnitNameByName(db, name);
  if (existing) throw httpError(409, "اسم الوحدة موجود بالفعل", "DUPLICATE");
  const ins = await db.run("INSERT INTO unit_names (name, active) VALUES (?, 1)", [name]);
  return db.get("SELECT * FROM unit_names WHERE id = ?", [ins.lastID]);
}

export async function updateUnitName(db, id, { name, active } = {}) {
  const ex = await db.get("SELECT * FROM unit_names WHERE id = ?", [id]);
  if (!ex) throw httpError(404, "غير موجود", "NOT_FOUND");

  let nextName = ex.name;
  if (name !== undefined) {
    const n = normalizeCatalogUnitName(name);
    if (!n) throw httpError(400, "اسم الوحدة مطلوب", "VALIDATION_ERROR");
    const clash = await findUnitNameByName(db, n);
    if (clash && Number(clash.id) !== Number(ex.id)) {
      throw httpError(409, "اسم الوحدة موجود بالفعل", "DUPLICATE");
    }
    nextName = n;
  }
  const nextActive = active !== undefined ? (active ? 1 : 0) : ex.active;

  if (nextName !== ex.name) {
    await db.run("UPDATE product_units SET unit_name = ? WHERE unit_name = ?", [nextName, ex.name]);
    await db.run("UPDATE products SET unit = ? WHERE unit = ?", [nextName, ex.name]);
  }
  await db.run(
    "UPDATE unit_names SET name = ?, active = ? WHERE id = ?",
    [nextName, nextActive, id]
  );
  return db.get("SELECT * FROM unit_names WHERE id = ?", [id]);
}

export async function deleteUnitName(db, id) {
  const ex = await db.get("SELECT * FROM unit_names WHERE id = ?", [id]);
  if (!ex) throw httpError(404, "غير موجود", "NOT_FOUND");
  const usedUnits = await db.get(
    "SELECT COUNT(*) AS n FROM product_units WHERE unit_name = ?",
    [ex.name]
  );
  const usedProducts = await db.get(
    "SELECT COUNT(*) AS n FROM products WHERE unit = ?",
    [ex.name]
  );
  if ((usedUnits?.n || 0) > 0 || (usedProducts?.n || 0) > 0) {
    await db.run("UPDATE unit_names SET active = 0 WHERE id = ?", [id]);
    return { success: true, deactivated: true };
  }
  await db.run("DELETE FROM unit_names WHERE id = ?", [id]);
  return { success: true, deactivated: false };
}
