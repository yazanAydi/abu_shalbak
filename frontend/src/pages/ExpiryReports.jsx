import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import api from "../apiClient";
import { apiErrorMessage } from "../utils/apiError";
import { getAuthHeaders } from "../utils/auth";
import {
  PageHeader,
  ReportToolbar,
  Tabs,
  FilterBar,
  DataTable,
  Button,
  FormField,
  Input,
  Modal,
  useToast,
} from "../components/ui";
import { Batches } from "./Inventory";
import { dateOnly, qty as fmtQty } from "../utils/format";
import { batchSourceLabel } from "../utils/stockBatchLabels";

function expirySourceLabel(row) {
  if (row.source === "batch") return row.batch_no ? `دفعة ${row.batch_no}` : "دفعة";
  return "صلاحية الصنف";
}

function supplierExportText(row) {
  const label = row.supplier_label || "غير معروف";
  if (label !== "عدة موردين") return label;
  const parts = (row.suppliers || []).map((item) => `${item.supplier_name} ${fmtQty(item.quantity)}`);
  return parts.length ? `عدة موردين (${parts.join("، ")})` : "عدة موردين";
}

function SupplierCell({ row }) {
  const lines = row.suppliers || [];
  if (lines.length <= 1) return row.supplier_label || "غير معروف";
  return (
    <details>
      <summary>{row.supplier_label || "عدة موردين"}</summary>
      {lines.map((item) => (
        <div key={`${item.supplier_id || "unknown"}-${item.quantity}`}>
          {item.supplier_name}: {fmtQty(item.quantity)}
        </div>
      ))}
    </details>
  );
}

