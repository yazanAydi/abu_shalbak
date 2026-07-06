import { useCallback, useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import api from "../../apiClient";
import { getAuthHeaders, getUser } from "../../utils/auth";
import { isAdminRole } from "../../utils/roles";
import { OFFICE_NAV } from "./officeNavConfig";
import Icon from "../icons/Icon";

const LOW_STOCK_THRESHOLD = 5;
const LOW_STOCK_RAIL_LIMIT = 10;

const QUICK_PATHS = [
  "/reports",
  "/manage-products",
  "/sales-by-price",
  "/finance",
  "/inventory",
  "/expiry",
  "/shift-audit",
];

export default function OfficeSideRail() {
  const user = getUser();
  const role = user?.role || "";
  const quickLinks = OFFICE_NAV.filter(
    (item) => item.visible(role) && QUICK_PATHS.includes(item.path)
  );

  const [lowStock, setLowStock] = useState([]);
  const [lowStockTotal, setLowStockTotal] = useState(0);
  const [loadingStock, setLoadingStock] = useState(true);

  const loadLowStock = useCallback(async () => {
    setLoadingStock(true);
    try {
      const { data } = await api.get(
        `/api/reports/low-stock?threshold=${LOW_STOCK_THRESHOLD}&limit=${LOW_STOCK_RAIL_LIMIT}`,
        { headers: getAuthHeaders() }
      );
      const payload = data;
      const products = Array.isArray(payload?.products)
        ? payload.products
        : Array.isArray(payload)
          ? payload
          : [];
      const apiTotal = Number(payload?.total_count);
      const hasApiTotal =
        payload && typeof payload === "object" && "total_count" in payload && Number.isFinite(apiTotal);
      setLowStock(products);
      setLowStockTotal(hasApiTotal ? apiTotal : products.length);
    } catch {
      setLowStock([]);
      setLowStockTotal(0);
    } finally {
      setLoadingStock(false);
    }
  }, []);

  useEffect(() => {
    loadLowStock();
    const t = setInterval(loadLowStock, 60_000);
    return () => clearInterval(t);
  }, [loadLowStock]);

  const displayTotal = Math.max(lowStockTotal, lowStock.length);

  return (
    <aside className="office-side-rail" aria-label="لوحة جانبية">
      <section className="office-side-rail-section">
        <h2 className="office-side-rail-title">اختصارات سريعة</h2>
        <nav className="office-side-rail-links" aria-label="اختصارات">
          {quickLinks.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                isActive ? "office-side-rail-link active" : "office-side-rail-link"
              }
              end={item.path === "/reports"}
            >
              <span className="office-side-rail-link-icon" aria-hidden>
                <Icon name={item.icon} size={18} />
              </span>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </section>

      <section className="office-side-rail-section">
        <h2 className="office-side-rail-title">
          مخزون منخفض
          {displayTotal > 0 ? (
            <span className="office-side-rail-badge">{displayTotal}</span>
          ) : null}
        </h2>
        {loadingStock ? (
          <p className="office-side-rail-muted">جاري التحميل…</p>
        ) : lowStock.length === 0 ? (
          <p className="office-side-rail-muted">لا منتجات تحت العتبة (≤{LOW_STOCK_THRESHOLD})</p>
        ) : (
          <>
            <ul className="office-side-rail-stock-list">
              {lowStock.map((p) => {
                const displayStock = Math.max(0, Number(p.stock) || 0);
                return (
                <li key={p.id} title={p.name}>
                  <span className="office-side-rail-stock-name">{p.name}</span>
                  <span
                    className={`office-side-rail-stock-qty${
                      displayStock <= 0 ? " office-side-rail-stock-qty--zero" : ""
                    }`}
                  >
                    {displayStock}
                  </span>
                </li>
                );
              })}
            </ul>
            {displayTotal > lowStock.length ? (
              <p className="office-side-rail-more">
                + {displayTotal - lowStock.length} منتجات أخرى
              </p>
            ) : null}
          </>
        )}
        <div className="office-side-rail-footer">
          {displayTotal > 0 ? (
            <Link
              to={`/expiry?tab=lowstock&threshold=${LOW_STOCK_THRESHOLD}`}
              className="office-side-rail-action"
            >
              عرض الكل ({displayTotal})
            </Link>
          ) : null}
          {isAdminRole(role) ? (
            <Link to="/manage-products" className="office-side-rail-action">
              إدارة المنتجات
            </Link>
          ) : null}
        </div>
      </section>
    </aside>
  );
}
