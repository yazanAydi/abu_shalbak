import { SkeletonRows, EmptyState } from "../../components/ui";

export const CHART_COLORS = {
  teal: "#0f766e",
  green: "#16a34a",
  blue: "#2563eb",
  orange: "#d97706",
  red: "#dc2626",
  slate: "#64748b",
  purple: "#7c3aed",
};

export const MOVEMENT_LABELS = {
  sale: "بيع",
  refund: "استرجاع",
  purchase_receive: "استلام شراء",
  supplier_return: "مرتجع مورد",
  manual_adjustment: "تسوية يدوية",
  warehouse_transfer_in: "تحويل وارد",
  warehouse_transfer_out: "تحويل صادر",
  stock_count_correction: "تصحيح جرد",
  expiry_writeoff: "إتلاف صلاحية",
};

export const MOVEMENT_TONE = {
  sale: "red",
  refund: "green",
  purchase_receive: "green",
  supplier_return: "orange",
  manual_adjustment: "neutral",
  warehouse_transfer_in: "blue",
  warehouse_transfer_out: "blue",
  stock_count_correction: "orange",
  expiry_writeoff: "red",
};

export const AUDIT_LABELS = {
  PRODUCT_CREATE: "إنشاء المنتج",
  PRODUCT_UPDATE: "تعديل المنتج",
  PRODUCT_DELETE: "حذف المنتج",
  PRICE_CHANGE: "تغيير سعر البيع",
  INVENTORY_ADJUST: "تسوية مخزون",
  INVENTORY_COUNT: "جرد مخزون",
  PURCHASE_RECEIVE: "استلام شراء",
  WAREHOUSE_TRANSFER: "تحويل مستودع",
};

export function movementLabel(type) {
  return MOVEMENT_LABELS[type] || type || "—";
}

export function auditLabel(action) {
  return AUDIT_LABELS[action] || action || "—";
}

/** Days-remaining -> expiry badge tone + label. */
export function expiryBadge(days) {
  if (days == null) return null;
  if (days < 0) return { tone: "red", label: "منتهية الصلاحية" };
  if (days <= 7) return { tone: "red", label: `تنتهي خلال ${days} يوم` };
  if (days <= 30) return { tone: "orange", label: `تنتهي خلال ${days} يوم` };
  return { tone: "green", label: `متبقٍ ${days} يوم` };
}

/** Consistent loading / error / empty states for tabs. */
export function TabState({ loading, error, empty, emptyText, children }) {
  if (loading) {
    return (
      <div className="pd-tab-state">
        <SkeletonRows rows={6} cols={4} />
      </div>
    );
  }
  if (error) {
    return <div className="pd-error-banner">{error}</div>;
  }
  if (empty) {
    return <EmptyState title={emptyText || "لا توجد بيانات"} />;
  }
  return children;
}
