import { newInvoiceLineKey } from "./invoiceLineEntry";

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function countProductId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Empty means the batch date was not entered. Never substitute today. */
export function interpretCountExpiry(value) {
  if (value == null) return { ok: true, date: "" };
  const text = String(value).trim();
  if (!text) return { ok: true, date: "" };
  const ymd = text.slice(0, 10);
  if (!YMD_RE.test(ymd)) return { ok: false, date: "" };
  const [year, month, day] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return { ok: false, date: "" };
  }
  return { ok: true, date: ymd };
}

/** Explicit zero is counted. A blank field is not. */
export function countQtyEntered(value) {
  if (value == null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  const qty = Number(value);
  return Number.isFinite(qty) && qty >= 0;
}

export function countQtyInputValue(value) {
  if (value === 0 || value === "0") return "0";
  if (value == null || value === "") return "";
  const qty = Number(value);
  if (!Number.isFinite(qty)) return "";
  return String(value);
}

/** Blank expiry and a dated expiry are different identities. */
export function countRowIdentity(row) {
  const parsed = interpretCountExpiry(row?.expiry_date);
  if (!parsed.ok || !parsed.date) return "blank";
  return `dated:${parsed.date}`;
}

export function sourceIdentity(source) {
  if (source?.batch_source === "dated") {
    const parsed = interpretCountExpiry(source.expiry_date);
    if (parsed.ok && parsed.date) return `dated:${parsed.date}`;
  }
  return "blank";
}

export function emptyCountLine() {
  return {
    line_key: newInvoiceLineKey(),
    product_id: null,
    name: "",
    barcode: "",
    counted_qty: "",
    expiry_date: "",
    expiry_invalid: false,
    expiry_touched: false,
    expiry_picture_loaded: false,
    known_expiries: [],
    product_expiry: "",
    picture_request: 0,
  };
}

export function editorRowFromCountLine(line) {
  const dated = line?.batch_source === "dated";
  const parsed = interpretCountExpiry(dated ? line?.expiry_date : "");
  return {
    line_key: newInvoiceLineKey(),
    product_id: countProductId(line?.product_id),
    name: line?.name || "",
    barcode: line?.barcode || "",
    counted_qty: countQtyInputValue(line?.counted_qty),
    expiry_date: parsed.ok ? parsed.date : "",
    expiry_invalid: false,
    expiry_touched: true,
    expiry_picture_loaded: false,
    known_expiries: [],
    product_expiry: "",
    picture_request: 0,
  };
}

export function validateCountLine(row) {
  if (!countProductId(row?.product_id)) {
    return { field: "product", message: "اختر الصنف أولاً" };
  }
  if (row?.expiry_invalid) {
    return { field: "expiry", message: "تاريخ الصلاحية غير صالح" };
  }
  const expiry = interpretCountExpiry(row?.expiry_date);
  if (!expiry.ok) {
    return { field: "expiry", message: "تاريخ الصلاحية غير صالح" };
  }
  if (!countQtyEntered(row?.counted_qty)) {
    return {
      field: "qty",
      message: "أدخل الكمية المعدودة. الصفر كمية معدودة، والخانة الفارغة لم تُجرَد",
    };
  }
  return null;
}

function rowTouched(row) {
  if (countProductId(row?.product_id)) return true;
  if (row?.expiry_invalid) return true;
  if (countQtyEntered(row?.counted_qty)) return true;
  return String(row?.expiry_date || "").trim() !== "";
}

export function countLinePayload(row, picture, { groupHasDated = false } = {}) {
  const qty = Number(row.counted_qty);
  const expiry = interpretCountExpiry(row?.expiry_date);
  const date = expiry.ok ? expiry.date : "";
  if (date) return { batch_source: "dated", expiry_date: date, counted_qty: qty };
  if (picture?.has_dated_batches || groupHasDated) {
    return { batch_source: "undated", expiry_date: null, counted_qty: qty };
  }
  return { batch_source: null, expiry_date: null, counted_qty: qty };
}

export function countLinesPayload(list, picture) {
  const groupHasDated = (list || []).some((row) => countRowIdentity(row) !== "blank");
  return (list || []).map((row) => countLinePayload(row, picture, { groupHasDated }));
}

export function recordedCountExpiries(picture) {
  const dates = [];
  const seen = new Set();
  for (const source of picture?.sources || []) {
    if (source?.batch_source !== "dated") continue;
    const parsed = interpretCountExpiry(source.expiry_date);
    if (!parsed.ok || !parsed.date || seen.has(parsed.date)) continue;
    seen.add(parsed.date);
    dates.push(parsed.date);
  }
  return dates;
}

export function recordedProductExpiry(picture) {
  const parsed = interpretCountExpiry(picture?.product_expiry_date);
  return parsed.ok ? parsed.date : "";
}

/** Attach recorded dates without changing an expiry the user already entered. */
export function attachCountExpiryPicture(row, picture) {
  return {
    ...row,
    known_expiries: recordedCountExpiries(picture),
    product_expiry: recordedProductExpiry(picture),
    expiry_picture_loaded: true,
  };
}

/**
 * Prefill only when this row has no date yet and the product has exactly one
 * dated batch that is not already used on another row.
 */
export function seedCountExpiry(row, picture, siblings = []) {
  const next = attachCountExpiryPicture(row, picture);
  const manual = row?.expiry_touched || String(row?.expiry_date || "").trim() !== "";
  if (manual) return next;
  const known = next.known_expiries;
  if (known.length !== 1) return next;
  const used = (siblings || []).some((other) => (
    other !== row
    && String(other.line_key) !== String(row.line_key)
    && Number(other.product_id) === Number(row.product_id)
    && String(other.expiry_date || "") === known[0]
  ));
  if (used) return next;
  return { ...next, expiry_date: known[0] };
}

export function groupCountRows(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const id = countProductId(row?.product_id);
    if (!id) continue;
    const list = groups.get(id) || [];
    list.push(row);
    groups.set(id, list);
  }
  return groups;
}

