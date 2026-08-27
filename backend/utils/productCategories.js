export const BAKERY_CATEGORY_NAME = "مواد مخبز";

export function normalizeCategoryName(raw) {
  if (raw == null) return null;
  const name = String(raw).trim();
  return name || null;
}

export async function findProductCategoryByName(db, rawName) {
  const name = normalizeCategoryName(rawName);
  if (!name) return null;
  return db.get(
    "SELECT * FROM product_categories WHERE LOWER(name) = LOWER(?) LIMIT 1",
    [name]
  );
}

export async function ensureProductCategory(db, rawName) {
  const name = normalizeCategoryName(rawName);
  if (!name) return null;
  const existing = await findProductCategoryByName(db, name);
  if (existing) {
    if (!existing.active) {
      await db.run("UPDATE product_categories SET active = 1 WHERE id = ?", [existing.id]);
      return { ...existing, active: 1 };
    }
    return existing;
  }
  const ins = await db.run(
    "INSERT INTO product_categories (name, active) VALUES (?, 1)",
    [name]
  );
  return db.get("SELECT * FROM product_categories WHERE id = ?", [ins.lastID]);
}

export async function listProductCategories(db, { activeOnly = false } = {}) {
  if (activeOnly) {
    return db.all(
      "SELECT * FROM product_categories WHERE active = 1 ORDER BY name COLLATE NOCASE"
    );
  }
  return db.all(
    "SELECT * FROM product_categories ORDER BY active DESC, name COLLATE NOCASE"
  );
}

export async function seedProductCategoriesFromProducts(db) {
  const rows = await db.all(
    `SELECT DISTINCT TRIM(category) AS name FROM products
     WHERE category IS NOT NULL AND TRIM(category) != ''`
  );
  const names = new Set(rows.map((r) => r.name).filter(Boolean));
  names.add(BAKERY_CATEGORY_NAME);
  for (const name of names) {
    await db.run("INSERT OR IGNORE INTO product_categories (name) VALUES (?)", [name]);
  }
}

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

export async function createProductCategory(db, rawName) {
  const name = normalizeCategoryName(rawName);
  if (!name) throw httpError(400, "اسم التصنيف مطلوب", "VALIDATION_ERROR");
  const existing = await findProductCategoryByName(db, name);
  if (existing) throw httpError(409, "هذا التصنيف موجود بالفعل", "DUPLICATE");
  const ins = await db.run(
    "INSERT INTO product_categories (name, active) VALUES (?, 1)",
    [name]
  );
  return db.get("SELECT * FROM product_categories WHERE id = ?", [ins.lastID]);
}

export async function updateProductCategory(db, id, { name, active } = {}) {
  const ex = await db.get("SELECT * FROM product_categories WHERE id = ?", [id]);
  if (!ex) throw httpError(404, "غير موجود", "NOT_FOUND");

  let nextName = ex.name;
  if (name !== undefined) {
    const n = normalizeCategoryName(name);
    if (!n) throw httpError(400, "اسم التصنيف مطلوب", "VALIDATION_ERROR");
    const clash = await findProductCategoryByName(db, n);
    if (clash && Number(clash.id) !== Number(ex.id)) {
      throw httpError(409, "هذا التصنيف موجود بالفعل", "DUPLICATE");
    }
    nextName = n;
  }
  const nextActive = active !== undefined ? (active ? 1 : 0) : ex.active;

  if (nextName !== ex.name) {
    await db.run("UPDATE products SET category = ? WHERE category = ?", [nextName, ex.name]);
    await db.run("UPDATE promotions SET category = ? WHERE category = ?", [nextName, ex.name]);
  }
  await db.run(
    "UPDATE product_categories SET name = ?, active = ? WHERE id = ?",
    [nextName, nextActive, id]
  );
  return db.get("SELECT * FROM product_categories WHERE id = ?", [id]);
}

export async function deleteProductCategory(db, id) {
  const ex = await db.get("SELECT * FROM product_categories WHERE id = ?", [id]);
  if (!ex) throw httpError(404, "غير موجود", "NOT_FOUND");
  const usedProducts = await db.get(
    "SELECT COUNT(*) AS n FROM products WHERE category = ?",
    [ex.name]
  );
  const usedPromos = await db.get(
    "SELECT COUNT(*) AS n FROM promotions WHERE category = ?",
    [ex.name]
  );
  if ((usedProducts?.n || 0) > 0 || (usedPromos?.n || 0) > 0) {
    await db.run("UPDATE product_categories SET active = 0 WHERE id = ?", [id]);
    return { success: true, deactivated: true };
  }
  await db.run("DELETE FROM product_categories WHERE id = ?", [id]);
  return { success: true, deactivated: false };
}
