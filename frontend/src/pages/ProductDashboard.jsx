import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import api from "../apiClient";
import {
  Tabs,
  StatCard,
  StatusBadge,
  PrimaryButton,
  SecondaryButton,
  Icon,
  SkeletonRows,
  Card,
  CardBody,
} from "../components/ui";
import { ils, num } from "../utils/format";
import ChangePriceModal from "./productDashboard/ChangePriceModal";
import EditProductModal from "./productDashboard/EditProductModal";
import OverviewTab from "./productDashboard/OverviewTab";
import SuppliersTab from "./productDashboard/SuppliersTab";
import PriceHistoryTab from "./productDashboard/PriceHistoryTab";
import SalesByPriceTab from "./productDashboard/SalesByPriceTab";
import PurchaseHistoryTab from "./productDashboard/PurchaseHistoryTab";
import InventoryHistoryTab from "./productDashboard/InventoryHistoryTab";
import ProfitAnalysisTab from "./productDashboard/ProfitAnalysisTab";
import BatchesTab from "./productDashboard/BatchesTab";
import AuditLogTab from "./productDashboard/AuditLogTab";
import "./ProductDashboard.css";

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
      setError(e.response?.data?.error || e.message || "تعذّر تحميل المنتج");
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

  function refreshAfterProductChange() {
    loadHeader();
    setVisited(new Set([active]));
    setVersion((v) => v + 1);
  }

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
    return [
      { label: "المخزون الحالي", value: num(s.current_stock, 0), icon: "inventory", tone: "teal" },
      { label: "مبيعات اليوم", value: ils(s.today_sales), icon: "finance", tone: "green" },
      { label: "مبيعات هذا الشهر", value: ils(s.month_sales), icon: "finance", tone: "green" },
      { label: "سعر البيع الحالي", value: ils(s.current_price), icon: "finance", tone: "teal" },
      { label: "متوسط تكلفة الشراء", value: ils(s.average_cost), icon: "purchases", tone: "orange" },
      { label: "ربح إجمالي تقديري", value: ils(s.estimated_gross_profit), icon: "finance", tone: "teal" },
      { label: "عدد الموردين", value: String(s.supplier_count), icon: "suppliers", tone: "teal" },
      { label: "عدد تغييرات السعر", value: String(s.price_changes), icon: "finance", tone: "orange" },
      { label: "قيمة المخزون", value: ils(s.inventory_value), icon: "warehouses", tone: "teal" },
    ];
  }, [s]);

  function renderTab(tabId) {
    const key = `${tabId}-${version}`;
    switch (tabId) {
      case "overview": return <OverviewTab key={key} productId={id} />;
      case "suppliers": return <SuppliersTab key={key} productId={id} />;
      case "price-history": return <PriceHistoryTab key={key} productId={id} />;
      case "sales": return <SalesByPriceTab key={key} productId={id} />;
      case "purchases": return <PurchaseHistoryTab key={key} productId={id} />;
      case "inventory": return <InventoryHistoryTab key={key} productId={id} />;
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
                باركود: {product?.barcode}
                {product?.barcode_count > 1 ? ` (+${product.barcode_count - 1})` : ""}
              </span>
              <span className="pd-chip">الرقم: {product?.sku || "—"}</span>
              {product?.category ? <span className="pd-chip">التصنيف: {product.category}</span> : null}
              {product?.unit ? <span className="pd-chip">الوحدة: {product.unit}</span> : null}
            </div>
            <div className="pd-keyfigures">
              <div className="pd-kf"><span>المخزون</span><strong>{num(product?.stock, 0)}</strong></div>
              <div className="pd-kf"><span>سعر البيع</span><strong>{ils(product?.price)}</strong></div>
              <div className="pd-kf"><span>آخر تكلفة شراء</span><strong>{s?.last_purchase_cost != null ? ils(s.last_purchase_cost) : "—"}</strong></div>
              <div className="pd-kf"><span>متوسط التكلفة</span><strong>{ils(product?.cost)}</strong></div>
              <div className="pd-kf"><span>هامش الربح</span><strong>{num(s?.profit_margin_pct)}%</strong></div>
            </div>
          </div>
        </div>

        <div className="pd-actions">
          <PrimaryButton type="button" onClick={() => setPriceOpen(true)}>
            <Icon name="finance" size={16} /> تغيير سعر البيع
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
            {renderTab(t.id)}
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