/**
 * Local row rules, then batch identity when source pictures are supplied.
 * Does not invent zero lines for sources the user left out.
 */
export function validateCountDraft(rows, picturesByProductId = null) {
  const groups = new Map();
  for (const row of rows || []) {
    if (!rowTouched(row)) continue;
    const issue = validateCountLine(row);
    if (issue) return { ...issue, line_key: row.line_key, name: row.name || "" };
    const id = countProductId(row.product_id);
    const list = groups.get(id) || [];
    list.push(row);
    groups.set(id, list);
  }

  for (const [productId, list] of groups) {
    const seen = new Set();
    for (const row of list) {
      const key = countRowIdentity(row);
      if (seen.has(key)) {
        return {
          line_key: row.line_key,
          field: "expiry",
          message: "سطر مكرر لنفس الصنف وتاريخ الصلاحية. لن يُحسب الجرد مرتين",
          name: row.name || "",
        };
      }
      seen.add(key);
    }

    if (!picturesByProductId) continue;
    const picture = picturesByProductId[productId];
    if (!picture) continue;
    for (const row of list) {
      const expiry = interpretCountExpiry(row?.expiry_date);
      if (!expiry.ok) {
        return {
          line_key: row.line_key,
          field: "expiry",
          message: "تاريخ الصلاحية غير صالح",
          name: row.name || "",
        };
      }
    }
  }
  return null;
}

export function missingCountSources(picture, rows) {
  const seen = new Set((rows || []).map((row) => countRowIdentity(row)));
  const anyDated = (rows || []).some((row) => countRowIdentity(row) !== "blank");
  if (!picture?.has_dated_batches) {
    if (!anyDated) return [];
    const undatedQty = Number(picture.product_stock);
    if (!Number.isFinite(undatedQty) || Math.abs(undatedQty) <= 1e-9) return [];
    if (seen.has("blank")) return [];
    return [{ batch_source: "undated", expiry_date: null, quantity: undatedQty }];
  }
  return (picture.sources || []).filter((source) => !seen.has(sourceIdentity(source)));
}

export function firstIncompleteCount(rows, picturesByProductId) {
  for (const [productId, list] of groupCountRows(rows)) {
    const missing = missingCountSources(picturesByProductId?.[productId], list);
    if (missing.length) {
      return {
        productId,
        name: list[0]?.name || "",
        missing,
        message: `الجرد غير مكتمل للصنف ${list[0]?.name || ""}. سجّل كمية لكل دفعة وللمخزون غير المحدد، بما فيها الصفر.`,
      };
    }
  }
  return null;
}

export function removedProductIds(loadedIds, rows) {
  const current = new Set(groupCountRows(rows).keys());
  const removed = [];
  for (const id of loadedIds || []) {
    const norm = countProductId(id);
    if (norm && !current.has(norm)) removed.push(norm);
  }
  return removed;
}

/** Inventory department of a count document. Sale place is not a department. */
export function countDocumentDepartment(scope, membership) {
  if (membership === "bakery" || scope === "bakery") return "bakery";
  return "retail";
}

export function countScopeParams(scope, membership) {
  const department = countDocumentDepartment(scope, membership);
  if (department === "bakery") return { department, scope: "bakery" };
  return { department, scope: scope || "retail" };
}
