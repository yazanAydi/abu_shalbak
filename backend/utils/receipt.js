import { getStoreLogoDataUri, STORE_NAME_AR, STORE_PHONE } from "./storeBranding.js";

const LINE = 48;

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function padCenter(s, w) {
  const str = String(s);
  if (str.length >= w) return str.slice(0, w);
  const left = Math.floor((w - str.length) / 2);
  return " ".repeat(left) + str + " ".repeat(w - str.length - left);
}

function padRight(s, w) {
  const str = String(s);
  return str.length >= w ? str.slice(0, w) : str + " ".repeat(w - str.length);
}

function padLeft(s, w) {
  const str = String(s);
  return str.length >= w ? str.slice(-w) : " ".repeat(w - str.length) + str;
}

function ils(n) {
  return `\u20AA${Number(n).toFixed(2)}`;
}

function formatReceiptQty(L) {
  if (L.weighed) return Number(L.quantity).toFixed(3);
  return String(L.quantity);
}

function formatReceiptPrice(L) {
  if (L.weighed) return `${L.price.toFixed(2)}/kg`;
  return L.price.toFixed(2);
}

function round2Money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function methodLabel(method) {
  if (method === "cash") return "نقدي";
  if (method === "visa") return "فيزا";
  if (method === "on_account") return "ذمة";
  return String(method || "");
}

function isBaseCurrencyLine(p) {
  const code = p.currency_code ? String(p.currency_code).toUpperCase() : null;
  const rate = Number(p.exchange_rate_used ?? 1);
  return (!code || code === "NIS") && Math.abs(rate - 1) < 1e-9;
}

function foreignAmount(p) {
  const sym = p.symbol || "";
  const original = Number(p.original_amount ?? p.amount) || 0;
  return `${sym}${original.toFixed(2)}`;
}

function buildPaymentSection(opts) {
  const total = Number(opts.total) || 0;
  const payments = Array.isArray(opts.payments) ? opts.payments : null;

  if (payments && payments.length > 0) {
    const lines = ["طريقة الدفع:"];

    for (const p of payments) {
      const label = methodLabel(p.method);
      const nis = Number(p.nis_equivalent ?? p.amount) || 0;
      if (isBaseCurrencyLine(p)) {
        lines.push(`${label}: ${ils(nis)}`);
      } else {
        const code = String(p.currency_code || "").toUpperCase();
        const rate = Number(p.exchange_rate_used ?? 1);
        lines.push(`${label} (${code}): ${foreignAmount(p)}`);
        lines.push(`  سعر الصرف: 1 ${code} = ${ils(rate)}`);
        lines.push(`  المعادل: ${ils(nis)}`);
      }
    }

    const paidSum = payments.reduce((s, p) => s + (Number(p.nis_equivalent ?? p.amount) || 0), 0);
    lines.push(`المجموع المدفوع: ${ils(paidSum)}`);

    let change = 0;
    const changeFromNis =
      opts.changeNis != null && Number.isFinite(Number(opts.changeNis))
        ? round2Money(Number(opts.changeNis))
        : 0;
    if (changeFromNis > 0.005) {
      change = changeFromNis;
    } else if (opts.cashTendered != null && Number.isFinite(Number(opts.cashTendered))) {
      const cashApplied = payments
        .filter((p) => p.method === "cash")
        .reduce((s, p) => s + (Number(p.nis_equivalent ?? p.amount) || 0), 0);
      change = Math.max(0, round2Money(Number(opts.cashTendered) - cashApplied));
    }
    lines.push(`الباقي: ${ils(change)}`);
    return lines;
  }

  const payLabel =
    opts.paymentMethod === "cash"
      ? "نقد"
      : opts.paymentMethod === "visa"
        ? "بطاقة"
        : opts.paymentMethod === "on_account"
          ? "ذمة"
          : opts.paymentMethod === "mixed"
            ? "مختلط"
            : String(opts.paymentMethod || "");

  if (opts.paymentMethod === "cash" && opts.cashTendered != null) {
    const cashApplied = total;
    const change = Math.max(
      0,
      Math.round((Number(opts.cashTendered) - cashApplied) * 100) / 100
    );
    return [
      "طريقة الدفع:",
      `نقدي: ${ils(cashApplied)}`,
      `المجموع المدفوع: ${ils(Number(opts.cashTendered))}`,
      `الباقي: ${ils(change)}`,
    ];
  }

  return [`الدفع: ${payLabel}`];
}

const RECEIPT_HTML_CSS = `
  body { margin: 0; padding: 12px; background: #fff; color: #000; font-family: "Segoe UI", Tahoma, Arial, sans-serif; font-size: 12px; }
  .receipt { max-width: 384px; margin: 0 auto; }
  .logo-wrap { text-align: center; margin-bottom: 8px; }
  .logo-wrap img { max-width: 180px; max-height: 100px; object-fit: contain; }
  .center { text-align: center; }
  .sep { border: none; border-top: 2px solid #000; margin: 8px 0; }
  .sep-thin { border: none; border-top: 1px solid #000; margin: 6px 0; }
  .meta { margin: 2px 0; }
  table.items { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.items th, table.items td { padding: 4px 3px; vertical-align: top; }
  table.items th { font-weight: 700; border-bottom: 1px solid #000; }
  table.items .col-name { width: 46%; text-align: right; word-break: break-word; }
  table.items .col-num { width: 18%; text-align: center; direction: ltr; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .totals { width: 100%; margin-top: 4px; }
  .totals td { padding: 2px 0; }
  .totals .label { text-align: right; }
  .totals .amount { text-align: left; direction: ltr; font-variant-numeric: tabular-nums; white-space: nowrap; width: 5em; }
  .payment { margin-top: 6px; }
  .payment div { margin: 2px 0; }
  .thanks { text-align: center; margin: 8px 0; font-weight: 600; }
`;

