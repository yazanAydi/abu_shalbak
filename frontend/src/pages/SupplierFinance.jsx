import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api from "../apiClient";
import { firstOfCurrentMonthYmd, todayYmd } from "../utils/reportDates";
import { ils, INCOMPLETE_PROFIT_AR } from "../utils/format";
import { apiErrorDetails, apiErrorMessage } from "../utils/apiError";
import {
  CURRENT_POSITION_AS_OF_AR,
  INCOMPLETE_INVENTORY_COST_AR,
  INCOMPLETE_INVENTORY_RETAIL_AR,
  NEGATIVE_INVENTORY_AR,
  SUPPLIER_PAYMENTS_UNRECONCILED_AR,
  ZERO_PRICE_STOCK_AR,
  buildFinancePrintSummary,
  hasNegativeInventoryValuation,
  isInventoryValuationIncomplete,
  ilsOrIncomplete,
} from "../utils/financeDashboardHelpers";
import {
  Card,
  CardBody,
  DataTable,
  DateField,
  EmptyState,
  FilterBar,
  FormField,
  HelpPanel,
  Notice,
  PageHeader,
  PrimaryButton,
  ReportToolbar,
  SectionTitle,
  Skeleton,
  StatCard,
} from "../components/ui";

const incompleteStatus = { label: "غير مكتمل", tone: "orange", icon: "alert" };
const currentStatus = { label: "رصيد حالي", tone: "neutral" };

function marginLabel(percent, unknown) {
  if (unknown) return "غير مكتمل";
  if (percent == null) return "—";
  return `${Number(percent).toFixed(2)}٪`;
}

