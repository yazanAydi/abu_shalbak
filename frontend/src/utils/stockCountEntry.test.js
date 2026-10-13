import {
  countLinePayload,
  countLinesPayload,
  countQtyEntered,
  countDocumentDepartment,
  countScopeParams,
  editorRowFromCountLine,
  firstIncompleteCount,
  interpretCountExpiry,
  missingCountSources,
  removedProductIds,
  seedCountExpiry,
  sourceIdentity,
  validateCountDraft,
  validateCountLine,
} from "./stockCountEntry";

const picture = {
  has_dated_batches: true,
  sources: [
    { batch_source: "dated", expiry_date: "2027-01-01", quantity: 4 },
    { batch_source: "dated", expiry_date: "2027-06-01", quantity: 2 },
    { batch_source: "undated", expiry_date: null, quantity: 1 },
  ],
};

function row(partial) {
  return {
    line_key: partial.line_key,
    product_id: 1,
    name: "حليب",
    counted_qty: "1",
    expiry_date: "",
    expiry_invalid: false,
    ...partial,
  };
}

describe("stockCountEntry", () => {
  test("zero is a counted quantity and a blank field is not", () => {
    expect(countQtyEntered(0)).toBe(true);
    expect(countQtyEntered("0")).toBe(true);
    expect(countQtyEntered("")).toBe(false);
    expect(countQtyEntered("  ")).toBe(false);
    expect(countQtyEntered(null)).toBe(false);
    expect(validateCountLine({ product_id: 1, counted_qty: "0", expiry_date: "" })).toBeNull();
    expect(validateCountLine({ product_id: 1, counted_qty: "", expiry_date: "" }).field).toBe("qty");
  });

  test("a blank expiry stays blank and an invalid date is not rewritten", () => {
    expect(interpretCountExpiry("").date).toBe("");
    expect(interpretCountExpiry(null).date).toBe("");
    expect(interpretCountExpiry("31/02/26").ok).toBe(false);
    expect(interpretCountExpiry("2026-02-31").ok).toBe(false);
    const undated = editorRowFromCountLine({
      product_id: 4,
      name: "حليب",
      counted_qty: 0,
      batch_source: "undated",
      expiry_date: null,
    });
    expect(undated.expiry_date).toBe("");
    expect(undated.counted_qty).toBe("0");
    expect(editorRowFromCountLine({
      product_id: 4,
      counted_qty: 3,
      batch_source: "dated",
      expiry_date: "2027-03-01",
    }).expiry_date).toBe("2027-03-01");
  });

  test("two expiry dates stay separate and omitted sources are not filled with zero", () => {
    const rows = [
      row({ line_key: "a", counted_qty: "3", expiry_date: "2027-01-01" }),
      row({ line_key: "b", counted_qty: "5", expiry_date: "2027-06-01" }),
    ];
    expect(validateCountDraft(rows, { 1: picture })).toBeNull();
    expect(rows.map((item) => countLinePayload(item, picture))).toEqual([
      { batch_source: "dated", expiry_date: "2027-01-01", counted_qty: 3 },
      { batch_source: "dated", expiry_date: "2027-06-01", counted_qty: 5 },
    ]);
    expect(missingCountSources(picture, rows).map(sourceIdentity)).toEqual(["blank"]);
    expect(firstIncompleteCount(rows, { 1: picture }).message).toMatch(/غير مكتمل/);
    expect(countLinePayload(rows[0], picture).counted_qty).not.toBe(0);
  });

  test("the same product and expiry is rejected instead of being counted twice", () => {
    const issue = validateCountDraft([
      row({ line_key: "a", counted_qty: "1", expiry_date: "2027-01-01" }),
      row({ line_key: "b", counted_qty: "4", expiry_date: "2027-01-01" }),
    ], { 1: picture });
    expect(issue.message).toMatch(/لن يُحسب الجرد مرتين/);
  });

  test("explicit zero completes an undated source and a new date stays available", () => {
    const rows = [
      row({ line_key: "a", counted_qty: "3", expiry_date: "2027-01-01" }),
      row({ line_key: "b", counted_qty: "5", expiry_date: "2027-06-01" }),
      row({ line_key: "c", counted_qty: "0", expiry_date: "" }),
      row({ line_key: "d", counted_qty: "2", expiry_date: "2028-01-01" }),
    ];
    expect(validateCountDraft(rows, { 1: picture })).toBeNull();
    expect(firstIncompleteCount(rows, { 1: picture })).toBeNull();
    expect(countLinesPayload(rows, picture)).toEqual([
      { batch_source: "dated", expiry_date: "2027-01-01", counted_qty: 3 },
      { batch_source: "dated", expiry_date: "2027-06-01", counted_qty: 5 },
      { batch_source: "undated", expiry_date: null, counted_qty: 0 },
      { batch_source: "dated", expiry_date: "2028-01-01", counted_qty: 2 },
    ]);
    expect(missingCountSources(picture, rows.slice(0, 2)).map(sourceIdentity)).toEqual(["blank"]);
  });

  test("a product without dated batches accepts a first date and still counts undated stock", () => {
    const plain = { has_dated_batches: false, sources: [], product_stock: 10, product_expiry_date: "2031-01-15" };
    const dated = row({ line_key: "a", product_id: 2, name: "خبز", counted_qty: "10", expiry_date: "2027-01-15" });
    const undated = row({ line_key: "b", product_id: 2, name: "خبز", counted_qty: "0", expiry_date: "" });
    expect(validateCountDraft([dated, undated], { 2: plain })).toBeNull();
    expect(countLinesPayload([dated, undated], plain)).toEqual([
      { batch_source: "dated", expiry_date: "2027-01-15", counted_qty: 10 },
      { batch_source: "undated", expiry_date: null, counted_qty: 0 },
    ]);
    expect(firstIncompleteCount([dated], { 2: plain })).toMatchObject({
      missing: [expect.objectContaining({ batch_source: "undated", quantity: 10 })],
    });
    expect(countLinePayload({ ...dated, expiry_date: "" }, plain)).toEqual({
      batch_source: null,
      expiry_date: null,
      counted_qty: 10,
    });
    const seeded = seedCountExpiry(
      { line_key: "n", product_id: 2, expiry_date: "", expiry_touched: false },
      plain
    );
    expect(seeded.expiry_date).toBe("");
    expect(seeded.product_expiry).toBe("2031-01-15");
  });

  test("one recorded batch prefills, several stay unselected, and a typed date is kept", () => {
    const one = {
      has_dated_batches: true,
      product_expiry_date: "2030-02-02",
      sources: [
        { batch_source: "dated", expiry_date: "2027-04-01", quantity: 4 },
        { batch_source: "undated", expiry_date: null, quantity: 1 },
      ],
    };
    const blank = { line_key: "n", product_id: 9, expiry_date: "", expiry_touched: false };
    expect(seedCountExpiry(blank, one).expiry_date).toBe("2027-04-01");
    expect(seedCountExpiry({ ...blank, expiry_date: "2028-08-08", expiry_touched: true }, one).expiry_date)
      .toBe("2028-08-08");
    const many = seedCountExpiry(blank, picture);
    expect(many.expiry_date).toBe("");
    expect(many.known_expiries).toEqual(["2027-01-01", "2027-06-01"]);
    const reopened = editorRowFromCountLine({
      product_id: 9,
      counted_qty: 3,
      batch_source: "dated",
      expiry_date: "2028-08-08",
    });
    expect(seedCountExpiry(reopened, one).expiry_date).toBe("2028-08-08");
  });

  test("department search params and removed products stay scoped to the open editor", () => {
    expect(countDocumentDepartment("retail", null)).toBe("retail");
    expect(countDocumentDepartment("bakery", null)).toBe("bakery");
    expect(countDocumentDepartment(null, "bakery")).toBe("bakery");
    expect(countScopeParams("retail", null)).toEqual({ department: "retail", scope: "retail" });
    expect(countScopeParams("bakery", null)).toEqual({ department: "bakery", scope: "bakery" });
    expect(countScopeParams(null, "bakery")).toEqual({ department: "bakery", scope: "bakery" });
    expect(removedProductIds([1, 2], [row({ line_key: "a", product_id: 1 })])).toEqual([2]);
  });
});
