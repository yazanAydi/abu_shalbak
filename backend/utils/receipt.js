import { getStoreLogoDataUri, resolvePrintBranding, STORE_NAME_AR, STORE_PHONE } from "./storeBranding.js";
import { formatProductSku } from "./entityCodes.js";
import { round2, roundScaleSaleTotal } from "./money.js";

const LINE = 48;

/**
 * Reprint line totals from stored sale rows. Prefer transaction_items.line_gross;
 * if missing, round KG lines to whole shekels and leave others at round2(qty × price).
 * @param {object[]} itemsJson
 * @param {object[]} [storedItems]
 */
export function mapSaleItemsToReceiptLines(itemsJson, storedItems = []) {
  const items = Array.isArray(itemsJson) ? itemsJson : [];
  const stored = Array.isArray(storedItems) ? storedItems : [];
  return items.map((it, i) => {
    const row = stored[i];
    const qty = Number(it.quantity) || 0;
    const price = Number(it.price) || 0;
    const unitName = it.unit_name || row?.unit_name || "";
    let lineTotal;
    if (row?.line_gross != null && Number.isFinite(Number(row.line_gross))) {
      lineTotal = round2(Number(row.line_gross));
    } else {
      const raw = round2(qty * price);
      lineTotal = unitName === "كغم" ? roundScaleSaleTotal(raw) : raw;
    }
    return {
      name: it.name || `صنف ${it.product_id}`,
      sku: formatProductSku(it.sku ?? row?.sku ?? row?.product_sku),
      quantity: qty,
      price,
      lineTotal,
      weighed: unitName === "كغم",
    };
  });
}

export function receiptSkuLabel(sku) {
  return formatProductSku(sku) || "—";
}

/** transaction_items plus live رقم المنتج for reprints. */
export const RECEIPT_STORED_ITEMS_SQL = `
  SELECT ti.line_gross, ti.unit_name, ti.quantity, ti.unit_price, p.sku
  FROM transaction_items ti
  LEFT JOIN products p ON p.id = ti.product_id
  WHERE ti.transaction_id = ?
  ORDER BY ti.id
`;

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function brandingFromSettings(settings) {
  const name = String(settings?.store_name_ar || settings?.store_name || "").trim();
  const phone = String(settings?.store_phone || "").trim();
  return {
    name: name || STORE_NAME_AR,
    phone: phone || STORE_PHONE,
  };
}

function invoiceNumber(opts) {
  const n = String(opts?.receiptNumber || opts?.receipt_number || "").trim();
  if (n) return n;
  return String(opts?.transactionId ?? "");
}

function soldToLabel(opts) {
  if (opts?.paymentMethod === "on_account") {
    const name = String(opts.customerName || opts.customer_name || "").trim();
    return name || "ذمة";
  }
  if (opts?.paymentMethod === "cash") return "نقدي";
  if (opts?.paymentMethod === "visa") return "فيزا";
  if (opts?.paymentMethod === "mixed") return "مختلط";
  return methodLabel(opts?.paymentMethod) || "نقدي";
}

function splitTimestamp(ts) {
  const raw = String(ts || "").trim();
  const [datePart, ...rest] = raw.split(/\s+/);
  return { date: datePart || raw, time: rest.join(" ") || "" };
}

