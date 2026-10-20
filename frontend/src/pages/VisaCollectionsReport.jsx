import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { apiErrorMessage } from "../utils/apiError";
import { ils } from "../utils/format";
import { getDatePresets, todayYmd } from "../utils/reportDates";
import { VISA_RECONCILE_LABELS, formatSignedMoney } from "../utils/shiftVisa";
import { VisaActivityList } from "../components/ShiftVisaSection";
import {
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  DataTable,
  FilterBar,
  FormField,
  DateField,
  Select,
  Input,
  StatCard,
  Modal,
  Notice,
  EmptyState,
  Skeleton,
  ReportToolbar,
} from "../components/ui";

function parseYmd(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  return value.trim();
}

function moneyOrBlank(value) {
  if (value == null || value === "") return "—";
  return ils(value);
}

const COLUMNS = [
  { key: "shift_id", header: "الوردية", value: (row) => `#${row.shift_id}` },
  { key: "cashier_name", header: "الكاشير" },
  { key: "business_day", header: "يوم العمل" },
  { key: "receipt_count", header: "عدد عمليات الفيزا" },
  { key: "sales", header: "مبيعات الفيزا", value: (row) => ils(row.sales) },
  { key: "other", header: "تحصيلات فيزا أخرى", value: (row) => ils(row.other) },
  { key: "refunds", header: "مرتجعات الفيزا", value: (row) => ils(row.refunds) },
  {
    key: "expected_net",
    header: "صافي الفيزا المتوقع",
    value: (row) => `${ils(row.expected_net)}${row.known_only ? " (غير مكتمل)" : ""}`,
  },
  { key: "machine_net", header: "صافي إجمالي جهاز الفيزا", value: (row) => moneyOrBlank(row.machine_net) },
  { key: "difference", header: "فرق الفيزا", value: (row) => moneyOrBlank(row.difference) },
  {
    key: "status_label",
    header: "الحالة",
    value: (row) =>
      [row.status_label, row.incomplete ? "غير مكتمل" : "", row.basis_changed ? "تغيّر الأساس" : ""]
        .filter(Boolean)
        .join(" · "),
  },
  {
    key: "current_net",
    header: "النشاط الحالي",
    value: (row) => ils(row.current?.net),
  },
];

