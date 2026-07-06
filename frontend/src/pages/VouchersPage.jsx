import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { voucherPartyName } from "../utils/partySearch";
import PartyPicker from "../components/PartyPicker";
import {
  PageHeader,
  ReportToolbar,
  FilterBar,
  DataTable,
  Modal,
  Card,
  CardBody,
  Button,
  FormField,
  FormGrid,
  Input,
  Select,
  Textarea,
  StatusPill,
  SectionTitle,
  useToast,
} from "../components/ui";

const ils = (n) => `₪${Number(n ?? 0).toFixed(2)}`;
const TYPE_AR = { receipt: "سند قبض", payment: "سند صرف" };
const STATUS_AR = { draft: "مسودة", posted: "مرحّل" };
const STATUS_TONE = { draft: "orange", posted: "green" };

const VOUCHER_COLUMNS = [
  { key: "voucher_no", header: "رقم" },
  { key: "voucher_type", header: "النوع", value: (v) => TYPE_AR[v.voucher_type] },
  { key: "voucher_date", header: "التاريخ" },
  { key: "total_amount", header: "المجموع", value: (v) => ils(v.total_amount) },
  { key: "status", header: "الحالة", value: (v) => STATUS_AR[v.status] },
];

const emptyLine = { line_type: "cash", amount: "", currency: "NIS", bank_name: "", description: "" };

function resetForm(setLines, setNotes, setParty) {
  setLines([{ ...emptyLine }]);
  setNotes("");
  setParty(null);
}

