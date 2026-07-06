import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import api from "../apiClient";
import {
  PageHeader,
  ReportToolbar,
  Tabs,
  FilterBar,
  DataTable,
  Button,
  FormField,
  Input,
  useToast,
} from "../components/ui";

const EXPIRY_COLUMNS = [
  { key: "name", header: "المنتج" },
  { key: "barcode", header: "الباركود" },
  { key: "unit", header: "الوحدة", value: (r) => r.unit || "—" },
  { key: "stock", header: "الكمية" },
  { key: "expiry_date", header: "تاريخ الصلاحية" },
  {
    key: "days_until_expiry",
    header: "الأيام المتبقية",
    value: (r) =>
      r.days_until_expiry < 0 ? `منتهي (${r.days_until_expiry})` : String(r.days_until_expiry),
  },
];

const LOW_STOCK_COLUMNS = [
  { key: "name", header: "المنتج" },
  { key: "barcode", header: "الباركود" },
  { key: "category", header: "الفئة", value: (r) => r.category || "—" },
  { key: "unit", header: "الوحدة", value: (r) => r.unit || "—" },
  { key: "stock", header: "الكمية" },
];

const LOW_STOCK_THRESHOLD = 5;

export default function ExpiryReports() {
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const [rows, setRows] = useState([]);
  const [lowStock, setLowStock] = useState([]);
  const [days, setDays] = useState(30);
  const [threshold, setThreshold] = useState(LOW_STOCK_THRESHOLD);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState(() =>
    searchParams.get("tab") === "lowstock" ? "lowstock" : "expiry"
  );

  useEffect(() => {
    if (searchParams.get("tab") === "lowstock") setTab("lowstock");
    const t = Number(searchParams.get("threshold"));
    if (Number.isFinite(t) && t >= 0) setThreshold(t);
  }, [searchParams]);

  const loadExpiry = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/api/inventory/expiry?days=${days}`);
      setRows(data);
    } catch {
      toast.error("تعذّر تحميل تقرير الصلاحية");
    } finally {
      setLoading(false);
    }
  }, [days, toast]);

  const loadLowStock = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/api/inventory/low-stock?threshold=${threshold}`);
      setLowStock(data);
    } catch {
      toast.error("تعذّر تحميل تقرير المخزون المنخفض");
    } finally {
      setLoading(false);
    }
  }, [threshold, toast]);

  useEffect(() => {
    if (tab === "expiry") loadExpiry();
    else loadLowStock();
  }, [tab, loadExpiry, loadLowStock]);

  const reportConfig = useMemo(() => {
    if (tab === "expiry") {
      return {
        title: "تقرير الصلاحية",
        subtitle: `الأيام القادمة: ${days}`,
        columns: EXPIRY_COLUMNS,
        rows,
        filename: "expiry-report",
      };
    }
    return {
      title: "تقرير المخزون المنخفض",
      subtitle: `حد المخزون: ≤${threshold}`,
      columns: LOW_STOCK_COLUMNS,
      rows: lowStock,
      filename: "low-stock-report",
    };
  }, [tab, days, threshold, rows, lowStock]);

  const expiryColumns = useMemo(
    () => [
      { key: "name", header: "المنتج" },
      { key: "barcode", header: "الباركود" },
      { key: "unit", header: "الوحدة", render: (r) => r.unit || "—" },
      { key: "stock", header: "الكمية", className: "num" },
      { key: "expiry_date", header: "تاريخ الصلاحية" },
      {
        key: "days_until_expiry",
        header: "الأيام المتبقية",
        render: (r) =>
          r.days_until_expiry < 0 ? `منتهي (${r.days_until_expiry})` : r.days_until_expiry,
      },
    ],
    []
  );

  const lowStockColumns = useMemo(
    () => [
      { key: "name", header: "المنتج" },
      { key: "barcode", header: "الباركود" },
      { key: "category", header: "الفئة", render: (r) => r.category || "—" },
      { key: "unit", header: "الوحدة", render: (r) => r.unit || "—" },
      { key: "stock", header: "الكمية", className: "num" },
    ],
    []
  );

  const tabs = useMemo(
    () => [
      { id: "expiry", label: "تقرير الصلاحية" },
      { id: "lowstock", label: "المخزون المنخفض" },
    ],
    []
  );

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title="تقارير المخزون"
        subtitle="الصلاحية والمخزون المنخفض"
        icon="expiry"
        actions={
          <ReportToolbar
            title={reportConfig.title}
            subtitle={reportConfig.subtitle}
            columns={reportConfig.columns}
            rows={reportConfig.rows}
            filename={reportConfig.filename}
            disabled={loading}
          />
        }
      />

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === "expiry" && (
        <>
          <FilterBar
            actions={
              <Button onClick={loadExpiry} disabled={loading}>
                بحث
              </Button>
            }
          >
            <FormField label="الأيام القادمة">
              <Input
                type="number"
                min="1"
                max="365"
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              />
            </FormField>
          </FilterBar>

          <DataTable
            columns={expiryColumns}
            rows={rows}
            loading={loading}
            empty="لا توجد منتجات منتهية أو قاربت على الانتهاء في هذه الفترة"
            emptyIcon="expiry"
            rowClassName={(r) =>
              r.days_until_expiry < 0 ? "expired" : r.days_until_expiry <= 7 ? "expiring-soon" : ""
            }
          />
        </>
      )}

      {tab === "lowstock" && (
        <>
          <FilterBar
            actions={
              <Button onClick={loadLowStock} disabled={loading}>
                بحث
              </Button>
            }
          >
            <FormField label="حد المخزون المنخفض">
              <Input
                type="number"
                min="0"
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
            </FormField>
          </FilterBar>

          <DataTable
            columns={lowStockColumns}
            rows={lowStock}
            loading={loading}
            empty="لا توجد منتجات بمخزون منخفض"
            emptyIcon="inventory"
            rowClassName={(r) => (r.stock === 0 ? "out-of-stock" : "")}
          />
        </>
      )}
    </div>
  );
}
