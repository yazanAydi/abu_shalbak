import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api from "../apiClient";
import ProductPicker from "../components/ProductPicker";
import {
  PageHeader,
  Card,
  CardHeader,
  CardBody,
  StatCard,
  DataTable,
  FilterBar,
  FormField,
  DateField,
  SearchInput,
  ReportToolbar,
  PrimaryButton,
  SecondaryButton,
  EmptyState,
  HelpPanel,
  Notice,
  Skeleton,
  StatusPill,
  useToast,
} from "../components/ui";
import { apiErrorMessage } from "../utils/apiError";
import { ils } from "../utils/format";
import { getDatePresets, todayYmd, firstOfCurrentMonthYmd } from "../utils/reportDates";
import useAuthUser from "../hooks/useAuthUser";
import { userHasOfficePermission } from "../utils/accountantPermissions";
import {
  BAKERY_CLASSIFICATION_NOTE,
  bakeryExportColumns,
  bakeryPrintMeta,
  bakeryRevenueKindLabel,
  bakerySummaryItems,
  categoryOptionLabel,
  emptySelectedCatalogCopy,
  formatQtyByUnit,
  formatQtyWithUnit,
} from "./bakeryReportView";

function isPosAvailable(value) {
  return value === true || value === 1 || value === "1" || Number(value) === 1;
}

function isBakeryMaterial(product) {
  return String(product?.inventory_scope || "retail") === "bakery";
}

function sortMarker(activeSort, key, dir) {
  if (activeSort !== key) return "";
  return dir === "asc" ? " ↑" : " ↓";
}

