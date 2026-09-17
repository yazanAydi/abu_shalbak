import { apiErrorMessage } from "../utils/apiError";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import api from "../apiClient";
import {
  Tabs,
  StatCard,
  StatusBadge,
  PrimaryButton,
  SecondaryButton,
  PageRefreshButton,
  Icon,
  SkeletonRows,
  Card,
  CardBody,
} from "../components/ui";
import { useRegisterPageRefresh, usePageRefresh } from "../components/layout/PageRefreshContext";
import { ils, num, formatStockWithUnit } from "../utils/format";
import { displayProductBarcode, displayProductSku } from "../utils/entityCodeDisplay";
import { NO_UNIT_LABEL, UNCATEGORIZED_LABEL } from "../utils/productCatalogLabels";
import ChangePriceModal from "./productDashboard/ChangePriceModal";
import EditProductModal from "./productDashboard/EditProductModal";
import "./ProductDashboard.css";

// Tabs are only mounted once visited (see the `visited` set below), so loading
// them lazily costs nothing and keeps recharts — pulled in by price-history,
// sales and profit — out of this page's initial chunk.
const OverviewTab = lazy(() => import("./productDashboard/OverviewTab"));
const SuppliersTab = lazy(() => import("./productDashboard/SuppliersTab"));
const PriceHistoryTab = lazy(() => import("./productDashboard/PriceHistoryTab"));
const SalesByPriceTab = lazy(() => import("./productDashboard/SalesByPriceTab"));
const PurchaseHistoryTab = lazy(() => import("./productDashboard/PurchaseHistoryTab"));
const InventoryHistoryTab = lazy(() => import("./productDashboard/InventoryHistoryTab"));
const ProfitAnalysisTab = lazy(() => import("./productDashboard/ProfitAnalysisTab"));
const BatchesTab = lazy(() => import("./productDashboard/BatchesTab"));
const AuditLogTab = lazy(() => import("./productDashboard/AuditLogTab"));

const TABS = [
  { id: "overview", label: "نظرة عامة", icon: "dashboard" },
  { id: "suppliers", label: "أسعار الموردين", icon: "suppliers" },
  { id: "price-history", label: "سجل أسعار البيع", icon: "finance" },
  { id: "sales", label: "المبيعات حسب السعر", icon: "finance" },
  { id: "purchases", label: "سجل المشتريات", icon: "purchases" },
  { id: "inventory", label: "حركة المخزون", icon: "inventory" },
  { id: "profit", label: "تحليل الأرباح", icon: "finance" },
  { id: "batches", label: "الصلاحية والدفعات", icon: "expiry" },
  { id: "audit", label: "سجل العمليات", icon: "shifts" },
];

function initials(name) {
  const s = String(name || "").trim();
  if (!s) return "؟";
  const parts = s.split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]).join("");
}