/**
 * @param {object} opts same shape as buildReceiptText
 */
export function buildReceiptHtml(opts) {
  const settings = opts.settings || {};
  const showTax = settings.receipt_show_tax !== false;
  const showCashier = settings.receipt_show_cashier !== false;
  const paymentLines = buildPaymentSection(opts);

  const logoSrc = getStoreLogoDataUri();
  const logoHtml = logoSrc
    ? `<div class="logo-wrap"><img src="${logoSrc}" alt="" /></div>`
    : "";

  const itemRows = (opts.lines || [])
    .map((L) => {
      const name = L.name.length > 40 ? `${L.name.slice(0, 37)}...` : L.name;
      return `<tr>
        <td class="col-name">${escapeHtml(name)}</td>
        <td class="col-num">${escapeHtml(formatReceiptQty(L))}</td>
        <td class="col-num">${escapeHtml(formatReceiptPrice(L))}</td>
        <td class="col-num">${escapeHtml(Number(L.lineTotal).toFixed(2))}</td>
      </tr>`;
    })
    .join("");

  const taxRow =
    showTax && opts.tax > 0
      ? `<tr><td class="label">ضريبة القيمة المضافة:</td><td class="amount">${escapeHtml(Number(opts.tax).toFixed(2))}</td></tr>`
      : "";

  const paymentHtml = paymentLines.map((line) => `<div>${escapeHtml(line)}</div>`).join("");

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>إيصال</title>
  <style>${RECEIPT_HTML_CSS}</style>
</head>
<body>
  <div class="receipt">
    ${logoHtml}
    <div class="center"><strong>${escapeHtml(STORE_NAME_AR)}</strong></div>
    <div class="center">${escapeHtml(STORE_PHONE)}</div>
    <div class="center">إيصال بيع</div>
    <hr class="sep" />
    <div class="meta">التاريخ: ${escapeHtml(opts.timestamp)}</div>
    ${showCashier && opts.cashierName ? `<div class="meta">الكاشير: ${escapeHtml(opts.cashierName)}</div>` : ""}
    <div class="meta">رقم الإيصال: ${escapeHtml(opts.transactionId)}</div>
    <table class="items">
      <thead>
        <tr>
          <th class="col-name">الصنف</th>
          <th class="col-num">الكمية</th>
          <th class="col-num">السعر</th>
          <th class="col-num">المجموع</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>
    <hr class="sep-thin" />
    <table class="totals">
      <tr><td class="label">المجموع الفرعي:</td><td class="amount">${escapeHtml(Number(opts.subtotal).toFixed(2))}</td></tr>
      ${taxRow}
      <tr><td class="label"><strong>الإجمالي:</strong></td><td class="amount"><strong>${escapeHtml(Number(opts.total).toFixed(2))}</strong></td></tr>
    </table>
    <hr class="sep" />
    <div class="payment">${paymentHtml}</div>
    <hr class="sep" />
    <div class="thanks">شكراً لزيارتكم</div>
    <hr class="sep" />
  </div>
</body>
</html>`;
}

/**
 * @param {object} opts
 */
export function buildReceiptText(opts) {
  const settings = opts.settings || {};
  const showTax = settings.receipt_show_tax !== false;
  const showCashier = settings.receipt_show_cashier !== false;

  const sep = "═".repeat(LINE);
  const thin = "─".repeat(LINE);
  const paymentLines = buildPaymentSection(opts);

  const lines = [
    sep,
    padCenter(STORE_NAME_AR, LINE),
    padCenter(STORE_PHONE, LINE),
    padCenter("إيصال بيع", LINE),
    sep,
    `التاريخ: ${opts.timestamp}`,
  ];

  if (showCashier && opts.cashierName) {
    lines.push(`الكاشير: ${opts.cashierName}`);
  }
  lines.push(`رقم الإيصال: ${opts.transactionId}`, "");
  lines.push(
    `${padRight("الصنف", 22)}${padLeft("الكمية", 5)} ${padLeft("السعر", 8)} ${padLeft("المجموع", 10)}`,
    thin
  );

  for (const L of opts.lines) {
    const name = L.name.length > 20 ? L.name.slice(0, 17) + "..." : L.name;
    lines.push(
      `${padRight(name, 22)}${padLeft(formatReceiptQty(L), 5)} ${padLeft(formatReceiptPrice(L), 8)} ${padLeft(L.lineTotal.toFixed(2), 10)}`
    );
  }

  lines.push(thin);
  lines.push(`${padRight("المجموع الفرعي:", 34)}${padLeft(opts.subtotal.toFixed(2), 10)}`);

  if (showTax && opts.tax > 0) {
    lines.push(`${padRight("ضريبة القيمة المضافة:", 34)}${padLeft(opts.tax.toFixed(2), 10)}`);
  }

  lines.push(
    thin,
    `${padRight("الإجمالي:", 34)}${padLeft(opts.total.toFixed(2), 10)}`,
    sep,
    ...paymentLines,
    sep,
    padRight("شكراً لزيارتكم", LINE),
    sep
  );

  return lines.join("\n");
}

/** @param {object} opts */
export function buildReceiptPayload(opts) {
  return {
    receipt_text: buildReceiptText(opts),
    receipt_html: buildReceiptHtml(opts),
  };
}

export { methodLabel, ils as receiptIls };