export default function VouchersPage() {
  const toast = useToast();
  const [vouchers, setVouchers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [voucherType, setVoucherType] = useState("receipt");
  const [voucherDate, setVoucherDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState([{ ...emptyLine }]);
  const [party, setParty] = useState(null);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState(null);
  const [editId, setEditId] = useState(null);
  const [filter, setFilter] = useState({ type: "", status: "" });
  const [searchParams, setSearchParams] = useSearchParams();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (filter.type) q.set("type", filter.type);
      if (filter.status) q.set("status", filter.status);
      const { data } = await api.get(`/api/vouchers?${q}`, { headers: getAuthHeaders() });
      setVouchers(data);
    } catch {
      toast.error("تعذّر تحميل السندات");
    } finally {
      setLoading(false);
    }
  }, [filter, toast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const id = searchParams.get("id");
    if (!id) return;
    loadDetail({ id });
    const next = new URLSearchParams(searchParams);
    next.delete("id");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addLine() {
    setLines((p) => [...p, { ...emptyLine }]);
  }
  function removeLine(i) {
    setLines((p) => p.filter((_, idx) => idx !== i));
  }
  function updateLine(i, key, val) {
    setLines((p) => {
      const n = [...p];
      const line = { ...n[i], [key]: val };
      if (key === "line_type" && val !== "check") line.bank_name = "";
      n[i] = line;
      return n;
    });
  }

  async function submit(e) {
    e.preventDefault();
    if (!party) {
      toast.error("يرجى اختيار الاسم (زبون أو مورد)");
      return;
    }
    setSaving(true);
    const payload = {
      voucher_type: voucherType,
      voucher_date: voucherDate,
      notes,
      lines: lines.map((L) => ({
        ...L,
        amount: Number(L.amount),
        customer_id: party.type === "customer" ? party.id : null,
        supplier_id: party.type === "supplier" ? party.id : null,
      })),
    };
    try {
      if (editId) {
        await api.put(`/api/vouchers/${editId}`, payload, { headers: getAuthHeaders() });
        toast.success("تم تعديل المسودة");
      } else {
        await api.post("/api/vouchers", payload, { headers: getAuthHeaders() });
        toast.success("تم إنشاء السند");
      }
      setShowForm(false);
      setEditId(null);
      resetForm(setLines, setNotes, setParty);
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || (editId ? "فشل التعديل" : "فشل الإنشاء"));
    } finally {
      setSaving(false);
    }
  }

  async function postVoucher(v) {
    if (!window.confirm(`ترحيل السند #${v.id}؟ لا يمكن التراجع.`)) return;
    try {
      await api.post(`/api/vouchers/${v.id}/post`, {}, { headers: getAuthHeaders() });
      toast.success("تم الترحيل");
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || "فشل الترحيل");
    }
  }

  async function deleteVoucher(v) {
    if (!window.confirm(`حذف السند #${v.id}؟`)) return;
    try {
      await api.delete(`/api/vouchers/${v.id}`, { headers: getAuthHeaders() });
      toast.success("تم الحذف");
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || "فشل الحذف");
    }
  }

  async function loadDetail(v) {
    const { data } = await api.get(`/api/vouchers/${v.id}`, { headers: getAuthHeaders() });
    if (data.status === "draft") {
      fillFormFromDoc(data);
    } else {
      setDetail(data);
    }
  }

  function fillFormFromDoc(data) {
    setVoucherType(data.voucher_type);
    setVoucherDate(data.voucher_date?.slice(0, 10) || new Date().toISOString().slice(0, 10));
    setNotes(data.notes || "");
    const firstWithParty = data.lines?.find((L) => L.customer_id || L.supplier_id);
    if (firstWithParty?.customer_id) {
      setParty({
        type: "customer",
        id: firstWithParty.customer_id,
        name: firstWithParty.customer_name,
        badge: "زبون",
      });
    } else if (firstWithParty?.supplier_id) {
      setParty({
        type: "supplier",
        id: firstWithParty.supplier_id,
        name: firstWithParty.supplier_name,
        badge: "مورد",
      });
    } else {
      setParty(null);
    }
    setLines(
      (data.lines || []).map((L) => ({
        line_type: L.line_type,
        amount: L.amount,
        currency: L.currency || "NIS",
        bank_name: L.bank_name || "",
        description: L.description || "",
      }))
    );
    setEditId(data.id);
    setShowForm(true);
  }

  function openNewForm() {
    setEditId(null);
    resetForm(setLines, setNotes, setParty);
    setVoucherType("receipt");
    setVoucherDate(new Date().toISOString().slice(0, 10));
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditId(null);
    resetForm(setLines, setNotes, setParty);
  }

  const total = lines.reduce((s, L) => s + (Number(L.amount) || 0), 0);

  const voucherColumns = useMemo(
    () => [
      { key: "voucher_no", header: "رقم" },
      { key: "voucher_type", header: "النوع", render: (v) => TYPE_AR[v.voucher_type] },
      { key: "voucher_date", header: "التاريخ" },
      { key: "total_amount", header: "المجموع", className: "num", render: (v) => ils(v.total_amount) },
      {
        key: "status",
        header: "الحالة",
        render: (v) => (
          <StatusPill tone={STATUS_TONE[v.status] || "neutral"}>{STATUS_AR[v.status]}</StatusPill>
        ),
      },
      {
        key: "actions",
        header: "عمليات",
        render: (v) => (
          <div className="ui-table__actions">
            <Button variant="ghost" size="sm" onClick={() => loadDetail(v)}>
              عرض
            </Button>
            {v.status === "draft" && (
              <>
                <Button variant="ghost" size="sm" onClick={() => postVoucher(v)}>
                  ترحيل
                </Button>
                <Button variant="ghost" size="sm" onClick={() => deleteVoucher(v)}>
                  حذف
                </Button>
              </>
            )}
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const detailColumns = useMemo(
    () => [
      {
        key: "line_type",
        header: "النوع",
        render: (L) => (L.line_type === "cash" ? "نقدي" : L.line_type === "check" ? "شيك" : "بنك"),
      },
      { key: "amount_nis", header: "المبلغ", className: "num", render: (L) => ils(L.amount_nis) },
      { key: "currency", header: "العملة" },
      {
        key: "bank_name",
        header: "البنك",
        render: (L) => (L.line_type === "check" ? L.bank_name || "—" : "—"),
      },
      { key: "description", header: "البيان", render: (L) => L.description || "—" },
    ],
    []
  );

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title="سندات القبض والصرف"
        subtitle="سندات القبض والصرف المالية"
        icon="vouchers"
        actions={
          !detail ? (
            <ReportToolbar
              title="سندات القبض والصرف"
              columns={VOUCHER_COLUMNS}
              rows={vouchers}
              filename="vouchers"
              disabled={loading}
            />
          ) : null
        }
      />

      {detail ? (
        <Card>
          <CardBody>
            <SectionTitle as="h3">
              {TYPE_AR[detail.voucher_type]} رقم {detail.voucher_no}
            </SectionTitle>
            <div className="ui-toolbar">
              <StatusPill tone={STATUS_TONE[detail.status] || "neutral"}>
                {STATUS_AR[detail.status]}
              </StatusPill>
              <span>
                التاريخ: {detail.voucher_date} | المجموع: <strong>{ils(detail.total_amount)}</strong>
              </span>
              {voucherPartyName(detail) && (
                <span>
                  الاسم: <strong>{voucherPartyName(detail)}</strong>
                </span>
              )}
              {detail.notes && <span>ملاحظات: {detail.notes}</span>}
            </div>
            <DataTable columns={detailColumns} rows={detail.lines || []} empty="لا توجد أسطر" />
            <div className="ui-toolbar">
              <Button variant="secondary" onClick={() => setDetail(null)}>
                إغلاق
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : (
        <>
          <FilterBar actions={<Button onClick={openNewForm}>+ سند جديد</Button>}>
            <FormField label="النوع">
              <Select value={filter.type} onChange={(e) => setFilter((p) => ({ ...p, type: e.target.value }))}>
                <option value="">كل الأنواع</option>
                <option value="receipt">قبض</option>
                <option value="payment">صرف</option>
              </Select>
            </FormField>
            <FormField label="الحالة">
              <Select
                value={filter.status}
                onChange={(e) => setFilter((p) => ({ ...p, status: e.target.value }))}
              >
                <option value="">كل الحالات</option>
                <option value="draft">مسودة</option>
                <option value="posted">مرحّل</option>
              </Select>
            </FormField>
          </FilterBar>

          <DataTable
            columns={voucherColumns}
            rows={vouchers}
            loading={loading}
            empty="لا توجد سندات"
            emptyIcon="vouchers"
          />
        </>
      )}

      <Modal
        open={showForm}
        onClose={closeForm}
        title={editId ? "تعديل المسودة" : "سند جديد"}
        size="lg"
        footer={
          <>
            <Button type="submit" form="voucher-form" disabled={saving}>
              {saving ? "جاري الحفظ…" : editId ? "حفظ التعديلات" : "حفظ كمسودة"}
            </Button>
            <Button variant="secondary" type="button" onClick={closeForm}>
              إلغاء
            </Button>
          </>
        }
      >
        <form id="voucher-form" onSubmit={submit}>
          <FormGrid>
            <FormField label="النوع">
              <Select value={voucherType} onChange={(e) => setVoucherType(e.target.value)}>
                <option value="receipt">سند قبض</option>
                <option value="payment">سند صرف</option>
              </Select>
            </FormField>
            <FormField label="التاريخ">
              <Input type="date" value={voucherDate} onChange={(e) => setVoucherDate(e.target.value)} />
            </FormField>
            <FormField label="الاسم" className="ui-field--full">
              <PartyPicker value={party} onPick={setParty} placeholder="ابحث بالاسم أو الرقم…" />
            </FormField>
            <FormField label="ملاحظات" className="ui-field--full">
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
            </FormField>
          </FormGrid>

          <SectionTitle as="h3">أسطر السند</SectionTitle>
          {lines.map((L, i) => (
            <div key={i} className="voucher-line-row">
              <Select value={L.line_type} onChange={(e) => updateLine(i, "line_type", e.target.value)}>
                <option value="cash">نقدي</option>
                <option value="check">شيك</option>
                <option value="bank">بنك</option>
              </Select>
              <Input
                type="number"
                min="0.01"
                step="0.01"
                placeholder="المبلغ *"
                required
                value={L.amount}
                onChange={(e) => updateLine(i, "amount", e.target.value)}
              />
              <Select value={L.currency} onChange={(e) => updateLine(i, "currency", e.target.value)}>
                <option value="NIS">₪</option>
                <option value="USD">$</option>
                <option value="JOD">د.أ</option>
              </Select>
              {L.line_type === "check" && (
                <Input
                  placeholder="اسم البنك"
                  value={L.bank_name}
                  onChange={(e) => updateLine(i, "bank_name", e.target.value)}
                />
              )}
              <Input
                placeholder="بيان"
                value={L.description}
                onChange={(e) => updateLine(i, "description", e.target.value)}
              />
              {lines.length > 1 && (
                <Button type="button" variant="ghost" size="sm" onClick={() => removeLine(i)}>
                  ✕
                </Button>
              )}
            </div>
          ))}
          <p className="voucher-total">
            المجموع: <strong>{ils(total)}</strong>
          </p>
          <Button type="button" variant="secondary" onClick={addLine}>
            + سطر
          </Button>
        </form>
      </Modal>
    </div>
  );
}
