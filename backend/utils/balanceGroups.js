/** @typedef {{ id: number, slug: string, label_ar: string, sort_order: number, is_system: number, active: number }} BalanceGroup */

export const SYSTEM_GROUP_SEED = [
  { slug: "zaboon", label_ar: "أرصدة الزبون", sort_order: 1 },
  { slug: "mashghilin", label_ar: "أرصدة المشغلين", sort_order: 2 },
  { slug: "omara", label_ar: "أرصدة العمارة", sort_order: 3 },
];

/** @type {Record<string, string>} */
export const IMPORT_TYPE_TO_GROUP_SLUG = {
  hesabati_customer_balances: "zaboon",
  hesabati_operator_balances: "mashghilin",
  hesabati_building_balances: "omara",
};

/**
 * @param {object} db
 * @param {string} slug
 */
export async function getBalanceGroupBySlug(db, slug) {
  return db.get(
    "SELECT * FROM customer_balance_groups WHERE slug = ? AND active = 1",
    [String(slug)]
  );
}

/**
 * @param {object} db
 * @param {number} id
 */
export async function getBalanceGroupById(db, id) {
  return db.get("SELECT * FROM customer_balance_groups WHERE id = ?", [Number(id)]);
}

/**
 * @param {object} db
 * @param {string} importType
 */
export async function getBalanceGroupIdForImportType(db, importType) {
  const slug = IMPORT_TYPE_TO_GROUP_SLUG[importType] || IMPORT_TYPE_TO_GROUP_SLUG.hesabati_customer_balances;
  const row = await getBalanceGroupBySlug(db, slug);
  return row?.id ?? null;
}

/**
 * @param {object} db
 */
export async function getDefaultBalanceGroupId(db) {
  const row = await getBalanceGroupBySlug(db, "zaboon");
  if (row) return row.id;
  const fallback = await db.get(
    "SELECT id FROM customer_balance_groups WHERE active = 1 ORDER BY sort_order, id LIMIT 1"
  );
  return fallback?.id ?? null;
}

/**
 * @param {string} labelAr
 */
export function slugFromLabel(labelAr) {
  const trimmed = String(labelAr || "").trim();
  const ascii = trimmed
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
  if (ascii && ascii.length >= 2) return ascii.slice(0, 48);
  return `group-${Date.now()}`;
}

/**
 * @param {object} db
 * @param {string} baseSlug
 */
export async function uniqueSlug(db, baseSlug) {
  let slug = baseSlug;
  let n = 0;
  while (await db.get("SELECT 1 AS x FROM customer_balance_groups WHERE slug = ?", [slug])) {
    n += 1;
    slug = `${baseSlug}-${n}`;
  }
  return slug;
}

/**
 * Short badge label from group label (e.g. "أرصدة الزبون" → "زبون").
 * @param {string | null | undefined} labelAr
 */
export function balanceGroupBadge(labelAr) {
  const label = String(labelAr || "").trim();
  if (!label) return "زبون";
  if (label.includes("مشغل")) return "مشغل";
  if (label.includes("عمارة")) return "عمارة";
  if (label.includes("زبون")) return "زبون";
  return label.replace(/^أرصدة\s+/i, "").trim() || label;
}
