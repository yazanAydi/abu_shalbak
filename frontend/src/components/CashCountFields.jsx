import { FormField, Input } from "./ui";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

export function formatCurrencyAmount(symbol, amount) {
  return `${symbol || "\u20AA"}${Number(amount || 0).toFixed(2)}`;
}

export function expectedBreakdownText(expectedByCurrency) {
  const parts = (expectedByCurrency || []).filter((c) => Number(c.original) !== 0);
  if (parts.length === 0) return null;
  return parts.map((c) => formatCurrencyAmount(c.symbol, c.original)).join(" + ");
}

export function buildCountCurrencyRows(currencies, expectedByCurrency) {
  const expectedMap = new Map((expectedByCurrency || []).map((c) => [String(c.code).toUpperCase(), c]));
  const rows = [];
  const seen = new Set();
  for (const c of currencies || []) {
    const code = String(c.code).toUpperCase();
    seen.add(code);
    const exp = expectedMap.get(code);
    rows.push({
      currency_id: c.id,
      code: c.code,
      name: c.name,
      symbol: c.symbol,
      rate: Number(c.exchange_rate_to_nis) || 1,
      is_base: !!c.is_base,
      expected_original: exp ? Number(exp.original) || 0 : 0,
    });
  }
  for (const exp of expectedByCurrency || []) {
    const code = String(exp.code).toUpperCase();
    if (seen.has(code)) continue;
    rows.push({
      currency_id: exp.currency_id,
      code: exp.code,
      name: exp.name,
      symbol: exp.symbol,
      rate: Number(exp.rate) || 1,
      is_base: !!exp.is_base,
      expected_original: Number(exp.original) || 0,
    });
  }
  return rows;
}

export function countedNisTotal(countRows, values) {
  return round2(
    countRows.reduce((sum, row) => {
      const raw = values[row.code];
      if (raw === "" || raw == null) return sum;
      const amt = Number(String(raw).replace(",", "."));
      if (!Number.isFinite(amt) || amt < 0) return sum;
      return round2(sum + round2(amt * (Number(row.rate) || 1)));
    }, 0)
  );
}

export function countedCurrenciesPayload(countRows, values) {
  return countRows.map((row) => {
    const raw = values[row.code];
    const amt = raw === "" || raw == null ? 0 : Number(String(raw).replace(",", "."));
    return {
      currency_id: row.currency_id,
      currency_code: row.code,
      amount: Number.isFinite(amt) && amt > 0 ? round2(amt) : 0,
    };
  });
}

export default function CashCountFields({ countRows, values, onChange }) {
  if (!countRows.length) return null;
  return (
    <>
      <p style={{ color: "var(--office-text-muted)", lineHeight: 1.6, marginBottom: "0.75rem" }}>
        عدّ كل عملة كما هي في الدرج. الدولار يُحوَّل تلقائياً بسعر المتجر.
      </p>
      {countRows.map((row) => {
        const raw = values[row.code] ?? "";
        const amt = raw === "" ? null : Number(String(raw).replace(",", "."));
        const nis =
          amt != null && Number.isFinite(amt) && amt >= 0 ? round2(amt * (Number(row.rate) || 1)) : null;
        return (
          <FormField
            key={row.code}
            label={`${row.name} (${row.symbol})`}
            hint={`المتوقع: ${formatCurrencyAmount(row.symbol, row.expected_original)}${
              !row.is_base ? ` — سعر الصرف ${Number(row.rate).toFixed(4)}` : ""
            }`}
          >
            <Input
              type="number"
              min="0"
              step="0.01"
              value={raw}
              onChange={(e) => onChange(row.code, e.target.value)}
              placeholder="0.00"
            />
            {nis != null ? (
              <div style={{ marginTop: "0.35rem", fontSize: "0.85rem", color: "var(--office-text-muted)" }}>
                بالشيكل: {ils(nis)}
              </div>
            ) : null}
          </FormField>
        );
      })}
    </>
  );
}
