const VALID_PARTY_TYPES = new Set(["supplier", "customer"]);
const DRAFT_PARAM_KEYS = ["new", "partyType", "partyId", "partyName", "partyCode", "partyBadge"];

function defaultPartyBadge(type) {
  return type === "supplier" ? "مورد" : "زبون";
}

/** Party object expected by PartyPicker / voucher lines. */
export function supplierAsVoucherParty(supplier) {
  if (!supplier || supplier.id == null) return null;
  return {
    type: "supplier",
    id: supplier.id,
    name: supplier.name || "",
    code: supplier.supplier_code || null,
    badge: "مورد",
  };
}

/**
 * Path to the existing receipt/payment voucher page with a new-draft prefill.
 * @param {"receipt"|"payment"} type
 * @param {{ type: string, id: number, name?: string, code?: string|null, badge?: string } | null} party
 */
export function voucherDraftPath(type, party) {
  const q = new URLSearchParams();
  q.set("new", "1");
  if (party?.type) q.set("partyType", party.type);
  if (party?.id != null && party.id !== "") q.set("partyId", String(party.id));
  if (party?.name) q.set("partyName", party.name);
  if (party?.code) q.set("partyCode", String(party.code));
  if (party?.badge) q.set("partyBadge", party.badge);
  return `/vouchers/${type}?${q.toString()}`;
}

/**
 * @param {URLSearchParams | { get: (key: string) => string | null }} searchParams
 * @returns {{ wantsNew: boolean, party: { type: string, id: number, name: string, code: string|null, badge: string } | null }}
 */
export function partyFromVoucherDraftParams(searchParams) {
  const wantsNew = searchParams.get("new") === "1";
  if (!wantsNew) return { wantsNew: false, party: null };

  const type = String(searchParams.get("partyType") || "").trim();
  const id = Number(searchParams.get("partyId"));
  if (!VALID_PARTY_TYPES.has(type) || !Number.isFinite(id) || id <= 0) {
    return { wantsNew: true, party: null };
  }

  const codeRaw = searchParams.get("partyCode");
  const badgeRaw = searchParams.get("partyBadge");
  return {
    wantsNew: true,
    party: {
      type,
      id,
      name: searchParams.get("partyName") || "",
      code: codeRaw ? codeRaw : null,
      badge: badgeRaw || defaultPartyBadge(type),
    },
  };
}

export function stripVoucherDraftParams(searchParams) {
  const next = new URLSearchParams(searchParams);
  for (const key of DRAFT_PARAM_KEYS) next.delete(key);
  return next;
}