const EXPIRY_COLUMNS = [
  { key: "name", header: "المنتج" },
  { key: "barcode", header: "الباركود" },
  { key: "source", header: "مصدر الصلاحية", value: (r) => expirySourceLabel(r) },
  { key: "supplier", header: "المورد", value: (r) => supplierExportText(r) },
  { key: "unit", header: "الوحدة", value: (r) => r.unit || "—" },
  { key: "stock", header: "الكمية" },
  { key: "expiry_date", header: "تاريخ الصلاحية", value: (r) => dateOnly(r.expiry_date) },
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

export default function ExpiryReports({ workspace = null }) {
  const isBakery = workspace === "bakery";
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const [rows, setRows] = useState([]);
  const [lowStock, setLowStock] = useState([]);
  const [days, setDays] = useState(30);
  const [threshold, setThreshold] = useState(LOW_STOCK_THRESHOLD);
  const [loading, setLoading] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveRows, setMoveRows] = useState([]);
  const [moving, setMoving] = useState(false);
  const [tab, setTab] = useState(() => {
    if (searchParams.get("tab") === "lowstock") return "lowstock";
    if (searchParams.get("tab") === "batches") return "batches";
    return "expiry";
  });

  useEffect(() => {
    if (searchParams.get("tab") === "lowstock") setTab("lowstock");
    const t = Number(searchParams.get("threshold"));
    if (Number.isFinite(t) && t >= 0) setThreshold(t);
  }, [searchParams]);

  const loadExpiry = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/api/inventory/expiry?days=${days}${isBakery ? "&membership=bakery" : ""}`);
      setRows(data);
    } catch {
      toast.error("تعذّر تحميل تقرير الصلاحية");
    } finally {
      setLoading(false);
    }
  }, [days, toast, isBakery]);

  const loadLowStock = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/api/inventory/low-stock?threshold=${threshold}${isBakery ? "&membership=bakery" : ""}`);
      setLowStock(data);
    } catch {
      toast.error("تعذّر تحميل تقرير المخزون المنخفض");
    } finally {
      setLoading(false);
    }
  }, [threshold, toast, isBakery]);

  useEffect(() => {
    if (tab === "expiry") loadExpiry();
    else if (tab === "lowstock") loadLowStock();
  }, [tab, loadExpiry, loadLowStock]);

  async function openExpiredMove() {
    setMoving(true);
    try {
      const { data } = await api.get("/api/warehouses/expired-on-main", { headers: getAuthHeaders() });
      const list = (Array.isArray(data) ? data : []).map((row) => ({
        ...row,
        selected: true,
        move_qty: row.quantity,
      }));
      setMoveRows(list);
      setMoveOpen(true);
    } catch (err) {
      toast.error(apiErrorMessage(err, "تعذّر تحميل الكميات المنتهية"));
    } finally {
      setMoving(false);
    }
  }

  async function postExpiredMove() {
    const chosen = moveRows.filter((row) => row.selected && Number(row.move_qty) > 0);
    if (chosen.length === 0) {
      toast.error("اختر كمية للنقل");
      return;
    }
    setMoving(true);
    try {
      await api.post("/api/warehouses/transfers/expired", {
        items: chosen.map((row) => ({
          product_id: row.product_id,
          quantity: Number(row.move_qty),
          batch_source: row.batch_source || "dated",
          expiry_date: row.batch_source === "undated" ? undefined : row.expiry_date,
          source_lot_id: row.source_lot_id || undefined,
        })),
      }, { headers: getAuthHeaders() });
      toast.success("نُقل المنتهي إلى مرتجعات");
      setMoveOpen(false);
      loadExpiry();
    } catch (err) {
      toast.error(apiErrorMessage(err, "تعذّر النقل"));
    } finally {
      setMoving(false);
    }
  }

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
      { key: "source", header: "مصدر الصلاحية", render: (r) => expirySourceLabel(r) },
      { key: "supplier", header: "المورد", render: (r) => <SupplierCell row={r} /> },
      { key: "unit", header: "الوحدة", render: (r) => r.unit || "—" },
      { key: "stock", header: "الكمية", className: "num" },
      { key: "expiry_date", header: "تاريخ الصلاحية", render: (r) => dateOnly(r.expiry_date) },
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
      { id: "batches", label: "التشغيلات" },
      ...(!isBakery ? [{ id: "lowstock", label: "المخزون المنخفض" }] : []),
    ],
    [isBakery]
  );

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title={isBakery ? "صلاحيات وتشغيلات المخبز" : "تقارير المخزون"}
        subtitle={isBakery ? "تواريخ الصلاحية ودفعات أصناف المخبز والمواد" : "الصلاحية والمخزون المنخفض"}
        icon="expiry"
        actions={
          tab === "batches" ? null : (
          <ReportToolbar
            title={reportConfig.title}
            subtitle={reportConfig.subtitle}
            columns={reportConfig.columns}
            rows={reportConfig.rows}
            filename={reportConfig.filename}
            disabled={loading}
          />
          )
        }
      />

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === "expiry" && (
        <>
          <FilterBar
            actions={
              <>
                <Button onClick={loadExpiry} disabled={loading}>
                  بحث
                </Button>
                <Button variant="outline" onClick={openExpiredMove} disabled={loading || moving}>
                  نقل المنتهي إلى مرتجعات
                </Button>
              </>
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
            rowKey={(r, i) => r.row_key ?? r.id ?? i}
            loading={loading}
            empty="لا توجد منتجات منتهية أو قاربت على الانتهاء في هذه الفترة"
            emptyIcon="expiry"
            rowClassName={(r) =>
              r.days_until_expiry < 0 ? "expired" : r.days_until_expiry <= 7 ? "expiring-soon" : ""
            }
          />
        </>
      )}

      <Modal
        open={moveOpen}
        title="نقل المنتهي إلى مرتجعات"
        onClose={() => setMoveOpen(false)}
        size="lg"
        footer={(
          <>
            <Button onClick={postExpiredMove} disabled={moving}>ترحيل النقل</Button>
            <Button variant="secondary" onClick={() => setMoveOpen(false)}>إلغاء</Button>
          </>
        )}
      >
        <p>اعزل البضاعة المنتهية عن رف البيع، ثم اختر الكميات الموجودة في المخزن الرئيسي.</p>
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead>
              <tr>
                <th></th>
                <th>الصنف</th>
                <th>الصلاحية</th>
                <th>المتبقي</th>
                <th>الكمية</th>
              </tr>
            </thead>
            <tbody>
              {moveRows.length === 0 && (
                <tr><td colSpan={5} style={{ textAlign: "center", padding: "1rem" }}>لا توجد كمية منتهية في المخزن الرئيسي</td></tr>
              )}
              {moveRows.map((row, index) => (
                <tr key={`${row.product_id}-${row.batch_source}-${row.expiry_date}`}>
                  <td>
                    <input
                      type="checkbox"
                      checked={row.selected}
                      onChange={(e) => setMoveRows((prev) => prev.map((item, i) => i === index ? { ...item, selected: e.target.checked } : item))}
                    />
                  </td>
                  <td>{row.name}</td>
                  <td>{batchSourceLabel(row.batch_source === "undated" ? "undated" : "dated", row.expiry_date)}</td>
                  <td>{fmtQty(row.quantity)}</td>
                  <td>
                    <Input
                      type="number"
                      min="0"
                      step="0.001"
                      value={row.move_qty}
                      onChange={(e) => setMoveRows((prev) => prev.map((item, i) => i === index ? { ...item, move_qty: e.target.value } : item))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>

      {tab === "batches" && <Batches membership={isBakery ? "bakery" : null} />}

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
