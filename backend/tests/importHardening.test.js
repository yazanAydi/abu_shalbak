import {
  csvBufferToRecords,
  normalizeProductRow,
  MAX_IMPORT_ROWS,
  xlsxBufferToHeaderRows,
  collectBarcodesFromRow,
  isArabicRetailFormat,
  parseArabicRetailMatrix,
  classifyHeader,
} from "../utils/productImport.js";
import {
  extractBarcodesFromText,
  extractBarcodesFromValue,
  extractBarcodeEntries,
  uniqueBarcodeEntries,
  parsePrice,
  valueToText,
  scientificToInteger,
  normalizeArabicDigits,
} from "../utils/barcode.js";
import XLSX from "xlsx";

describe("Product import hardening", () => {
  test("strips prototype-pollution keys from CSV records", () => {
    const csv = "barcode,name,price,__proto__\n123,Item,5,polluted";
    const records = csvBufferToRecords(Buffer.from(csv, "utf8"));
    expect(records.length).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(records[0], "__proto__")).toBe(false);
    expect({}.polluted).toBeUndefined();
  });

  test("rejects files exceeding the row cap", () => {
    const header = "barcode,name,price\n";
    const body = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `${i},Item${i},5`).join(
      "\n"
    );
    expect(() => csvBufferToRecords(Buffer.from(header + body, "utf8"))).toThrow();
  });

  test("a normal row still imports correctly after hardening", () => {
    const records = csvBufferToRecords(
      Buffer.from("barcode,name,price\n9990001,Milk,4.5", "utf8")
    );
    const norm = normalizeProductRow(records[0]);
    expect(norm.ok).toBe(true);
    expect(norm.row.barcode).toBe("9990001");
    expect(norm.row.price).toBe(4.5);
    expect(norm.row.barcodes).toHaveLength(1);
  });

  test("multi-barcode cell extracts all codes", () => {
    const norm = normalizeProductRow({
      barcode: "8693029607095",
      name: "عصير مشكل",
      price: "10",
      _barcodeRawCells: [
        {
          col: 0,
          header: "barcode",
          raw: "علبة: 8693029607095 علبة: 8695504165090 علبة: 8693029607040",
          formatted: "علبة: 8693029607095 علبة: 8695504165090 علبة: 8693029607040",
          fromScientific: false,
        },
      ],
    });
    expect(norm.ok).toBe(true);
    expect(norm.row.barcodes.map((b) => b.barcode)).toEqual([
      "8693029607095",
      "8695504165090",
      "8693029607040",
    ]);
  });

  test("extracts قنينة labeled barcode", () => {
    const entries = extractBarcodesFromText("قنينة: 7290013586773");
    expect(entries).toHaveLength(1);
    expect(entries[0].barcode).toBe("7290013586773");
    expect(entries[0].label).toBe("قنينة");
  });

  test("extracts short internal code كرتونة: 12917", () => {
    const entries = extractBarcodesFromText("كرتونة: 12917");
    expect(entries).toHaveLength(1);
    expect(entries[0].barcode).toBe("12917");
    expect(entries[0].label).toBe("كرتونة");
  });

  test("scientificToInteger expands full EAN", () => {
    expect(scientificToInteger("7.290013586773E+12")).toBe("7290013586773");
  });

  test("extractBarcodesFromValue handles scientific string", () => {
    const codes = extractBarcodesFromValue("7.290013586773E+12");
    expect(codes).toContain("7290013586773");
  });

  test("does not extract barcode from price column", () => {
    const records = csvBufferToRecords(
      Buffer.from("barcode,name,price\n7290013586773,Juice,12.5", "utf8")
    );
    const collected = collectBarcodesFromRow(records[0]);
    expect(collected.extracted).toEqual(["7290013586773"]);
    expect(collected.extracted).not.toContain("12");
  });

  test("multi-label customer row extracts all barcodes", () => {
    const norm = normalizeProductRow({
      name: "منتج",
      price: "5",
      _barcodeRawCells: [
        { col: 0, header: "barcode", raw: "قنينة: 7290013586773", formatted: "قنينة: 7290013586773", fromScientific: false },
        { col: 1, header: "barcode2", raw: "كيس: 4015400612131", formatted: "كيس: 4015400612131", fromScientific: false },
        { col: 2, header: "units", raw: "كرتونة: 12917", formatted: "كرتونة: 12917", fromScientific: false },
      ],
    });
    expect(norm.ok).toBe(true);
    expect(norm.row.barcodes.map((b) => b.barcode).sort()).toEqual(
      ["12917", "4015400612131", "7290013586773"].sort()
    );
  });

  test("xlsx numeric cell preserves full barcode via Math.trunc", () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ["barcode", "name", "price"],
      [7290013586773, "Juice", 5],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const records = xlsxBufferToHeaderRows(buffer);
    expect(records.length).toBe(1);
    const norm = normalizeProductRow(records[0]);
    expect(norm.ok).toBe(true);
    expect(norm.row.barcodes.some((b) => b.barcode === "7290013586773")).toBe(true);
  });

  test("normalizeArabicDigits converts Persian digits", () => {
    expect(normalizeArabicDigits("قنينة: ۷۲۹۰۰۱۳۵۸۶۷۷۳")).toContain("7290013586773");
  });

  test("extractBarcodeEntries extracts labeled multiline unit barcodes", () => {
    const unitText = [
      "قنينة : 7290013586773",
      "قنينة : 7290001594391",
      "قنينة : 7290013586766",
      "قنينة : 7290013586780",
      "قنينة : 7290001594377",
      "قنينة : 7290001594384",
      "قنينة : 7290013586407",
    ].join("\n");
    const entries = extractBarcodeEntries(unitText, null);
    expect(entries.map((e) => e.barcode).sort()).toEqual(
      [
        "7290001594377",
        "7290001594384",
        "7290001594391",
        "7290013586407",
        "7290013586766",
        "7290013586773",
        "7290013586780",
      ].sort()
    );
  });

  test("uniqueBarcodeEntries dedupes by barcode", () => {
    const merged = uniqueBarcodeEntries([
      { barcode: "7290013586773", label: "أساسي" },
      { barcode: "7290013586773", label: "قنينة" },
      { barcode: "12917", label: null },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.map((e) => e.barcode).sort()).toEqual(["12917", "7290013586773"].sort());
  });

  test("parsePrice extracts first numeric value", () => {
    expect(parsePrice("12.5")).toBe(12.5);
    expect(parsePrice("₪ 15")).toBe(15);
  });

  test("valueToText preserves large integer barcodes", () => {
    expect(valueToText(7290013586773)).toBe("7290013586773");
  });

  test("isArabicRetailFormat detects exact customer headers", () => {
    expect(
      isArabicRetailFormat(["الرقم", "الاسم", "باركود", "باركود الوحدات", "مفرق"])
    ).toBe(true);
    expect(isArabicRetailFormat(["barcode", "name", "price"])).toBe(false);
  });

  test("parseArabicRetailMatrix merges primary and unit barcodes (بريجات example)", () => {
    const matrix = [
      ["الرقم", "الاسم", "باركود", "باركود الوحدات", "مفرق"],
      [
        1001,
        "عصير بريجات 500 مل مشكل",
        7290013586773,
        [
          "قنينة : 7290013586773",
          "قنينة : 7290001594391",
          "قنينة : 7290013586766",
          "قنينة : 7290013586780",
          "قنينة : 7290001594377",
          "قنينة : 7290001594384",
          "قنينة : 7290013586407",
        ].join("\n"),
        10.5,
      ],
    ];
    const rows = parseArabicRetailMatrix(matrix);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("عصير بريجات 500 مل مشكل");
    expect(rows[0].barcode).toBe("7290013586773");
    expect(rows[0].price).toBe(10.5);
    const barcodes = rows[0].barcodes.map((b) => b.barcode).sort();
    expect(barcodes).toEqual(
      [
        "7290001594377",
        "7290001594384",
        "7290001594391",
        "7290013586407",
        "7290013586766",
        "7290013586773",
        "7290013586780",
      ].sort()
    );
    expect(rows[0].barcodes.find((b) => b.barcode === "7290013586773")?.is_primary).toBe(true);
  });

  test("classifyHeader maps الرقم to sku not barcode", () => {
    expect(classifyHeader("الرقم")).toBe("sku");
    expect(classifyHeader("#")).toBe("sku");
    expect(classifyHeader("no.")).toBe("sku");
    expect(classifyHeader("barcode")).toBe("barcode");
  });

  test("parseArabicRetailMatrix preserves product number as displayed text", () => {
    const matrix = [
      ["الرقم", "الاسم", "باركود", "باركود الوحدات", "مفرق"],
      ["00042", "منتج", "8693029607095", "", 8],
    ];
    const rows = parseArabicRetailMatrix(matrix);
    expect(rows).toHaveLength(1);
    expect(rows[0]._productNumber).toBe("00042");
    const norm = normalizeProductRow(rows[0]);
    expect(norm.ok).toBe(true);
    expect(norm.row.sku).toBe("00042");
  });

  test("xlsxBufferToHeaderRows preserves الرقم through normalization", () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ["الرقم", "الاسم", "باركود", "باركود الوحدات", "مفرق"],
      ["00099", "عصير", 7290013586773, "قنينة : 7290001594391", 12],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const records = xlsxBufferToHeaderRows(buffer);
    expect(records).toHaveLength(1);
    const norm = normalizeProductRow(records[0]);
    expect(norm.ok).toBe(true);
    expect(norm.row.sku).toBe("00099");
  });

  test("parseArabicRetailMatrix does not scan الرقم as barcode", () => {
    const matrix = [
      ["الرقم", "الاسم", "باركود", "باركود الوحدات", "مفرق"],
      [12345, "منتج", "", "", 5],
    ];
    const rows = parseArabicRetailMatrix(matrix);
    expect(rows).toHaveLength(0);
    const norm = normalizeProductRow({
      _importFormat: "arabic_retail",
      name: "منتج",
      price: 5,
      barcode: "",
      barcodes: [],
      _barcodesExtracted: [],
    });
    expect(norm.ok).toBe(false);
    expect(norm.noBarcode).toBe(true);
  });

  test("parseArabicRetailMatrix extracts short internal codes from unit column", () => {
    const matrix = [
      ["الرقم", "الاسم", "باركود", "باركود الوحدات", "مفرق"],
      [1, "منتج", "8693029607095", "كرتونة : 12917", 8],
    ];
    const rows = parseArabicRetailMatrix(matrix);
    expect(rows[0].barcodes.map((b) => b.barcode).sort()).toEqual(["12917", "8693029607095"].sort());
  });

  test("normalizeProductRow trusts pre-merged arabic_retail barcodes", () => {
    const [row] = parseArabicRetailMatrix([
      ["الرقم", "الاسم", "باركود", "باركود الوحدات", "مفرق"],
      [1, "منتج", "8693029607095", "كرتونة : 12917", 8],
    ]);
    const norm = normalizeProductRow(row);
    expect(norm.ok).toBe(true);
    expect(norm.row._importFormat).toBe("arabic_retail");
    expect(norm.row.barcodes).toHaveLength(2);
    expect(norm.row.barcodes.find((b) => b.barcode === "8693029607095")?.is_primary).toBe(true);
  });

  test("extractBarcodeEntries handles barcode-before-label and concatenated chains", () => {
    const chain =
      "800038004669 : كيس8000380142484 8000380192588 8000380004676 8000380004669";
    const entries = uniqueBarcodeEntries(extractBarcodeEntries(chain, null));
    expect(entries.map((e) => e.barcode).sort()).toEqual(
      ["800038004669", "8000380142484", "8000380192588", "8000380004676", "8000380004669"].sort()
    );
    expect(entries.find((e) => e.barcode === "800038004669")?.label).toBeNull();
  });

  test("extractBarcodeEntries handles repeated barcode-unit chains via digit fallback", () => {
    const text =
      "612008398 : كيس8681612008350 : كيس8681612008411 : كيس8681612008367 : كيس8681612008404 : كيس";
    const barcodes = uniqueBarcodeEntries(extractBarcodeEntries(text, null)).map((e) => e.barcode);
    expect(barcodes.sort()).toEqual(
      ["612008398", "8681612008350", "8681612008411", "8681612008367", "8681612008404"].sort()
    );
  });

  test("xlsxBufferToHeaderRows uses Arabic retail path for customer layout", () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ["الرقم", "الاسم", "باركود", "باركود الوحدات", "مفرق"],
      [99, "عصير", 7290013586773, "قنينة : 7290001594391\nكرتونة : 12917", 12],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const records = xlsxBufferToHeaderRows(buffer);
    expect(records).toHaveLength(1);
    expect(records[0]._importFormat).toBe("arabic_retail");
    const norm = normalizeProductRow(records[0]);
    expect(norm.ok).toBe(true);
    expect(norm.row.barcodes.map((b) => b.barcode).sort()).toEqual(
      ["12917", "7290001594391", "7290013586773"].sort()
    );
    expect(norm.row.barcodes.find((b) => b.barcode === "7290013586773")?.is_primary).toBe(true);
  });
});
