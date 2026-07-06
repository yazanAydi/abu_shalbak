/** Canonical Arabic unit names for POS sellable units. */
export const CANONICAL_UNIT_NAMES = [
  "حبة",
  "قنينة",
  "علبة",
  "صندوق",
  "ربطة",
  "كرتونة",
  "كيس",
  "بكيت",
  "كغم",
];

/** @type {Map<string, string>} */
const ALIAS_MAP = new Map([
  ["قنية", "قنينة"],
  ["قنينية", "قنينة"],
  ["علبه", "علبة"],
  ["ريطة", "ربطة"],
  ["كرتون", "كرتونة"],
  ["أساسي", "حبة"],
]);

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeUnitName(raw) {
  const trimmed = String(raw ?? "").trim().replace(/[:：]+$/, "").trim();
  if (!trimmed) return "حبة";
  if (ALIAS_MAP.has(trimmed)) return ALIAS_MAP.get(trimmed);
  if (CANONICAL_UNIT_NAMES.includes(trimmed)) return trimmed;
  return trimmed;
}

/** Pack-only product name prefixes (absorb as unit row, not standalone product). */
const PACK_NAME_PREFIXES = ["صندوق", "كرتونة", "علبة", "ربطة", "كيس", "بكيت"];

/**
 * @param {string} name
 * @returns {boolean}
 */
export function looksLikePackOnlyProduct(name) {
  const n = String(name ?? "").trim();
  return PACK_NAME_PREFIXES.some((p) => n.startsWith(p));
}
