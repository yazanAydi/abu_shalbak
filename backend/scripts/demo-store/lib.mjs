import fs from "fs";
import request from "supertest";
import { compareMoney, compareQty, formatMoney, moneyMinor, sumMinor } from "./money.mjs";

export function loadExpected(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function checkBooks(expected) {
  const books = expected.books;
  const groups = [
    ["dairy", books.dairy],
    ["produce", books.produce],
    ["bakerySupplier", books.bakerySupplier],
    ["vatSupplier", books.vatSupplier],
    ["officeSupplier", books.officeSupplier],
    ["ahmad", books.ahmad],
  ];
  for (const [name, book] of groups) {
    const got = formatMoney(sumMinor(book.moves));
    if (got !== book.balance) {
      throw new Error(`Fixture ${name} sums to ${got}, file says ${book.balance}`);
    }
  }
  const suppliers = formatMoney(
    sumMinor([
      books.dairy.balance,
      books.produce.balance,
      books.bakerySupplier.balance,
      books.vatSupplier.balance,
      books.officeSupplier.balance,
    ])
  );
  if (suppliers !== books.suppliersTotal) {
    throw new Error(`Fixture supplier total ${suppliers} != ${books.suppliersTotal}`);
  }
  for (const key of ["cashier1Cash", "cashier2Cash", "edgeCash"]) {
    const book = books[key];
    const got = formatMoney(
      moneyMinor(book.opening) + sumMinor(book.in) - sumMinor(book.out)
    );
    if (got !== book.expected) throw new Error(`Fixture ${key} is ${got}, file says ${book.expected}`);
  }
  const pos = books.posDay;
  if (formatMoney(sumMinor(pos.charged)) !== pos.gross) throw new Error("Fixture POS gross");
  if (formatMoney(sumMinor(pos.refunds)) !== pos.refundTotal) throw new Error("Fixture refunds");
  if (formatMoney(moneyMinor(pos.gross) - moneyMinor(pos.refundTotal)) !== pos.net) {
    throw new Error("Fixture POS net");
  }
  if (formatMoney(sumMinor(pos.discounts)) !== pos.discountTotal) throw new Error("Fixture discounts");
  if (formatMoney(sumMinor(pos.saleCogs)) !== pos.saleCogsTotal) throw new Error("Fixture sale COGS");
  if (formatMoney(sumMinor(pos.refundCogs)) !== pos.refundCogsTotal) throw new Error("Fixture refund COGS");
  if (formatMoney(moneyMinor(pos.saleCogsTotal) - moneyMinor(pos.refundCogsTotal)) !== pos.netCogs) {
    throw new Error("Fixture net COGS");
  }
  if (formatMoney(moneyMinor(pos.net) - moneyMinor(pos.netCogs)) !== pos.grossProfit) {
    throw new Error("Fixture gross profit");
  }
  if (formatMoney(sumMinor(books.opex.moves)) !== books.opex.total) throw new Error("Fixture expenses");
  if (formatMoney(moneyMinor(pos.grossProfit) - moneyMinor(books.opex.total)) !== books.operatingProfit) {
    throw new Error("Fixture operating profit");
  }
  const pay = formatMoney(
    sumMinor([pos.cashPayments, pos.visaPayments, pos.onAccountPayments].map((v) => v))
  );
  if (pay !== pos.gross) throw new Error(`Fixture tender ${pay} != gross ${pos.gross}`);
}

export function unwrap(body) {
  if (body && typeof body === "object" && body.success === true && "data" in body) return body.data;
  return body;
}

export function asList(body) {
  const data = unwrap(body);
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const key of ["rows", "items", "units", "warehouses", "products", "lines"]) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

export function snippet(body) {
  const text = JSON.stringify(body);
  return text.length > 700 ? `${text.slice(0, 700)}…` : text;
}

export async function call(app, { method = "get", path, token, body, query }) {
  let req = request(app)[method](path);
  if (token) req = req.set("Authorization", `Bearer ${token}`);
  if (query) req = req.query(query);
  if (body !== undefined) req = req.send(body);
  return req;
}

export function httpFail(res, label) {
  const error = new Error(`${label} → HTTP ${res.status} ${snippet(res.body)}`);
  error.classification = res.status >= 500 ? "application" : "test_infrastructure";
  error.statusCode = res.status;
  return error;
}

export function pushResult(results, row) {
  const entry = {
    status: "FAIL",
    expected: "",
    actual: "",
    diff: "",
    detail: "",
    classification: "",
    screen: "",
    repro: "npm run demo:simulate -- --reset",
    feature: "",
    ...row,
  };
  if (!entry.detail) {
    entry.detail = `${entry.scenario}: expected ${entry.expected}; actual ${entry.actual}${
      entry.diff ? ` → diff ${entry.diff}` : ""
    }`;
  }
  results.push(entry);
  console.log(`${entry.status}  ${entry.detail}`);
  return entry.status === "PASS";
}

export function checkMoney(results, scenario, expected, actual, extra = {}) {
  try {
    const cmp = compareMoney(expected, actual);
    return pushResult(results, {
      scenario,
      status: cmp.ok ? "PASS" : "FAIL",
      expected: cmp.expected,
      actual: cmp.actual,
      diff: cmp.diff,
      classification: cmp.ok ? "" : extra.classification || "application",
      ...extra,
    });
  } catch (error) {
    return pushResult(results, {
      scenario,
      status: "FAIL",
      expected: String(expected),
      actual: String(actual),
      detail: error.message,
      classification: "test_infrastructure",
      ...extra,
    });
  }
}

export function checkQty(results, scenario, expected, actual, extra = {}) {
  try {
    const cmp = compareQty(expected, actual);
    return pushResult(results, {
      scenario,
      status: cmp.ok ? "PASS" : "FAIL",
      expected: cmp.expected,
      actual: cmp.actual,
      diff: cmp.diff,
      classification: cmp.ok ? "" : extra.classification || "application",
      ...extra,
    });
  } catch (error) {
    return pushResult(results, {
      scenario,
      status: "FAIL",
      expected: String(expected),
      actual: String(actual),
      detail: error.message,
      classification: "test_infrastructure",
      ...extra,
    });
  }
}

export function num(value) {
  return Number(value);
}
