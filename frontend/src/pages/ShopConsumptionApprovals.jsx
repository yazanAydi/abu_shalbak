import GroupApprovalQueue from "./GroupApprovalQueue";

export default function ShopConsumptionApprovals() {
  return (
    <GroupApprovalQueue
      title="موافقات مصاريف المحل"
      subtitle="طلبات الترحيل الداخلي من نقطة البيع «ترحيل كمصاريف محل»"
      apiBase="/api/shop-consumption-requests"
      filename="shop-consumption-approvals"
      partyHeader="الأصناف"
      partyValue={(row) =>
        Array.isArray(row.items) && row.items.length
          ? row.items.map((item) => item.name).join("، ")
          : "—"
      }
    />
  );
}