export default function Bakery({ variant = "sales" }) {
  const toast = useToast();
  const user = useAuthUser();
  const presets = useMemo(() => getDatePresets(), []);
  const canEditProductCategories = userHasOfficePermission(user, "product_organization");
  const canManageCategories = userHasOfficePermission(user, "categories");

  const [from, setFrom] = useState(firstOfCurrentMonthYmd());
  const [to, setTo] = useState(todayYmd());
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [product, setProduct] = useState(null);
  const [sort, setSort] = useState("name");
  const [dir, setDir] = useState("asc");
  const [revenueKind, setRevenueKind] = useState("");

  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [savingCategories, setSavingCategories] = useState(false);
  const [err, setErr] = useState("");
  const [draftCategoryIds, setDraftCategoryIds] = useState([]);
  const [categoryEditorOpen, setCategoryEditorOpen] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const loadReport = useCallback(async () => {
    if (!from || !to) {
      setErr("حدد تاريخ البداية والنهاية");
      setLoading(false);
      return;
    }
    if (from > to) {
      setErr("تاريخ البداية يجب أن يسبق النهاية");
      setLoading(false);
      return;
    }
    setLoading(true);
    setErr("");
    try {
      const params = { from, to, sort, dir };
      if (product?.id) params.product_id = product.id;
      if (debouncedSearch) params.q = debouncedSearch;
      const { data } = await api.get("/api/reports/bakery", { params });
      setReport(data);
      setDraftCategoryIds((data.selected_categories || []).map((c) => Number(c.id)));
      if (data.needs_configuration || data.empty_selected_catalog) {
        setCategoryEditorOpen(true);
      }
    } catch (e) {
      setErr(apiErrorMessage(e, "تعذّر تحميل تقرير المخبز"));
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [from, to, product, debouncedSearch, sort, dir]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  function applyPreset(preset) {
    if (preset.mode === "day") {
      const date = preset.date || todayYmd();
      setFrom(date);
      setTo(date);
      return;
    }
    setFrom(preset.from || firstOfCurrentMonthYmd());
    setTo(preset.to || todayYmd());
  }

  const toggleSort = useCallback((key) => {
    if (sort === key) {
      setDir((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    setDir(key === "name" ? "asc" : "desc");
  }, [sort]);

  function toggleDraftCategory(id) {
    const num = Number(id);
    setDraftCategoryIds((prev) =>
      prev.includes(num) ? prev.filter((x) => x !== num) : [...prev, num]
    );
  }

  async function saveCategories() {
    if (!draftCategoryIds.length) {
      toast.error("اختر تصنيفاً واحداً على الأقل للمخبز");
      return;
    }
    setSavingCategories(true);
    try {
      await api.put("/api/reports/bakery/categories", { category_ids: draftCategoryIds });
      toast.success("تم حفظ تصنيفات المخبز");
      await loadReport();
    } catch (e) {
      toast.error(apiErrorMessage(e, "تعذّر حفظ التصنيفات"));
    } finally {
      setSavingCategories(false);
    }
  }

  function onPickProduct(picked) {
    const selected = new Set(
      (report?.selected_categories || []).map((c) => String(c.name || "").trim())
    );
    const inSelectedCategory = selected.has(String(picked?.category || "").trim());
    const materialSellable = isBakeryMaterial(picked) && isPosAvailable(picked?.pos_available);
    if (
      report &&
      !report.needs_configuration &&
      selected.size > 0 &&
      !inSelectedCategory &&
      !materialSellable
    ) {
      toast.error("هذا المنتج ليس ضمن أصناف البيع أو مواد المخبز المتاحة للكاشير");
      return;
    }
    setProduct(picked);
    setSearch("");
  }

  const isOverview = variant === "overview";
  const kpis = report?.kpis;
  const allRows = report?.products || [];
  const rows = revenueKind
    ? allRows.filter((r) => r.revenue_kind === revenueKind)
    : allRows;
  const needsConfig = Boolean(report?.needs_configuration);
  const emptyCatalog = Boolean(report?.empty_selected_catalog);
  const emptyCopy = emptyCatalog ? emptySelectedCatalogCopy(report) : null;
  const selectedNames = (report?.selected_categories || []).map((c) => c.name).join("، ");
  const uncategorizedCount = Number(report?.uncategorized_product_count) || 0;
  const membership = report?.membership;
  const alerts = report?.alerts;
  const bestSellers = [...rows]
    .filter((r) => Number(r.sold_quantity) > 0 || Number(r.net_revenue) > 0)
    .sort((a, b) => (Number(b.net_revenue) || 0) - (Number(a.net_revenue) || 0))
    .slice(0, 8);

  function renderCategoryOptions() {
    return (
      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        {(report?.available_categories || []).map((cat) => (
          <label key={cat.id} className="ui-checkbox-label">
            <input
              type="checkbox"
              checked={draftCategoryIds.includes(Number(cat.id))}
              onChange={() => toggleDraftCategory(cat.id)}
            />
            <span>
              {categoryOptionLabel(cat)}
              {Array.isArray(cat.sample_names) && cat.sample_names.length > 0 ? (
                <span className="muted"> — مثل: {cat.sample_names.join("، ")}</span>
              ) : null}
            </span>
          </label>
        ))}
        {uncategorizedCount > 0 ? (
          <p className="dashboard-meta-line muted" style={{ margin: 0 }}>
            منتجات بلا تصنيف: {uncategorizedCount} — لا تُحسب ضمن أي تصنيف حتى يُحفظ لها اسم تصنيف.
          </p>
        ) : null}
      </div>
    );
  }

  const tableColumns = useMemo(
    () => [
      { key: "name", header: "المنتج" },
      {
        key: "revenue_kind",
        header: "النوع",
        render: (r) => (
          <StatusPill tone={r.revenue_kind === "material" ? "orange" : "blue"} noDot>
            {bakeryRevenueKindLabel(r.revenue_kind)}
          </StatusPill>
        ),
      },
      { key: "barcode", header: "الباركود", render: (r) => r.barcode || "—" },
      { key: "unit", header: "الوحدة" },
      {
        key: "stock",
        header: (
          <button type="button" className="ui-table-sort" onClick={() => toggleSort("stock")}>
            المخزون الحالي{sortMarker(sort, "stock", dir)}
          </button>
        ),
        className: "num",
        render: (r) => formatQtyWithUnit(r.stock, r.unit),
      },
      {
        key: "sold_quantity",
        header: (
          <button type="button" className="ui-table-sort" onClick={() => toggleSort("sold_quantity")}>
            الكمية المباعة{sortMarker(sort, "sold_quantity", dir)}
          </button>
        ),
        className: "num",
        render: (r) => formatQtyWithUnit(r.sold_quantity, r.unit),
      },
      {
        key: "refunded_quantity",
        header: "الكمية المرتجعة",
        className: "num",
        render: (r) => formatQtyWithUnit(r.refunded_quantity, r.unit),
      },
      {
        key: "net_quantity",
        header: "صافي الكمية المباعة",
        className: "num",
        render: (r) => formatQtyWithUnit(r.net_quantity, r.unit),
      },
      {
        key: "net_revenue",
        header: (
          <button type="button" className="ui-table-sort" onClick={() => toggleSort("net_revenue")}>
            صافي المبيعات{sortMarker(sort, "net_revenue", dir)}
          </button>
        ),
        className: "num",
        render: (r) => ils(r.net_revenue),
      },
      { key: "invoice_count", header: "عدد الفواتير", className: "num" },
    ],
    [sort, dir, toggleSort]
  );

  const exportColumns = bakeryExportColumns();
  const summaryItems = bakerySummaryItems(kpis);

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title={isOverview ? "نظرة عامة — المخبز" : "مبيعات المخبز"}
        subtitle={
          isOverview
            ? "إيراد أصناف البيع وإيراد بيع المواد، مع تنبيهات المخزون الحالية"
            : "مبيعات أصناف البيع ومواد المخبز المتاحة للكاشير — بدون سجلات مالية إضافية"
        }
        icon="inventory"
        actions={
          <ReportToolbar
            title={isOverview ? "نظرة عامة — المخبز" : "مبيعات المخبز"}
            subtitle={
              product
                ? `المنتج: ${product.name}`
                : selectedNames
                  ? `التصنيفات: ${selectedNames}`
                  : undefined
            }
            columns={exportColumns}
            rows={isOverview ? bestSellers : rows}
            filename={isOverview ? "bakery-overview" : "bakery-report"}
            summary={summaryItems}
            meta={bakeryPrintMeta({ from, to, report })}
            disabled={loading || needsConfig}
          />
        }
      />

      {needsConfig ? (
        <Card className="ui-mt-md">
          <CardHeader title="اختر تصنيفات المخبز" />
          <CardBody>
            <p className="dashboard-meta-line muted">
              لا يمكن تحديد تصنيف المخبز تلقائياً. الأرقام بجانب كل تصنيف هي عدد المنتجات ذات
              التصنيف الحالي المطابق — دون تخمين من الاسم أو من مواد المخبز.
            </p>
            {renderCategoryOptions()}
            <div style={{ marginTop: 16 }}>
              <PrimaryButton type="button" onClick={saveCategories} disabled={savingCategories}>
                {savingCategories ? "جاري الحفظ…" : "حفظ التصنيفات"}
              </PrimaryButton>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {!needsConfig && (report?.available_categories || []).length > 0 ? (
        <Card className="ui-mt-md">
          <CardBody>
            <p className="dashboard-meta-line" style={{ marginTop: 0 }}>
              تصنيفات المخبز: <strong>{selectedNames || "—"}</strong>
            </p>
            <details
              className="ui-help-panel"
              open={categoryEditorOpen}
              onToggle={(e) => setCategoryEditorOpen(e.currentTarget.open)}
            >
              <summary>تغيير التصنيفات</summary>
              {renderCategoryOptions()}
              <div style={{ marginTop: 12 }}>
                <SecondaryButton type="button" onClick={saveCategories} disabled={savingCategories}>
                  {savingCategories ? "جاري الحفظ…" : "حفظ التصنيفات"}
                </SecondaryButton>
              </div>
            </details>
          </CardBody>
        </Card>
      ) : null}

      <FilterBar
        className="ui-mt-md"
        actions={
          <>
            {presets.map((p) => (
              <SecondaryButton key={p.id} type="button" onClick={() => applyPreset(p)}>
                {p.label}
              </SecondaryButton>
            ))}
            <PrimaryButton type="button" onClick={loadReport} disabled={loading}>
              {loading ? "جاري التحميل…" : "تحديث"}
            </PrimaryButton>
          </>
        }
      >
        <FormField label="من تاريخ">
          <DateField value={from} onChange={(e) => setFrom(e.target.value)} />
        </FormField>
        <FormField label="إلى تاريخ">
          <DateField value={to} onChange={(e) => setTo(e.target.value)} />
        </FormField>
        {isOverview ? null : (
          <>
        <FormField label="بحث بالاسم أو الباركود" className="ui-field--full">
          <SearchInput
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              if (e.target.value) setProduct(null);
            }}
            placeholder="اسم المنتج أو الباركود…"
          />
        </FormField>
        <FormField label="اختيار منتج" className="ui-field--full">
          <ProductPicker
            onPick={onPickProduct}
            scope={null}
            membership="bakery"
            kind="sales"
            placeholder="ابحث عن صنف بيع أو مادة متاحة للكاشير…"
          />
          {product ? (
            <span className="ui-field__hint">
              المحدد: <strong>{product.name}</strong>
              {" "}
              <button
                type="button"
                className="dashboard-inline-link"
                onClick={() => setProduct(null)}
              >
                كل أصناف المخبز
              </button>
            </span>
          ) : (
            <span className="ui-field__hint">الافتراضي: أصناف البيع ومواد المخبز المتاحة للكاشير</span>
          )}
        </FormField>
          </>
        )}
      </FilterBar>

      {err ? <EmptyState title={err} className="ui-mt-md" /> : null}

      {loading ? (
        <div className="ui-mt-md">
          <Skeleton style={{ height: 120, marginBottom: 16 }} />
          <Skeleton style={{ height: 240 }} />
        </div>
      ) : null}

      {!loading && !err && report ? (
        <>
          <Notice tone="info">
            التصنيف حسب تصنيف المنتج الحالي — تغييره يغيّر النتائج
          </Notice>
          <HelpPanel title="طريقة الحساب">
            <p>{report.stock_note}. {report.classification_note || BAKERY_CLASSIFICATION_NOTE}</p>
            <p>
              {report.classification?.sales_rule
                || "أصناف البيع من تصنيفات المخبز. بيع المواد يُحسب فقط إذا أُتيحت للكاشير، دون اشتراط تصنيف بيع."}
            </p>
            {report.invoice_count_note ? <p>{report.invoice_count_note}</p> : null}
          </HelpPanel>

          {membership ? (
            <Card className="ui-mt-md">
              <CardHeader title="تصنيف أصناف المخبز" />
              <CardBody>
                <p className="dashboard-meta-line" style={{ marginTop: 0 }}>
                  مواد: <strong>{membership.materials_count}</strong>
                  {" · "}
                  أصناف بيع: <strong>{membership.finished_count}</strong>
                  {" · "}
                  مؤهلة للمبيعات: <strong>{membership.sales_eligible_count}</strong>
                </p>
                <p className="dashboard-meta-line muted">{membership.rules?.materials}</p>
                <p className="dashboard-meta-line muted">{membership.rules?.sales}</p>
                {Number(membership.overlap_count) > 0 ? (
                  <Notice tone="warning">
                    {membership.overlap_count} صنفاً مادة ومصنّفة ضمن تصنيفات البيع في الوقت نفسه
                    {Array.isArray(membership.overlap_samples) && membership.overlap_samples.length
                      ? ` — مثل: ${membership.overlap_samples.map((s) => s.name).join("، ")}`
                      : ""}
                    . لم يُغيَّر التصنيف تلقائياً.
                  </Notice>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          <div className="ui-stat-grid ui-mt-md">
            <StatCard label="إيرادات المخبز" value={ils(kpis?.net_revenue)} icon="finance" tone="green" />
            <StatCard
              label="إيراد أصناف البيع"
              value={ils(kpis?.finished_net_revenue)}
              icon="products"
            />
            <StatCard
              label="إيراد بيع المواد"
              value={ils(kpis?.material_net_revenue)}
              icon="inventory"
              tone="orange"
            />
            <StatCard
              label="الكمية المباعة"
              value={formatQtyByUnit(kpis?.sold_quantity_by_unit)}
              icon="inventory"
            />
            <StatCard
              label="الكمية المرتجعة"
              value={formatQtyByUnit(kpis?.refunded_quantity_by_unit)}
              icon="refunds"
              tone="orange"
            />
            <StatCard
              label="صافي الكمية المباعة"
              value={formatQtyByUnit(kpis?.net_quantity_by_unit)}
              icon="products"
            />
            <StatCard
              label="عدد الفواتير"
              value={String(kpis?.invoice_count ?? 0)}
              icon="finance"
              hint="فواتير مكتملة تحتوي صنفاً من المخبز"
            />
          </div>

          <div className="ui-filter-bar__actions ui-mt-md" style={{ justifyContent: "flex-start", gap: 8 }}>
            {[
              { id: "", label: "الكل" },
              { id: "finished", label: "أصناف البيع" },
              { id: "material", label: "بيع المواد" },
            ].map((chip) => {
              const ChipButton = revenueKind === chip.id ? PrimaryButton : SecondaryButton;
              return (
                <ChipButton key={chip.id || "all"} type="button" onClick={() => setRevenueKind(chip.id)}>
                  {chip.label}
                </ChipButton>
              );
            })}
          </div>

          {isOverview && alerts ? (
            <div className="ui-stat-grid ui-mt-md">
              <Card>
                <CardHeader title="تنبيه مخزون" />
                <CardBody>
                  <p className="ui-field__hint">المخزون الحالي — لا يتأثر بفترة المبيعات</p>
                  {(alerts.low_stock || []).length === 0 ? (
                    <p className="dashboard-meta-line muted">لا يوجد تنبيه مخزون حالياً</p>
                  ) : (
                    <ul className="dashboard-meta-line">
                      {alerts.low_stock.map((row) => (
                        <li key={row.id}>{row.name} — {row.stock}</li>
                      ))}
                    </ul>
                  )}
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="تنبيه صلاحية" />
                <CardBody>
                  <p className="ui-field__hint">خلال {alerts.expiry_days} يوماً</p>
                  {(alerts.expiry || []).length === 0 && (alerts.batches || []).length === 0 ? (
                    <p className="dashboard-meta-line muted">لا توجد صلاحيات قريبة</p>
                  ) : (
                    <ul className="dashboard-meta-line">
                      {(alerts.expiry || []).map((row) => (
                        <li key={`p-${row.id}`}>{row.name} — {row.expiry_date}</li>
                      ))}
                      {(alerts.batches || []).map((row) => (
                        <li key={`b-${row.id}`}>{row.product_name} — {row.expiry_date}</li>
                      ))}
                    </ul>
                  )}
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="مخزون سالب" />
                <CardBody>
                  {(alerts.negative_stock || []).length === 0 ? (
                    <p className="dashboard-meta-line muted">لا يوجد مخزون سالب</p>
                  ) : (
                    <ul className="dashboard-meta-line">
                      {alerts.negative_stock.map((row) => (
                        <li key={row.id}>{row.name} — {row.stock}</li>
                      ))}
                    </ul>
                  )}
                </CardBody>
              </Card>
            </div>
          ) : null}

          {emptyCatalog && emptyCopy && !needsConfig ? (
            <EmptyState
              className="ui-mt-md"
              icon="inventory"
              title={emptyCopy.title}
              hint={emptyCopy.hint}
              action={
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
                  <SecondaryButton type="button" onClick={() => setCategoryEditorOpen(true)}>
                    تغيير تصنيفات التقرير
                  </SecondaryButton>
                  {canEditProductCategories ? (
                    <Link to="/product-organization" className="dashboard-inline-link">
                      تنظيم المنتجات
                    </Link>
                  ) : null}
                  {canManageCategories ? (
                    <Link to="/categories" className="dashboard-inline-link">
                      التصنيفات
                    </Link>
                  ) : null}
                </div>
              }
            />
          ) : (
            <Card className="ui-mt-md">
              <CardHeader title={isOverview ? "الأكثر مبيعاً" : "أصناف المخبز"} />
              <CardBody>
                <DataTable
                  columns={tableColumns}
                  rows={isOverview ? bestSellers : rows}
                  rowKey={(r) => r.product_id}
                  rowClassName={(r) => (Number(r.stock) < 0 ? "negative" : undefined)}
                  empty={isOverview ? "لا مبيعات في الفترة المختارة" : "لا توجد أصناف مطابقة للبحث أو التصفية"}
                  emptyIcon="inventory"
                />
              </CardBody>
            </Card>
          )}
        </>
      ) : null}
    </div>
  );
}
