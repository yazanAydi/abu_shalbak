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
