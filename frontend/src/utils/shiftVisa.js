import { ils } from "./format";

export const SHIFT_VISA_LABELS = Object.freeze({
  sales: "مبيعات فيزا",
  refunds: "مرتجعات الفيزا",
  net: "صافي المبيعات الفيزا",
});

export const SHIFT_CASH_SALES_LABEL = "مبيعات نقدية";
export const SHIFT_MIXED_CASH_LABEL = "منها نقد من دفعات مختلطة";
export const SHIFT_MIXED_CASH_INCLUDED_NOTE = "مشمول في المبيعات النقدية";
export const SHIFT_VISA_AMOUNT_LABEL = SHIFT_VISA_LABELS.sales;
export const SHIFT_TENDER_TOTAL_LABEL = "إجمالي المبيعات النقدية والفيزا";
export const SHIFT_CASH_REFUNDS_LABEL = "مرتجعات نقدية";
export const SHIFT_CASH_NET_LABEL = "صافي المبيعات النقدية";
export const SHIFT_EXPECTED_CASH_LABEL = "النقد المتوقع في الصندوق";
export const SHIFT_OPENING_CASH_LABEL = "رصيد بداية الوردية";
export const SHIFT_DRAWER_CASH_SALES_LABEL = "المبيعات النقدية";
export const SHIFT_DRAWER_CASH_REFUNDS_LABEL = "المرتجعات النقدية";
export const SHIFT_SUPPLIER_PAYMENTS_LABEL = "دفعات الموردين";
export const SHIFT_ADVANCES_LABEL = "المصروفات والسلف";
export const SHIFT_COLLECTIONS_LABEL = "قبض ذمم سابق";
export const SHIFT_CASH_DEBTS_LABEL = "ذمم نقدية للعملاء";
export const SHIFT_ADJUSTMENT_LABEL = "تسوية نقدية";
export const SHIFT_OPENING_UNAVAILABLE = "غير متوفر";
export const SHIFT_EXPECTED_REVIEW_NOTE = "راجع رصيد البداية وحركات الصندوق";

export const CASH_SALES_INCOMPLETE_NOTE =
  "سجل المبيعات النقدية غير مكتمل: توجد عمليات بلا توزيع دفع موثوق، ولم يُخمَّن المبلغ الناقص.";

export const VISA_RECORDED_NOTE =
  "مدفوعات فيزا مسجّلة في النظام. ليست تسوية بنكية ولا مطابقة لجهاز البطاقة.";

export const VISA_INCOMPLETE_NOTE =
  "سجل الفيزا غير مكتمل: توجد عمليات بلا توزيع دفع موثوق، ولم يُخمَّن المبلغ الناقص.";

function labelsOf(visa) {
  return {
    sales: visa?.visa_labels?.sales || SHIFT_VISA_LABELS.sales,
    refunds: visa?.visa_labels?.refunds || SHIFT_VISA_LABELS.refunds,
    net: visa?.visa_labels?.net || SHIFT_VISA_LABELS.net,
  };
}

/** Print/export lines for recorded Visa. Amounts come from the shift payload unchanged. */
export function buildShiftVisaPrintModel(visa) {
  const labels = labelsOf(visa);
  const sales = Number(visa?.visa_sales) || 0;
  const refunds = Number(visa?.visa_refunds) || 0;
  const net = Number(visa?.visa_net) || 0;
  const incomplete = !!visa?.visa_incomplete;
  const note = visa?.visa_note || VISA_RECORDED_NOTE;
  const incompleteNote = visa?.visa_incomplete_note || VISA_INCOMPLETE_NOTE;
  return {
    incomplete,
    note,
    incompleteNote,
    meta: incomplete ? [note, incompleteNote] : [note],
    items: [
      { key: "sales", label: labels.sales, value: ils(sales), amount: sales },
      { key: "refunds", label: labels.refunds, value: ils(refunds), amount: refunds },
      { key: "net", label: labels.net, value: ils(net), amount: net },
    ],
  };
}

export function visaAmountText(row, key) {
  const amount = row?.[key];
  if (amount == null || Number.isNaN(Number(amount))) return "—";
  const text = ils(amount);
  if (key === "visa_net" && row.visa_incomplete) return `${text} (غير مكتمل)`;
  if (key === "cash_sales" && row.cash_sales_incomplete) return `${text} (غير مكتمل)`;
  return text;
}

function moneyLine(label, amount, extra = {}) {
  const n = Number(amount) || 0;
  return { label, amount: n, value: ils(n), ...extra };
}

