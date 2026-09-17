import { DataTable } from "../components/ui";
import { ils, dateOnly, qty as fmtQty } from "../utils/format";
import { deriveEffectiveUnitCost, lineHasPurchaseDiscount } from "../utils/purchaseTotals";
import "./purchase-doc-detail.css";

const COMPACT = "purchase-doc-detail__compact";
const COMPACT_NUM = `num ${COMPACT}`;

export function purchaseDocDetailColumns() {
  return [
    { key: "name", header: "الصنف", className: "purchase-doc-detail__name", nameColumn: true, wrap: true },
    { key: "unit_name", header: "الوحدة", className: COMPACT, render: (it) => it.unit_name || "—" },
    { key: "quantity", header: "الكمية", align: "left", className: COMPACT_NUM, render: (it) => fmtQty(it.quantity) },
    {
      key: "expiry_date",
      header: "تاريخ الصلاحية",
      className: COMPACT,
      render: (it) => (it.expiry_date ? dateOnly(it.expiry_date) : "غير محدد"),
    },
    {
      key: "base_quantity",
      header: "كمية الأساس",
      align: "left",
      className: COMPACT_NUM,
      render: (it) => fmtQty(it.base_quantity ?? it.quantity),
    },
    {
      key: "total_cost",
      header: "إجمالي الكلفة",
      align: "left",
      className: COMPACT_NUM,
      render: (it) => ils(it.total_cost),
    },
    {
      key: "discount_pct",
      header: "خصم %",
      align: "left",
      className: COMPACT_NUM,
      render: (it) => (it.discount_pct ? `${it.discount_pct}%` : "—"),
    },
    {
      key: "bonus_quantity",
      header: "بونص",
      align: "left",
      className: COMPACT_NUM,
      render: (it) => (it.bonus_quantity ? fmtQty(it.bonus_quantity) : "—"),
    },
    {
      key: "unit_cost",
      header: "كلفة الوحدة",
      align: "left",
      className: COMPACT_NUM,
      render: (it) => ils(it.unit_cost),
    },
    {
      key: "effective_unit_cost",
      header: "الكلفة الفعلية",
      align: "left",
      className: COMPACT_NUM,
      render: (it) => {
        const effective = deriveEffectiveUnitCost(it.line_total, it.quantity);
        if (!lineHasPurchaseDiscount(it.discount_pct) || effective === "") return "—";
        return ils(effective);
      },
    },
    {
      key: "line_total",
      header: "الإجمالي",
      align: "left",
      className: COMPACT_NUM,
      render: (it) => ils(it.line_total),
    },
  ];
}

export default function PurchaseDocDetailItems({ items }) {
  return (
    <DataTable
      className="purchase-doc-detail__table"
      columns={purchaseDocDetailColumns()}
      rows={items || []}
      empty="لا توجد أصناف"
    />
  );
}