export default function SupplierFinance() {
  const [from, setFrom] = useState(firstOfCurrentMonthYmd);
  const [to, setTo] = useState(todayYmd);
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [errDetails, setErrDetails] = useState("");

  const loadOverview = useCallback(async () => {
    if (!from || !to) return;
    setLoading(true);
    setErr("");
    setErrDetails("");
    try {
      const { data } = await api.get("/api/finance/overview", { params: { from, to } });
      setOverview(data);
    } catch (e) {
      setErr(apiErrorMessage(e, "تعذّر تحميل الملخص"));
      setErrDetails(apiErrorDetails(e));
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  const unknown = !!(overview?.cogs_unknown || overview?.profit?.cogsKnown === false);
  const sales = overview?.sales;
  const profit = overview?.profit;
  const pay = overview?.supplierPayments;
  const purch = overview?.purchases;
  const pos = overview?.currentPosition;
  const payUnreconciled = pay?.status === "unreconciled";
  const inventoryNegative = hasNegativeInventoryValuation(pos);
  const inventoryIncomplete = isInventoryValuationIncomplete(pos);

  const printSummary = useMemo(() => buildFinancePrintSummary(overview), [overview]);

  const ledgerRows = sales
    ? [
        { key: "gross", label: "إجمالي المبيعات", value: ils(sales.gross) },
        { key: "refunds", label: "الاسترجاعات", value: `− ${ils(sales.refunds)}` },
        { key: "net", label: "صافي المبيعات", value: ils(sales.net) },
        { key: "cogs", label: "تكلفة البضاعة", value: unknown ? "غير مكتمل" : `− ${ils(profit.cogs)}` },
        { key: "gp", label: "الربح الإجمالي", value: ilsOrIncomplete(profit.grossProfit, unknown) },
        { key: "opex", label: "مصاريف التشغيل", value: `− ${ils(profit.operatingExpenses)}` },
      ]
    : [];

  const ledgerFooter = profit
    ? [
        {
          key: "opnet",
          label: "صافي الربح التشغيلي",
          value: ilsOrIncomplete(profit.operatingNetProfit, unknown),
        },
      ]
    : [];

  return (
    <div className="office-page finance-dash" dir="rtl" lang="ar">
      <PageHeader
        title="المراقبة المالية"
        subtitle="أداء الفترة والأرصدة الحالية"
        icon="finance"
        actions={
          <>
            <ReportToolbar
              title="المراقبة المالية"
              subtitle={`${from} إلى ${to}`}
              columns={[]}
              rows={[]}
              summary={printSummary}
              filename="finance-overview"
              disabled={!overview}
            />
            <PrimaryButton type="button" onClick={loadOverview} disabled={loading}>
              {loading ? "جاري التحميل…" : "تحديث"}
            </PrimaryButton>
          </>
        }
      />

      <FilterBar>
        <FormField label="من" className="ui-field--date">
          <DateField value={from} onChange={(e) => setFrom(e.target.value)} />
        </FormField>
        <FormField label="إلى" className="ui-field--date">
          <DateField value={to} onChange={(e) => setTo(e.target.value)} />
        </FormField>
      </FilterBar>

      <HelpPanel title="طريقة الحساب">
        <p>
          المبيعات والاسترجاعات وتكلفة البضاعة حسب يوم عمل الوردية (بداية الوردية، أو وقت العملية إن لم توجد). نهاية الفترة مشمولة.
          المصاريف حسب تاريخ الدفع. دفعات الموردين حسب تاريخ سند الصرف المرحّل.
          المشتريات حسب تاريخ فاتورة الشراء، ومرتجعاتها حسب تاريخ المرتجع.
        </p>
        <p>
          <Link to="/sales-reports">تقارير المبيعات</Link>
          {" · "}
          <Link to="/expenses">المصروفات</Link>
          {" · "}
          <Link to="/purchases">المشتريات</Link>
          {" · "}
          <Link to="/vouchers/payment">سند صرف</Link>
          {" · "}
          <Link to="/customers">العملاء</Link>
        </p>
      </HelpPanel>

      {err ? <Notice tone="danger" details={errDetails}>{err}</Notice> : null}

      {unknown ? <Notice tone="warn">{INCOMPLETE_PROFIT_AR}</Notice> : null}
      {payUnreconciled ? <Notice tone="warn">{SUPPLIER_PAYMENTS_UNRECONCILED_AR}</Notice> : null}
      {pos?.zeroPriceStockedCount > 0 ? <Notice tone="warn">{ZERO_PRICE_STOCK_AR}</Notice> : null}
      {inventoryNegative ? <Notice tone="warn">{NEGATIVE_INVENTORY_AR}</Notice> : null}
      {pos?.inventoryCostIncomplete || pos?.nullCostStockedCount > 0 ? (
        <Notice tone="warn">{INCOMPLETE_INVENTORY_COST_AR}</Notice>
      ) : null}
      {pos?.inventoryRetailIncomplete || pos?.nullPriceStockedCount > 0 ? (
        <Notice tone="warn">{INCOMPLETE_INVENTORY_RETAIL_AR}</Notice>
      ) : null}

      {loading && !overview ? (
        <div className="ui-mt-md">
          <Skeleton style={{ height: 140, marginBottom: 16 }} />
          <Skeleton style={{ height: 220 }} />
        </div>
      ) : !overview ? (
        <EmptyState title={err || "تعذّر تحميل الملخص"} hint="تحقق من التاريخ أو أعد المحاولة" />
      ) : (
        <>
          <SectionTitle className="finance-section-title">أداء الفترة المحددة</SectionTitle>
          <div className="ui-stat-grid">
            <StatCard
              label="صافي المبيعات"
              value={ils(sales.net)}
              hint={sales.transactionCount ? `${sales.transactionCount} عملية` : ""}
              help={`إجمالي ${ils(sales.gross)} − استرجاعات ${ils(sales.refunds)}${
                sales.avgTicket != null ? ` · متوسط ${ils(sales.avgTicket)}` : ""
              }${
                sales.refundCount
                  ? ` · ${sales.refundCount} إرجاع${
                      sales.refundRatePercent != null ? ` (${sales.refundRatePercent}٪)` : ""
                    }`
                  : ""
              }`}
              icon="finance"
              tone="green"
            />
            <StatCard
              label="تكلفة البضاعة المباعة"
              value={ilsOrIncomplete(profit.cogs, unknown)}
              hint={unknown ? "تكلفة بعض المبيعات غير معروفة" : ""}
              help="تكلفة تاريخية من لحظة البيع"
              icon="finance"
              tone={unknown ? "orange" : "teal"}
              alert={unknown}
              status={unknown ? incompleteStatus : undefined}
            />
            <StatCard
              label="الربح الإجمالي"
              value={ilsOrIncomplete(profit.grossProfit, unknown)}
              hint={`هامش ${marginLabel(profit.grossMarginPercent, unknown)}`}
              icon="finance"
              tone={unknown ? "orange" : "green"}
              alert={unknown}
              status={unknown ? incompleteStatus : undefined}
            />
            <StatCard
              label="مصاريف التشغيل"
              value={ils(profit.operatingExpenses)}
              hint={`${overview.operating_expense_count || 0} مصروف`}
              icon="expenses"
            />
            <StatCard
              label="صافي الربح التشغيلي"
              value={ilsOrIncomplete(profit.operatingNetProfit, unknown)}
              hint="بعد مصاريف التشغيل"
              help="الربح الإجمالي − مصاريف التشغيل. دفعات الموردين خارج الحساب."
              icon="finance"
              tone={unknown ? "orange" : "teal"}
              alert={unknown}
              status={unknown ? incompleteStatus : undefined}
            />
            <StatCard
              label="دفعات الموردين"
              value={payUnreconciled ? "تحتاج مطابقة" : ils(pay?.total ?? 0)}
              hint={payUnreconciled ? "سندات قديمة غير مطابقة" : `${pay?.voucherCount || 0} سند صرف`}
              help={
                payUnreconciled
                  ? `سندات الصرف: ${ils(pay.voucherTotal)} · سجلات قديمة: ${ils(pay.legacyTotal)}`
                  : "سندات صرف مرحّلة في الفترة — ليست ضمن الربح التشغيلي."
              }
              icon="vouchers"
              tone={payUnreconciled ? "orange" : "teal"}
              alert={payUnreconciled}
            />
            <StatCard
              label="صافي المشتريات"
              value={ils(purch?.net)}
              hint={`${purch?.invoiceCount || 0} فاتورة`}
              help={`إجمالي ${ils(purch?.gross)} · مرتجعات −${ils(purch?.returns)}`}
              icon="purchases"
              tone="teal"
            />
          </div>

          <Card>
            <CardBody>
              <SectionTitle>ملخص الفترة</SectionTitle>
              <DataTable
                columns={[
                  { key: "label", header: "البند" },
                  { key: "value", header: "القيمة", className: "num" },
                ]}
                rows={ledgerRows}
                footer={ledgerFooter}
                empty="—"
              />
              <p className="ui-text-muted ui-mt-sm">
                دفعات الموردين ليست ضمن الربح:{" "}
                {payUnreconciled ? "تحتاج مطابقة البيانات" : ils(pay?.total ?? 0)}
                {" · "}
                المشتريات ليست ضمن الربح: صافي {ils(purch?.net)}
              </p>
            </CardBody>
          </Card>

          <SectionTitle className="finance-section-title">الوضع المالي الحالي</SectionTitle>
          <div className="ui-stat-grid">
            <StatCard
              label="ذمم العملاء والموظفين"
              value={ils(pos.customerReceivables)}
              hint={`${pos.customersWithBalance} حساب عليهم رصيد — يشمل العملاء العاديين وذمم الموظفين مرة واحدة`}
              help={CURRENT_POSITION_AS_OF_AR}
              icon="customers"
              tone="orange"
              status={currentStatus}
            />
            <StatCard
              label="مخزون (تكلفة / بيع)"
              value={`${ils(pos.inventoryAtCost)} / ${ils(pos.inventoryAtRetail)}`}
              hint={inventoryNegative || inventoryIncomplete ? "التقييم يحتاج مراجعة" : "كل الأصناف بما فيها المخبز"}
              help={`${CURRENT_POSITION_AS_OF_AR}. يشمل الرصيد السالب.${
                inventoryNegative ? ` ${NEGATIVE_INVENTORY_AR}` : ""
              }${inventoryIncomplete ? " التقييم قد يكون ناقصًا إذا وُجدت تكاليف أو أسعار غير معروفة." : ""}`}
              icon="warehouses"
              tone={inventoryNegative || inventoryIncomplete ? "orange" : "teal"}
              alert={inventoryNegative || inventoryIncomplete}
              status={inventoryNegative || inventoryIncomplete ? incompleteStatus : currentStatus}
            />
          </div>
        </>
      )}
    </div>
  );
}
