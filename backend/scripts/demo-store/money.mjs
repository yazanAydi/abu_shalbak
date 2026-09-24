/**
 * Independent money/qty comparison for the demo store.
 * Integer minor units only. Does not import backend/utils/money.js.
 *
 * Shekels use 2 decimal places (agorot). Quantities use 3 decimal places
 * (grams / milli-units), which covers piece counts and weighed kilograms.
 */

export function moneyMinor(value) {
  if (typeof value === "string") {
    const text = value.trim();
    const neg = text.startsWith("-");
    const body = neg ? text.slice(1) : text;
    if (!/^\d+(\.\d{1,2})?$/.test(body)) {
      throw new Error(`money string is not 2dp: ${value}`);
    }
    const [whole, frac = ""] = body.split(".");
    const minor = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
    return neg ? -minor : minor;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`money is not finite: ${value}`);
  const scaled = n * 100;
  const nearest = Math.round(scaled);
  if (Math.abs(scaled - nearest) > 1e-4) {
    throw new Error(`money is not an exact 2dp value: ${value}`);
  }
  return nearest;
}

export function formatMoney(minor) {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export function qtyMilli(value) {
  if (typeof value === "string") {
    const text = value.trim();
    const neg = text.startsWith("-");
    const body = neg ? text.slice(1) : text;
    if (!/^\d+(\.\d{1,3})?$/.test(body)) {
      throw new Error(`quantity string is not 3dp: ${value}`);
    }
    const [whole, frac = ""] = body.split(".");
    const milli = Number(whole) * 1000 + Number((frac + "000").slice(0, 3));
    return neg ? -milli : milli;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`quantity is not finite: ${value}`);
  const scaled = n * 1000;
  const nearest = Math.round(scaled);
  if (Math.abs(scaled - nearest) > 1e-4) {
    throw new Error(`quantity is not an exact 3dp value: ${value}`);
  }
  return nearest;
}

export function formatQty(milli) {
  const neg = milli < 0;
  const abs = Math.abs(milli);
  const whole = Math.trunc(abs / 1000);
  const frac = String(abs % 1000).padStart(3, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export function sumMinor(values) {
  return values.reduce((s, v) => s + moneyMinor(v), 0);
}

export function compareMoney(expected, actual) {
  const e = moneyMinor(expected);
  const a = moneyMinor(actual);
  return {
    ok: e === a,
    expected: formatMoney(e),
    actual: formatMoney(a),
    diff: formatMoney(a - e),
  };
}

export function compareQty(expected, actual) {
  const e = qtyMilli(expected);
  const a = qtyMilli(actual);
  return {
    ok: e === a,
    expected: formatQty(e),
    actual: formatQty(a),
    diff: formatQty(a - e),
  };
}
