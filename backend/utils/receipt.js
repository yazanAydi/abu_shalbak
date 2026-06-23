const LINE = 48;

function padRight(s, w) {
  const str = String(s);
  return str.length >= w ? str.slice(0, w) : str + " ".repeat(w - str.length);
}

function padLeft(s, w) {
  const str = String(s);
  return str.length >= w ? str.slice(-w) : " ".repeat(w - str.length) + str;
}

/**
 * @param {object} opts
 * @param {number}   opts.transactionId
 * @param {string}   opts.timestamp
 * @param {string}   opts.cashierName
 * @param {Array<{name:string, quantity:number, price:number, lineTotal:number}>} opts.lines
 * @param {number}   opts.subtotal
 * @param {number}   opts.tax
 * @param {number}   opts.total
 * @param {string}   opts.paymentMethod
 * @param {object}   [opts.settings]
 */
export function buildReceiptText(opts) {
  const settings = opts.settings || {};
  const showTax = settings.receipt_show_tax !== false;
  const showCashier = settings.receipt_show_cashier !== false;

  const sep = "═".repeat(LINE);
  const thin = "─".repeat(LINE);
  const payLabel =
    opts.paymentMethod === "cash"
      ? "نقد"
      : opts.paymentMethod === "visa"
        ? "بطاقة"
        : opts.paymentMethod === "on_account"
          ? "ذمة"
          : String(opts.paymentMethod || "");

  const lines = [
    sep,
    padRight("أبو شلبك — إيصال بيع", LINE),
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
      `${padRight(name, 22)}${padLeft(L.quantity, 5)} ${padLeft(L.price.toFixed(2), 8)} ${padLeft(L.lineTotal.toFixed(2), 10)}`
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
    `الدفع: ${payLabel}`,
    sep,
    padRight("شكراً لزيارتكم", LINE),
    sep
  );

  return lines.join("\n");
}