export default function ProductDashboard() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [dash, setDash] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [active, setActive] = useState("overview");
  const [visited, setVisited] = useState(() => new Set(["overview"]));
  const [version, setVersion] = useState(0);
  const [priceOpen, setPriceOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const loadHeader = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/api/products/${id}/dashboard`);
      setDash(data);
      setError(null);
    } catch (e) {
      setError(apiErrorMessage(e, "تعذّر تحميل المنتج"));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadHeader();
  }, [loadHeader]);

  function onTabChange(tabId) {
    setActive(tabId);
    setVisited((v) => {
      const next = new Set(v);
      next.add(tabId);
      return next;
    });
  }

  const refreshAfterProductChange = useCallback(() => {
    loadHeader();
    setVisited(new Set([active]));
    setVersion((v) => v + 1);
  }, [loadHeader, active]);

  useRegisterPageRefresh(refreshAfterProductChange);
  const { refreshPage, refreshing } = usePageRefresh();

  function handlePriceSaved() {
    refreshAfterProductChange();
  }

  function handleProductSaved() {
    refreshAfterProductChange();
  }

  const product = dash?.product;
  const s = dash?.summary;

  const summaryCards = useMemo(() => {
    if (!s) return [];
    const weighed = Number(product?.is_weighed) === 1;
    const cards = [
      { label: "المخزون الحالي", value: formatStockWithUnit(s.current_stock, product), icon: "inventory", tone: "teal" },
      { label: "مبيعات اليوم", value: ils(s.today_sales), icon: "finance", tone: "green" },
      { label: "مبيعات هذا الشهر", value: ils(s.month_sales), icon: "finance", tone: "green" },
      { label: weighed ? "سعر الكغم" : "سعر البيع الحالي", value: ils(s.current_price), icon: "finance", tone: "teal" },
    ];
    if (weighed && product?.package_price != null) {
      cards.push({ label: "سعر الحبة", value: ils(product.package_price), icon: "finance", tone: "teal" });
    }
    cards.push(
      { label: "متوسط تكلفة الشراء", value: ils(s.average_cost), icon: "purchases", tone: "orange" },
      { label: "ربح إجمالي تقديري", value: ils(s.estimated_gross_profit), icon: "finance", tone: "teal" },
      { label: "عدد الموردين", value: String(s.supplier_count), icon: "suppliers", tone: "teal" },
      { label: "عدد تغييرات السعر", value: String(s.price_changes), icon: "finance", tone: "orange" },
      { label: "قيمة المخزون", value: ils(s.inventory_value), icon: "warehouses", tone: "teal" },
    );
    return cards;
  }, [s, product]);

  function renderTab(tabId) {
    const key = `${tabId}-${version}`;
    switch (tabId) {
      case "overview": return <OverviewTab key={key} productId={id} />;
      case "suppliers": return <SuppliersTab key={key} productId={id} />;
      case "price-history": return <PriceHistoryTab key={key} productId={id} />;
      case "sales": return <SalesByPriceTab key={key} productId={id} />;
      case "purchases": return <PurchaseHistoryTab key={key} productId={id} />;
      case "inventory": return <InventoryHistoryTab key={key} productId={id} weighed={Number(product?.is_weighed) === 1} />;
      case "profit": return <ProfitAnalysisTab key={key} productId={id} />;
      case "batches": return <BatchesTab key={key} productId={id} />;
      case "audit": return <AuditLogTab key={key} productId={id} />;
      default: return null;
    }
  }

  if (loading && !dash) {
    return (
      <div className="office-page" dir="rtl" lang="ar">
        <SkeletonRows rows={8} cols={3} />
      </div>
    );
  }

  if (error && !dash) {
    return (
      <div className="office-page" dir="rtl" lang="ar">
        <Card>
          <CardBody>
            <p className="ui-text-danger">{error}</p>
            <SecondaryButton type="button" onClick={() => navigate("/manage-products")}>
              العودة إلى المنتجات
            </SecondaryButton>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="office-page pd-page" dir="rtl" lang="ar">
      {/* Sticky header */}
      <div className="pd-header">
        <div className="pd-header-main">
          <div className="pd-avatar">
            {product?.image_url ? (
              <img src={product.image_url} alt={product.name} />
            ) : (
              <span>{initials(product?.name)}</span>
            )}
          </div>
          <div className="pd-header-info">
            <div className="pd-header-top">
              <h1 className="pd-title">{product?.name}</h1>
              <StatusBadge tone={product?.is_active ? "green" : "neutral"} noDot>
                {product?.is_active ? "نشط" : "غير نشط"}
              </StatusBadge>
            </div>
            <div className="pd-chips">
              <span className="pd-chip">
                باركود: {displayProductBarcode(product)}
                {product?.barcode_count > 1 ? ` (+${product.barcode_count - 1})` : ""}
              </span>
              <span className="pd-chip">الرقم: {displayProductSku(product?.sku)}</span>
              <span className="pd-chip">التصنيف: {product?.category || UNCATEGORIZED_LABEL}</span>
              <span className="pd-chip">الوحدة: {product?.unit || NO_UNIT_LABEL}</span>
              {product?.scale_code ? <span className="pd-chip">رمز الميزان: {product.scale_code}</span> : null}
              {Number(product?.is_weighed) === 1 && product?.package_conversion != null ? (
                <span className="pd-chip">وزن الحبة: {product.package_conversion} كغم</span>
              ) : null}
              {Number(product?.is_weighed) === 1 ? <span className="pd-chip">يُباع بالوزن (ميزان)</span> : null}
            </div>
            <div className="pd-keyfigures">
              <div className="pd-kf"><span>المخزون</span><strong>{formatStockWithUnit(product?.stock, product)}</strong></div>
              {Number(product?.is_weighed) === 1 ? (
                <>
                  <div className="pd-kf"><span>سعر الكغم</span><strong>{ils(product?.price)}</strong></div>
                  {product?.package_price != null ? (
                    <div className="pd-kf"><span>سعر الحبة</span><strong>{ils(product.package_price)}</strong></div>
                  ) : null}
                </>
              ) : (
                <div className="pd-kf"><span>سعر البيع</span><strong>{ils(product?.price)}</strong></div>
              )}
              <div className="pd-kf"><span>آخر تكلفة شراء</span><strong>{s?.last_purchase_cost != null ? ils(s.last_purchase_cost) : "—"}</strong></div>
              <div className="pd-kf"><span>متوسط التكلفة</span><strong>{ils(product?.cost)}</strong></div>
              <div className="pd-kf"><span>هامش الربح</span><strong>{num(s?.profit_margin_pct)}%</strong></div>
            </div>
          </div>
        </div>

        <div className="pd-actions">
          <PageRefreshButton onClick={refreshPage} refreshing={loading || refreshing} />
          <PrimaryButton type="button" onClick={() => setPriceOpen(true)}>
            <Icon name="finance" size={16} /> {Number(product?.is_weighed) === 1 ? "تغيير سعر الكغم" : "تغيير سعر البيع"}
          </PrimaryButton>
          <SecondaryButton type="button" onClick={() => setEditOpen(true)}>
            <Icon name="edit" size={16} /> تعديل المنتج
          </SecondaryButton>
          <SecondaryButton type="button" onClick={() => navigate("/purchases")}>
            <Icon name="purchases" size={16} /> استلام بضاعة
          </SecondaryButton>
          <SecondaryButton type="button" onClick={() => navigate("/inventory")}>
            <Icon name="inventory" size={16} /> تسوية مخزون
          </SecondaryButton>
          <SecondaryButton type="button" onClick={() => window.print()}>
            <Icon name="print" size={16} /> طباعة باركود
          </SecondaryButton>
          <SecondaryButton type="button" onClick={() => onTabChange("purchases")}>
            <Icon name="vouchers" size={16} /> سجل المشتريات
          </SecondaryButton>
        </div>
      </div>

      {/* Sticky summary cards */}
      <div className="pd-summary ui-stat-grid">
        {summaryCards.map((c) => (
          <StatCard key={c.label} label={c.label} value={c.value} icon={c.icon} tone={c.tone} />
        ))}
      </div>

      {/* Tabs */}
      <div className="pd-tabs-wrap">
        <Tabs tabs={TABS} active={active} onChange={onTabChange} />
      </div>

      <div className="pd-tab-content">
        {TABS.filter((t) => visited.has(t.id)).map((t) => (
          <div key={t.id} hidden={active !== t.id}>
            <Suspense fallback={<SkeletonRows rows={6} cols={3} />}>
              {renderTab(t.id)}
            </Suspense>
          </div>
        ))}
      </div>

      <ChangePriceModal
        open={priceOpen}
        onClose={() => setPriceOpen(false)}
        product={product}
        onSaved={handlePriceSaved}
      />
      <EditProductModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        product={product}
        onSaved={handleProductSaved}
      />
    </div>
  );
}