/** Compact count-dialog / closing-report lines from the selected shift payload. */
export function buildShiftCountSummaryModel(source = {}) {
  const visa = buildShiftVisaPrintModel(source);
  const cashAmount = Number(source.cash_sales) || 0;
  const mixedCash = Number(source.mixed_cash_sales) || 0;
  const visaSales = Number(source.visa_sales) || 0;
  const cashRefunds = Number(source.cash_refunds) || 0;
  const tenderTotal =
    source.tender_total != null && source.tender_total !== ""
      ? Number(source.tender_total)
      : cashAmount + visaSales;
  const cashNet =
    source.cash_net != null && source.cash_net !== ""
      ? Number(source.cash_net)
      : cashAmount - cashRefunds;
  const cashIncomplete = !!source.cash_sales_incomplete;
  const expectedRaw = source.expected_cash;
  const expectedAmount = expectedRaw != null && expectedRaw !== "" ? Number(expectedRaw) : null;
  const mixedIncludedNote = source.mixed_cash_included_note || SHIFT_MIXED_CASH_INCLUDED_NOTE;
  return {
    cashSales: moneyLine(source.cash_sales_label || SHIFT_CASH_SALES_LABEL, cashAmount, {
      incomplete: cashIncomplete,
      incompleteNote: source.cash_sales_incomplete_note || CASH_SALES_INCOMPLETE_NOTE,
    }),
    mixedIncluded:
      mixedCash !== 0
        ? moneyLine(source.mixed_cash_label || SHIFT_MIXED_CASH_LABEL, mixedCash, {
            includedNote: mixedIncludedNote,
          })
        : null,
    visa: moneyLine(source.visa_amount_label || SHIFT_VISA_AMOUNT_LABEL, visaSales, {
      incomplete: visa.incomplete,
    }),
    tenderTotal: moneyLine(source.tender_total_label || SHIFT_TENDER_TOTAL_LABEL, tenderTotal),
    cashRefunds: moneyLine(source.cash_refunds_label || SHIFT_CASH_REFUNDS_LABEL, cashRefunds),
    visaRefunds: visa.items.find((item) => item.key === "refunds"),
    cashNet: moneyLine(source.cash_net_label || SHIFT_CASH_NET_LABEL, cashNet),
    visaNet: visa.items.find((item) => item.key === "net"),
    expected: {
      label: source.expected_cash_label || SHIFT_EXPECTED_CASH_LABEL,
      amount: expectedAmount,
      value: expectedAmount != null && !Number.isNaN(expectedAmount) ? ils(expectedAmount) : "—",
    },
    mixedIncludedNote,
    visaNote: visa.note,
    visaIncompleteNote: visa.incompleteNote,
    visaIncomplete: visa.incomplete,
    cashIncomplete,
    meta: [
      visa.note,
      ...(visa.incomplete ? [visa.incompleteNote] : []),
      ...(cashIncomplete ? [source.cash_sales_incomplete_note || CASH_SALES_INCOMPLETE_NOTE] : []),
      ...(mixedCash !== 0 ? [mixedIncludedNote] : []),
    ],
  };
}

/** Isolated amount text: −93.00 ₪. Does not change the numeric value. */
export function formatSignedMoney(amount, symbol = "\u20AA") {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const body = `${n < 0 ? "\u2212" : ""}${abs}`;
  return symbol ? `${body} ${symbol}` : body;
}

function knownAmount(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Refunds and net lines for the sales card.
 * The count dialog omits zero lines because they repeat the gross figures.
 * Shift details pass includeZeros so every removed table column stays visible.
 */
export function buildShiftCountDetailLines(model, { includeZeros = false } = {}) {
  if (!model) return [];
  const lines = [];
  if (model.mixedIncluded) {
    lines.push({ key: "mixed", label: model.mixedIncluded.label, amount: model.mixedIncluded.amount });
  }
  const showCash = includeZeros || (model.cashRefunds && model.cashRefunds.amount !== 0);
  if (showCash && model.cashRefunds) {
    lines.push({ key: "cashRefunds", label: model.cashRefunds.label, amount: model.cashRefunds.amount });
    if (model.cashNet) lines.push({ key: "cashNet", label: model.cashNet.label, amount: model.cashNet.amount });
  }
  const showVisa = includeZeros || (model.visaRefunds && model.visaRefunds.amount !== 0);
  if (showVisa && model.visaRefunds) {
    lines.push({ key: "visaRefunds", label: model.visaRefunds.label, amount: model.visaRefunds.amount });
    if (model.visaNet) {
      lines.push({
        key: "visaNet",
        label: model.visaNet.label,
        amount: model.visaNet.amount,
        incomplete: !!model.visaIncomplete,
      });
    }
  }
  return lines;
}

function pushMovement(lines, key, label, amount, direction) {
  const n = knownAmount(amount);
  if (n == null || n === 0) return;
  lines.push({ key, label, amount: Math.abs(n), direction });
}

/**
 * Drawer lines from summary fields already returned by the shift API.
 * Expected cash is not derived here. Visa is not a drawer inflow.
 * Mixed cash stays inside cash sales and is not added again.
 */
export function buildShiftDrawerLines(source = {}) {
  const lines = [];
  const opening = knownAmount(source.opening_cash);
  lines.push({
    key: "opening",
    label: SHIFT_OPENING_CASH_LABEL,
    amount: opening,
    unavailable: opening == null,
    direction: "base",
  });
  lines.push({
    key: "cashSales",
    label: SHIFT_DRAWER_CASH_SALES_LABEL,
    amount: knownAmount(source.cash_sales) ?? 0,
    unavailable: false,
    direction: "in",
  });
  pushMovement(lines, "collections", SHIFT_COLLECTIONS_LABEL, source.customer_collections_total, "in");
  pushMovement(lines, "cashRefunds", SHIFT_DRAWER_CASH_REFUNDS_LABEL, source.cash_refunds, "out");
  pushMovement(lines, "supplierPayments", SHIFT_SUPPLIER_PAYMENTS_LABEL, source.supplier_payments_total, "out");
  pushMovement(lines, "advances", SHIFT_ADVANCES_LABEL, source.advances_total, "out");
  pushMovement(lines, "cashDebts", SHIFT_CASH_DEBTS_LABEL, source.customer_cash_debts_total, "out");
  const adjustment = knownAmount(source.adjustments_total);
  if (adjustment != null && adjustment !== 0) {
    lines.push({
      key: "adjustment",
      label: SHIFT_ADJUSTMENT_LABEL,
      amount: Math.abs(adjustment),
      unavailable: false,
      direction: adjustment < 0 ? "out" : "in",
    });
  }
  return lines;
}

/** Display sign for a drawer line. Outflows are stored as positive magnitudes. */
export function drawerLineAmount(line) {
  if (!line || line.unavailable) return null;
  const n = Number(line.amount);
  if (!Number.isFinite(n)) return null;
  if (line.direction === "out") return -Math.abs(n);
  return n;
}
