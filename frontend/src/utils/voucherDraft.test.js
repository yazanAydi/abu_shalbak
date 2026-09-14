import {
  partyFromVoucherDraftParams,
  stripVoucherDraftParams,
  supplierAsVoucherParty,
  voucherDraftPath,
} from "./voucherDraft";

describe("voucherDraft", () => {
  test("supplierAsVoucherParty maps a supplier row for PartyPicker", () => {
    expect(supplierAsVoucherParty({ id: 7, name: "شركة النور", supplier_code: "S-12" })).toEqual({
      type: "supplier",
      id: 7,
      name: "شركة النور",
      code: "S-12",
      badge: "مورد",
    });
    expect(supplierAsVoucherParty(null)).toBeNull();
  });

  test("voucherDraftPath encodes the selected supplier onto the existing voucher pages", () => {
    const party = supplierAsVoucherParty({ id: 7, name: "شركة النور", supplier_code: "S-12" });
    const payment = voucherDraftPath("payment", party);
    const receipt = voucherDraftPath("receipt", party);

    expect(payment.startsWith("/vouchers/payment?")).toBe(true);
    expect(receipt.startsWith("/vouchers/receipt?")).toBe(true);

    const paymentParams = new URLSearchParams(payment.split("?")[1]);
    expect(paymentParams.get("new")).toBe("1");
    expect(paymentParams.get("partyType")).toBe("supplier");
    expect(paymentParams.get("partyId")).toBe("7");
    expect(paymentParams.get("partyName")).toBe("شركة النور");
    expect(paymentParams.get("partyCode")).toBe("S-12");
  });

  test("partyFromVoucherDraftParams reads a new-draft prefill", () => {
    const params = new URLSearchParams(
      "new=1&partyType=supplier&partyId=7&partyName=%D8%B4%D8%B1%D9%83%D8%A9%20%D8%A7%D9%84%D9%86%D9%88%D8%B1&partyCode=S-12&partyBadge=%D9%85%D9%88%D8%B1%D8%AF"
    );
    expect(partyFromVoucherDraftParams(params)).toEqual({
      wantsNew: true,
      party: {
        type: "supplier",
        id: 7,
        name: "شركة النور",
        code: "S-12",
        badge: "مورد",
      },
    });
  });

  test("partyFromVoucherDraftParams ignores incomplete or absent prefills", () => {
    expect(partyFromVoucherDraftParams(new URLSearchParams(""))).toEqual({
      wantsNew: false,
      party: null,
    });
    expect(partyFromVoucherDraftParams(new URLSearchParams("new=1&partyType=supplier"))).toEqual({
      wantsNew: true,
      party: null,
    });
    expect(partyFromVoucherDraftParams(new URLSearchParams("new=1&partyType=bank&partyId=3"))).toEqual({
      wantsNew: true,
      party: null,
    });
  });

  test("stripVoucherDraftParams keeps unrelated keys such as id", () => {
    const next = stripVoucherDraftParams(
      new URLSearchParams("new=1&partyType=supplier&partyId=7&id=22&status=draft")
    );
    expect(next.get("new")).toBeNull();
    expect(next.get("partyId")).toBeNull();
    expect(next.get("id")).toBe("22");
    expect(next.get("status")).toBe("draft");
  });
});
