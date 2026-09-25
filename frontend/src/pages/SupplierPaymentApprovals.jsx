import GroupApprovalQueue from "./GroupApprovalQueue";

export default function SupplierPaymentApprovals() {
  return (
    <GroupApprovalQueue
      title="موافقات دفعات الموردين"
      subtitle="طلبات الدفع من صندوق الكاشير ومن عد الورديات — تتحدّث تلقائياً كل 7 ثوانٍ"
      apiBase="/api/supplier-payment-requests"
      filename="supplier-payment-approvals"
      partyHeader="المورد"
      partyValue={(row) => row.supplier_name || "—"}
      showOrigin
    />
  );
}