export default function VisaCollectionsReport() {
  const [searchParams, setSearchParams] = useSearchParams();
  const presets = useMemo(() => getDatePresets(), []);
  const initialFrom = parseYmd(searchParams.get("from")) || todayYmd();
  const initialTo = parseYmd(searchParams.get("to")) || initialFrom;
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [cashierId, setCashierId] = useState(searchParams.get("cashier_id") || "");
  const [shiftId, setShiftId] = useState(searchParams.get("shift_id") || "");
  const [state, setState] = useState(searchParams.get("state") || "all");
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [lines, setLines] = useState(null);
  const [linesShiftId, setLinesShiftId] = useState(null);

  const load = useCallback(async () => {
    if (!from || !to || from > to) {
      setErr("فترة التقرير غير صالحة");
      setLoading(false);
      return;
    }
    setLoading(true);
    setErr("");
    try {
      const { data } = await api.get("/api/reports/visa", {
        headers: getAuthHeaders(),
        params: {
          from,
          to,
          cashier_id: cashierId || undefined,
          shift_id: shiftId || undefined,
          state: state || "all",
        },
      });
      setReport(data);
      const next = new URLSearchParams();
      next.set("from", from);
      next.set("to", to);
      if (cashierId) next.set("cashier_id", cashierId);
      if (shiftId) next.set("shift_id", shiftId);
      if (state && state !== "all") next.set("state", state);
      setSearchParams(next, { replace: true });
    } catch (e) {
      setErr(apiErrorMessage(e, "تعذّر تحميل تقرير الفيزا"));
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [from, to, cashierId, shiftId, state, setSearchParams]);

  useEffect(() => {
    load();
  }, [load]);

  async function openLines(id) {
    setLinesShiftId(id);
    setLines(null);
    try {
      const { data } = await api.get(`/api/reports/visa/shifts/${id}/lines`, {
        headers: getAuthHeaders(),
      });
      setLines(data);
    } catch (e) {
      setLines({ error: apiErrorMessage(e, "تعذّر تحميل العمليات") });
    }
  }

  const summary = report?.summary;
  const rows = report?.shifts || [];
  const summaryItems = summary
    ? [
        {
          label: summary.expected_label || "صافي تحصيلات الفيزا",
          value: ils(summary.expected_net),
        },
        { label: "عدد عمليات الفيزا", value: String(summary.receipt_count) },
        { label: "جهاز الفيزا المعدود", value: moneyOrBlank(summary.machine_net) },
        { label: "فرق المطابقة", value: moneyOrBlank(summary.difference) },
        { label: "بانتظار المطابقة", value: ils(summary.awaiting_expected_net) },
      ]
    : [];

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title="تحصيلات الفيزا"
        subtitle="تحصيلات ورديات الصندوق. تختلف عن مبيعات الفيزا في تقرير المبيعات عند وجود فاتورة مكتب أو تحصيل فيزا آخر."
        icon="finance"
        actions={
          <ReportToolbar
            title="تحصيلات الفيزا"
            subtitle={`${from} — ${to}`}
            columns={COLUMNS}
            rows={rows}
            summary={summaryItems}
            filename="visa-collections"
            disabled={loading || !report}
          />
        }
      />

      <FilterBar>
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="ui-btn ui-btn--secondary ui-btn--sm"
            onClick={() => {
              if (preset.mode === "day") {
                setFrom(preset.date);
                setTo(preset.date);
              } else {
                setFrom(preset.from);
                setTo(preset.to);
              }
            }}
          >
            {preset.label}
          </button>
        ))}
        <FormField label="من">
          <DateField value={from} onChange={(e) => setFrom(e.target.value)} />
        </FormField>
        <FormField label="إلى">
          <DateField value={to} onChange={(e) => setTo(e.target.value)} />
        </FormField>
        <FormField label="الكاشير">
          <Select value={cashierId} onChange={(e) => setCashierId(e.target.value)}>
            <option value="">الكل</option>
            {(report?.cashiers || []).map((cashier) => (
              <option key={cashier.id} value={String(cashier.id)}>
                {cashier.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="الوردية">
          <Input value={shiftId} onChange={(e) => setShiftId(e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
        </FormField>
        <FormField label="المطابقة">
          <Select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="all">الكل</option>
            <option value="awaiting">{VISA_RECONCILE_LABELS.waiting}</option>
            <option value="matched">{VISA_RECONCILE_LABELS.matched}</option>
            <option value="difference">بفرق</option>
          </Select>
        </FormField>
      </FilterBar>

      {err ? <EmptyState title={err} /> : null}
      {loading ? <Skeleton style={{ height: 180 }} /> : null}

      {!loading && summary ? (
        <>
          {summary.coverage === "incomplete" ? (
            <Notice tone="warn">
              التغطية غير مكتملة. المبالغ المعروضة هي المبالغ المعروفة فقط، ولم يُحسب المجهول صفراً.
            </Notice>
          ) : null}
          {summary.basis_changed_shifts > 0 ? (
            <Notice tone="warn">
              تغيّر أساس المطابقة بعد الحفظ في {summary.basis_changed_shifts} وردية. المقارنة المحفوظة باقية،
              وعمود النشاط الحالي يعرض المدفوعات الراهنة.
            </Notice>
          ) : null}
          <div className="ui-stat-grid ui-mt-md">
            <StatCard label={summary.expected_label} value={ils(summary.expected_net)} icon="finance" />
            <StatCard label="عدد عمليات الفيزا" value={summary.receipt_count} icon="finance" />
            <StatCard label="جهاز الفيزا المعدود" value={moneyOrBlank(summary.machine_net)} icon="finance" />
            <StatCard
              label="فرق المطابقة"
              value={summary.difference == null ? "—" : formatSignedMoney(summary.difference)}
              icon="finance"
            />
            <StatCard
              label="بانتظار المطابقة"
              value={ils(summary.awaiting_expected_net)}
              hint={`${summary.awaiting_shifts} وردية`}
              icon="shifts"
            />
          </div>
          <Card className="ui-mt-md">
            <CardHeader title="الورديات" />
            <CardBody>
              <DataTable
                columns={COLUMNS.map((column) => ({
                  ...column,
                  label: column.header,
                  render: (row) => (typeof column.value === "function" ? column.value(row) : row[column.key]),
                })).concat({
                  key: "open",
                  header: "العمليات",
                  label: "العمليات",
                  render: (row) => (
                    <button type="button" className="dashboard-inline-link" onClick={() => openLines(row.shift_id)}>
                      عرض
                    </button>
                  ),
                })}
                rows={rows}
                empty="لا توجد ورديات في هذه الفترة"
              />
            </CardBody>
          </Card>
        </>
      ) : null}

      <Modal
        open={linesShiftId != null}
        onClose={() => {
          setLinesShiftId(null);
          setLines(null);
        }}
        title={linesShiftId ? `عمليات الفيزا — وردية #${linesShiftId}` : "عمليات الفيزا"}
        size="lg"
      >
        {lines?.error ? (
          <EmptyState title={lines.error} />
        ) : lines ? (
          <VisaActivityList lines={lines.lines} incomplete={lines.incomplete} />
        ) : (
          <p>جاري التحميل…</p>
        )}
      </Modal>
    </div>
  );
}