function formatQtySum(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const sum = list.reduce((s, L) => s + (Number(L.quantity) || 0), 0);
  if (list.some((L) => L.weighed)) return sum.toFixed(3);
  if (Number.isInteger(sum)) return String(sum);
  return String(sum);
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

function partyBalanceFromOpts(opts) {
  return opts?.partyBalance || opts?.party_balance || null;
}

function buildPartyBalanceLines(opts) {
  const pb = partyBalanceFromOpts(opts);
  if (!pb?.before_display || !pb?.after_display) return [];
  return [`الرصيد قبل: ${pb.before_display}`, `الرصيد بعد: ${pb.after_display}`];
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

/** Thermal roll width. Chromium print-to-pdf needs an explicit height, not `auto`. */
const RECEIPT_HEIGHT_MIN_MM = 70;
const RECEIPT_HEIGHT_MAX_MM = 400;

/** @returns {80 | 58} */
export function getReceiptPageWidthMm(env = process.env) {
  return Number(env.RECEIPT_WIDTH_MM) === 58 ? 58 : 80;
}

/** Extra millimetres below شكراً لزيارتكم on the printed PDF. */
export function getReceiptBottomMarginMm(env = process.env) {
  const n = Number(env.RECEIPT_BOTTOM_MARGIN_MM);
  if (Number.isFinite(n) && n >= 0 && n <= 30) return n;
  return 5;
}

/** Horizontal inset on each side of the 80mm (or 58mm) page. */
export function getReceiptSideMarginMm(env = process.env) {
  const n = Number(env.RECEIPT_SIDE_MARGIN_MM);
  const side = Number.isFinite(n) && n >= 0 && n <= 20 ? n : 3;
  const page = getReceiptPageWidthMm(env);
  const max = Math.max(0, Math.floor((page - 20) / 2));
  return Math.min(side, max);
}

/** Optional physical shift (mm). Positive moves the slip to the right. Default 0. */
export function getReceiptHorizontalOffsetMm(env = process.env) {
  const n = Number(env.RECEIPT_HORIZONTAL_OFFSET_MM);
  if (!Number.isFinite(n) || n === 0) return 0;
  return Math.max(-10, Math.min(10, n));
}

/** Printable content width: page width minus equal left/right margins. */
export function getReceiptContentWidthMm(env = process.env) {
  return getReceiptPageWidthMm(env) - 2 * getReceiptSideMarginMm(env);
}

/**
 * Estimate printed slip height so Edge --print-to-pdf does not emit a full A4 page.
 * @param {object} opts same shape as buildReceiptHtml
 */
export function estimateReceiptPageHeightMm(opts) {
  const settings = opts?.settings || {};
  const showTax = settings.receipt_show_tax !== false && Number(opts?.tax) > 0;
  const showCashier = settings.receipt_show_cashier !== false && Boolean(opts?.cashierName);
  const items = Array.isArray(opts?.lines) ? opts.lines.length : 0;
  const paymentLines = buildPaymentSection(opts || {}).length;

  const headerMm = 58 + (showCashier ? 10 : 0);
  const itemsMm = 12 + items * 7;
  const totalsMm = 18 + (showTax ? 5 : 0);
  const paymentMm = 6 + paymentLines * 5;
  const partyBalance = opts?.partyBalance || opts?.party_balance;
  const balanceMm = partyBalance?.before_display ? 12 : 0;
  const footerMm = 16;
  const thanksAndCutterMm = 12;
  const raw = headerMm + itemsMm + totalsMm + paymentMm + balanceMm + footerMm + thanksAndCutterMm;
  return Math.min(RECEIPT_HEIGHT_MAX_MM, Math.max(RECEIPT_HEIGHT_MIN_MM, Math.round(raw)));
}

function receiptHtmlCss() {
  const pageWidthMm = getReceiptPageWidthMm();
  const contentWidthMm = getReceiptContentWidthMm();
  const offsetMm = getReceiptHorizontalOffsetMm();
  const offsetCss =
    offsetMm === 0 ? "" : `position: relative; left: ${offsetMm}mm;`;
  return `
  @page { size: ${pageWidthMm}mm; margin: 0; }
  html { -webkit-locale: "en"; font-language-override: "eng"; font-feature-settings: "locl" 0; }
  html, body { direction: ltr; box-sizing: border-box; width: ${pageWidthMm}mm; height: auto !important; min-height: 0 !important; margin: 0; padding: 0; background: #fff; color: #000; font-family: "Segoe UI", Tahoma, Arial, sans-serif; font-size: 11px; }
  .receipt { direction: rtl; box-sizing: border-box; width: ${contentWidthMm}mm; max-width: ${contentWidthMm}mm; height: auto !important; min-height: 0 !important; margin-left: auto; margin-right: auto; padding: 2mm 0 0; ${offsetCss} }
  .logo-wrap { text-align: center; margin-bottom: 3px; }
  .logo-wrap img { max-width: 128px; max-height: 64px; object-fit: contain; }
  .center { text-align: center; }
  .header-box { display: grid; grid-template-columns: 1fr 1fr 1fr; border: 1px solid #000; border-radius: 4px; margin: 4px 0 3px; overflow: hidden; }
  .header-box > div { padding: 3px 4px; border-inline-start: 1px solid #000; }
  .header-box > div:first-child { border-inline-start: none; }
  .header-title { font-weight: 700; }
  .header-title .copy { font-weight: 400; display: block; }
  .header-no { text-align: center; }
  .meta-row { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; margin-bottom: 3px; }
  .meta-cell { border: 1px solid #000; border-radius: 4px; padding: 3px 5px; }
  table.items { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.items th, table.items td { padding: 2px 2px; border: 1px solid #000; vertical-align: top; }
  table.items th { font-weight: 700; }
  table.items .col-idx { width: 7%; text-align: center; }
  table.items .col-sku { width: 12%; text-align: center; direction: ltr; font-variant-numeric: tabular-nums; white-space: nowrap; }
  table.items .col-name { width: 30%; text-align: right; word-break: break-word; }
  table.items .col-num { width: 17%; text-align: center; direction: ltr; font-variant-numeric: tabular-nums; white-space: nowrap; }
  table.items tfoot td { font-weight: 700; }
  .pay-box { text-align: center; border: 1px solid #000; border-radius: 6px; padding: 6px 4px; margin: 5px auto 4px; font-size: 14px; font-weight: 700; width: 88%; }
  .foot-box { border: 1px solid #000; border-radius: 4px; padding: 3px 6px; margin: 3px auto; display: block; min-width: 55%; width: max-content; box-sizing: border-box; }
  .foot-box div { margin: 1px 0; }
  .tax-line { margin: 2px 0; }
  .payment { margin-top: 3px; }
  .payment div { margin: 1px 0; }
  .party-balance { margin-top: 3px; }
  .party-balance div { margin: 1px 0; }
  .thanks { text-align: center; margin: 4px 0 0; padding: 0; font-weight: 600; }
`;
}

/**
 * @param {object} opts same shape as buildReceiptText
 */
export function buildReceiptHtml(opts) {
  const settings = opts.settings || {};
  const showTax = settings.receipt_show_tax !== false;
  const showCashier = settings.receipt_show_cashier !== false;
  const paymentLines = buildPaymentSection(opts);
  const brand = brandingFromSettings(settings);
  const printBrand = resolvePrintBranding(settings);
  const { date, time } = splitTimestamp(opts.timestamp);
  const invNo = invoiceNumber(opts);

  const logoSrc = getStoreLogoDataUri();
  const logoHtml = logoSrc
    ? `<div class="logo-wrap"><img src="${escapeHtml(logoSrc)}" alt="" /></div>`
    : "";

  const licenseHtml = printBrand.showLicense
    ? `<div>${escapeHtml(printBrand.license)}</div>`
    : `<div></div>`;

  const itemRows = (opts.lines || [])
    .map((L, i) => {
      const name = L.name.length > 40 ? `${L.name.slice(0, 37)}...` : L.name;
      return `<tr>
        <td class="col-idx">${i + 1}</td>
        <td class="col-sku">${escapeHtml(receiptSkuLabel(L.sku))}</td>
        <td class="col-name">${escapeHtml(name)}</td>
        <td class="col-num">${escapeHtml(formatReceiptQty(L))}</td>
        <td class="col-num">${escapeHtml(formatReceiptPrice(L))}</td>
        <td class="col-num">${escapeHtml(Number(L.lineTotal).toFixed(2))}</td>
      </tr>`;
    })
    .join("");

  const taxHtml =
    showTax && opts.tax > 0
      ? `<div class="tax-line">ضريبة القيمة المضافة: ${escapeHtml(Number(opts.tax).toFixed(2))}</div>`
      : "";

  const paymentHtml = paymentLines.map((line) => `<div>${escapeHtml(line)}</div>`).join("");
  const balanceLines = buildPartyBalanceLines(opts);
  const balanceHtml = balanceLines.length
    ? `<div class="party-balance">${balanceLines.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}</div>`
    : "";

  const cashierBlock =
    showCashier && opts.cashierName
      ? `<div>المستخدم: ${escapeHtml(opts.cashierName)}</div>
      <div>الصندوق: ${escapeHtml(opts.cashierName)}</div>`
      : "";

  return `<!DOCTYPE html>
<html lang="ar-u-nu-latn" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>إيصال</title>
  <style>${receiptHtmlCss()}</style>
</head>
<body>
  <div class="receipt">
    ${logoHtml}
    <div class="center"><strong>${escapeHtml(brand.name)}</strong></div>
    <div class="center">${escapeHtml(brand.phone)}</div>
    <div class="header-box">
      ${licenseHtml}
      <div class="header-no">الرقم : ${escapeHtml(invNo)}</div>
      <div class="header-title">فاتورة مبيعات ضريبية<span class="copy">نسخة أصلية</span></div>
    </div>
    <div class="meta-row">
      <div class="meta-cell">إلى : ${escapeHtml(soldToLabel(opts))}</div>
      <div class="meta-cell">${escapeHtml(date)}</div>
    </div>
    <table class="items">
      <thead>
        <tr>
          <th class="col-idx">#</th>
          <th class="col-sku">الرقم</th>
          <th class="col-name">الاسم</th>
          <th class="col-num">الكمية</th>
          <th class="col-num">السعر</th>
          <th class="col-num">المجموع</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
      <tfoot>
        <tr>
          <td></td>
          <td></td>
          <td class="col-name">المجموع الكلي</td>
          <td class="col-num">${escapeHtml(formatQtySum(opts.lines))}</td>
          <td></td>
          <td class="col-num">${escapeHtml(Number(opts.total).toFixed(2))}</td>
        </tr>
      </tfoot>
    </table>
    <div class="pay-box">المبلغ للدفع ${escapeHtml(Number(opts.total).toFixed(2))} شيقل</div>
    <div class="foot-box">
      <div>الوقت: ${escapeHtml(time)}</div>
      ${cashierBlock}
    </div>
    ${taxHtml}
    <div class="payment">${paymentHtml}</div>
    ${balanceHtml}
    <div class="thanks">شكراً لزيارتكم</div>
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
  const printBrand = resolvePrintBranding(settings);
  const { date, time } = splitTimestamp(opts.timestamp);
  const invNo = invoiceNumber(opts);

  const sep = "═".repeat(LINE);
  const thin = "─".repeat(LINE);
  const paymentLines = buildPaymentSection(opts);
  const balanceLines = buildPartyBalanceLines(opts);

  const brand = brandingFromSettings(settings);
  const lines = [
    sep,
    padCenter(brand.name, LINE),
    padCenter(brand.phone, LINE),
  ];

  if (printBrand.showLicense) {
    lines.push(padCenter(printBrand.license, LINE));
  }

  lines.push(
    padCenter("فاتورة مبيعات ضريبية", LINE),
    padCenter("نسخة أصلية", LINE),
    sep,
    `الرقم : ${invNo}`,
    `إلى : ${soldToLabel(opts)}`,
    `التاريخ: ${date}`,
    ""
  );

  lines.push(
    `${padRight("الرقم", 6)}${padRight("الاسم", 16)}${padLeft("الكمية", 5)} ${padLeft("السعر", 8)} ${padLeft("المجموع", 10)}`,
    thin
  );

  for (const L of opts.lines) {
    const name = L.name.length > 14 ? L.name.slice(0, 11) + "..." : L.name;
    const sku = receiptSkuLabel(L.sku);
    lines.push(
      `${padRight(sku, 6)}${padRight(name, 16)}${padLeft(formatReceiptQty(L), 5)} ${padLeft(formatReceiptPrice(L), 8)} ${padLeft(L.lineTotal.toFixed(2), 10)}`
    );
  }

  lines.push(
    thin,
    `${padRight("المجموع الكلي:", 34)}${padLeft(opts.total.toFixed(2), 10)}`,
    sep,
    padCenter(`المبلغ للدفع ${Number(opts.total).toFixed(2)} شيقل`, LINE),
    sep,
    `الوقت: ${time}`
  );

  if (showCashier && opts.cashierName) {
    lines.push(`المستخدم: ${opts.cashierName}`, `الصندوق: ${opts.cashierName}`);
  }

  if (showTax && opts.tax > 0) {
    lines.push(`${padRight("ضريبة القيمة المضافة:", 34)}${padLeft(opts.tax.toFixed(2), 10)}`);
  }

  lines.push(sep, ...paymentLines, ...balanceLines, sep, padRight("شكراً لزيارتكم", LINE), sep);

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
