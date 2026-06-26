const LINE = 48;

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

function methodLabel(method) {
  if (method === "cash") return "نقدي";
  if (method === "visa") return "فيزا";
  if (method === "on_account") return "ذمة";
  return String(method || "");
}

function buildPaymentSection(opts) {
  const total = Number(opts.total) || 0;
  const payments = Array.isArray(opts.payments) ? opts.payments : null;

  if (payments && payments.length > 0) {
    const lines = ["طريقة الدفع:"];
    const visa = payments.filter((p) => p.method === "visa");
    const cash = payments.filter((p) => p.method === "cash");
    const onAccount = payments.filter((p) => p.method === "on_account");

    for (const p of visa) {
      lines.push(`فيزا: ${ils(p.amount)}`);
    }
    for (const p of cash) {
      lines.push(`نقدي: ${ils(p.amount)}`);
    }
    for (const p of onAccount) {
      lines.push(`ذمة: ${ils(p.amount)}`);
    }

    const paidSum = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
    lines.push(`المجموع المدفوع: ${ils(paidSum)}`);

    const cashApplied = cash.reduce((s, p) => s + Number(p.amount || 0), 0);
    let change = 0;
    if (opts.cashTendered != null && Number.isFinite(Number(opts.cashTendered))) {
      change = Math.max(0, Math.round((Number(opts.cashTendered) - cashApplied) * 100) / 100);
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
 * @param {Array<{method:string, amount:number}>} [opts.payments]
 * @param {number}   [opts.cashTendered]
 * @param {object}   [opts.settings]
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
    ...paymentLines,
    sep,
    padRight("شكراً لزيارتكم", LINE),
    sep
  );

  return lines.join("\n");
}

export { methodLabel, ils as receiptIls };
