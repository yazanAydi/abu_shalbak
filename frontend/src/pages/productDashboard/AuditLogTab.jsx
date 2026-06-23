import { StatusBadge } from "../../components/ui";
import { ils, dateTime } from "../../utils/format";
import { useProductTab } from "./useProductTab";
import { TabState, auditLabel } from "./shared";

function parse(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function details(row) {
  const oldV = parse(row.old_value);
  const newV = parse(row.new_value);
  if (row.action === "PRICE_CHANGE" && newV) {
    const from = oldV?.price != null ? ils(oldV.price) : "—";
    const to = newV.price != null ? ils(newV.price) : "—";
    const reason = newV.reason ? ` — ${newV.reason}` : "";
    return `${from} ← ${to}${reason}`;
  }
  if (row.action === "PRODUCT_UPDATE" && newV) {
    const bits = [];
    if (oldV && newV) {
      if (oldV.name !== newV.name) bits.push(`الاسم: ${newV.name}`);
      if (Number(oldV.stock) !== Number(newV.stock)) bits.push(`المخزون: ${newV.stock}`);
      if (Number(oldV.cost) !== Number(newV.cost)) bits.push(`التكلفة: ${ils(newV.cost)}`);
    }
    return bits.length ? bits.join("، ") : "تعديل بيانات المنتج";
  }
  if (row.action === "PRODUCT_CREATE" && newV) {
    return `إنشاء: ${newV.name ?? ""}`.trim();
  }
  return "—";
}

const ACTION_TONE = {
  PRICE_CHANGE: "green",
  PRODUCT_UPDATE: "blue",
  PRODUCT_CREATE: "teal",
  PRODUCT_DELETE: "red",
};

export default function AuditLogTab({ productId }) {
  const { data, loading, error } = useProductTab(`/api/products/${productId}/audit-log`);
  const rows = data?.rows || [];

  return (
    <TabState loading={loading} error={error} empty={rows.length === 0} emptyText="لا توجد عمليات مسجّلة لهذا المنتج">
      <div className="ui-table-wrap pd-sticky-table">
        <table className="ui-table">
          <thead>
            <tr>
              <th>التاريخ</th>
              <th>العملية</th>
              <th>المستخدم</th>
              <th>الدور</th>
              <th>التفاصيل</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{dateTime(r.created_at)}</td>
                <td><StatusBadge tone={ACTION_TONE[r.action] || "neutral"} noDot>{auditLabel(r.action)}</StatusBadge></td>
                <td>{r.username || "—"}</td>
                <td>{r.role || "—"}</td>
                <td>{details(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TabState>
  );
}
