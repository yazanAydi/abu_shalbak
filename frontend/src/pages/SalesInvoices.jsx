import { useCallback, useEffect, useMemo, useState } from "react";
import { todayISO } from "../utils/format";
import { useSearchParams } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { ils, dateOnly, qty as fmtQty } from "../utils/format";
import ProductPicker from "../components/ProductPicker";
import InvoicePaymentPanel from "../components/InvoicePaymentPanel";
import {
  PageHeader, Button, DataTable, Modal, StatusPill,
  FormField, FormGrid, Input, Textarea, Select, ReportToolbar, useToast,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";
import { printSalesInvoiceDoc } from "../utils/saleInvoicePrint";
import QtyStepper from "../components/QtyStepper";
import { handleEnterNavKeyDown } from "../utils/focusNavigation";
import { fetchProductUnits } from "./Purchases";
import {
  computeSaleEditorTotals,
  computeSaleLineTotals,
  deriveTotalPrice,
  deriveUnitPrice,
  formatDiscountPercent,
  formatTaxRatePercent,
} from "../utils/saleInvoiceTotals";
import "./purchase-item-editor.css";

const STATUS_TONE = { draft: "neutral", posted: "green" };
const STATUS_LABEL = { draft: "مسودة", posted: "مرحّلة" };

function selectInputOnFocus(e) {
  e.target.select();
}

function pickDefaultSaleUnit(units) {
  const saleable = units.filter((u) => u.sale_enabled !== false);
  const pool = saleable.length ? saleable : units;
  const def = pool.find((u) => u.is_default) || pool[0];
  return def ? { id: def.id, price: def.price } : { id: null, price: null };
}

function SaleSummaryFooter({ totals, defaultTaxRate }) {
  if (!totals) return null;
  const hasDiscount = (totals.discountSaved ?? 0) > 0;
  const rows = [
    { label: "المجموع (يشمل ض.ق.م)", value: ils(totals.listGrossTotal ?? 0), muted: false },
    ...(hasDiscount
      ? [
          { label: `الخصم ${formatDiscountPercent(totals.effectiveDiscountPct)}%`, value: ils(totals.discountSaved), muted: true },
          { label: "بعد الخصم", value: ils(totals.total ?? 0), muted: true },
        ]
      : []),
    { label: `ضريبة ${formatTaxRatePercent(defaultTaxRate)}%`, value: ils(totals.tax ?? 0), muted: true },
    { label: "الصافي", value: ils(totals.total ?? 0), grand: true },
  ];
  return (
    <table className="purchase-summary-table" style={{ marginTop: "0.75rem", marginInlineStart: "auto", borderCollapse: "collapse", fontSize: "0.95rem" }}>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label} style={row.grand ? { background: "var(--office-panel-muted-bg, #eef2f7)", fontWeight: 700 } : undefined}>
            <td style={{ padding: "0.35rem 1rem 0.35rem 0", textAlign: "right", color: row.muted ? "var(--office-panel-muted)" : undefined, whiteSpace: "nowrap" }}>
              {row.label}
            </td>
            <td className="num" style={{ padding: "0.35rem 0", textAlign: "left", fontWeight: row.grand ? 700 : 500, minWidth: 90 }}>
              {row.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ItemEditor({ items, setItems, defaultTaxRate = 0, taxInclusive = true }) {
  async function addProduct(p) {
    let exists = false;
    setItems((prev) => {
      exists = prev.some((x) => x.product_id === p.id);
      return prev;
    });
    if (exists) return;
    const units = await fetchProductUnits(p.id);
    const def = pickDefaultSaleUnit(units);
    const unitPrice = def.price ?? p.price ?? "";
    setItems((prev) => {
      if (prev.some((x) => x.product_id === p.id)) return prev;
      return [
        ...prev,
        {
          product_id: p.id,
          name: p.name,
          barcode: p.barcode,
          quantity: 1,
          unit_id: def.id,
          units,
          total_price: unitPrice !== "" ? String(Number(unitPrice)) : "",
          unit_price: unitPrice !== "" ? String(Number(unitPrice)) : "",
          price_mode: "unit",
          discount_pct: "",
          bonus_quantity: "",
        },
      ];
    });
  }

  function update(i, key, val) {
    setItems((prev) => prev.map((x, idx) => (idx === i ? { ...x, [key]: val } : x)));
  }

  function updateTotalPrice(i, val) {
    setItems((prev) => prev.map((x, idx) => {
      if (idx !== i) return x;
      const qty = Number(x.quantity) || 0;
      return { ...x, total_price: val, unit_price: deriveUnitPrice(val, qty), price_mode: "total" };
    }));
  }

  function updateUnitPrice(i, val) {
    setItems((prev) => prev.map((x, idx) => {
      if (idx !== i) return x;
      const qty = Number(x.quantity) || 0;
      return { ...x, unit_price: val, total_price: deriveTotalPrice(val, qty), price_mode: "unit" };
    }));
  }

  function updateQuantity(i, val) {
    setItems((prev) => prev.map((x, idx) => {
      if (idx !== i) return x;
      const qty = Number(val) || 0;
      if (x.price_mode === "unit" && x.unit_price !== "") {
        return { ...x, quantity: val, total_price: deriveTotalPrice(x.unit_price, qty) };
      }
      if (x.total_price !== "") {
        return { ...x, quantity: val, unit_price: deriveUnitPrice(x.total_price, qty) };
      }
      return { ...x, quantity: val };
    }));
  }

  function remove(i) {
    setItems((prev) => prev.filter((_, idx) => idx !== i));
  }

  const totals = computeSaleEditorTotals(items, defaultTaxRate, taxInclusive);

  return (
    <div className="purchase-item-editor" data-enter-nav="" onKeyDown={handleEnterNavKeyDown}>
      <div style={{ marginBottom: "0.75rem" }}>
        <ProductPicker onPick={addProduct} />
      </div>
      <div className="purchase-item-editor__hint">الأسعار شامل ضريبة القيمة المضافة</div>
      <div className="ui-table-wrap">
        <table className="ui-table">
          <thead>
            <tr>
              <th>الصنف</th>
              <th>الوحدة</th>
              <th>سعر الوحدة</th>
              <th>الكمية</th>
              <th>خصم %</th>
              <th>بونص</th>
              <th>الإجمالي</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan={8} style={{ textAlign: "center", color: "var(--office-panel-muted)" }}>أضف أصنافاً</td></tr>
            ) : items.map((it, i) => {
              const line = computeSaleLineTotals(it.total_price, it.discount_pct, defaultTaxRate, taxInclusive);
              return (
                <tr key={`${it.product_id}-${i}`}>
                  <td>{it.name}</td>
                  <td>
                    <Select value={it.unit_id ?? ""} onChange={(e) => update(i, "unit_id", e.target.value ? Number(e.target.value) : null)}>
                      {(it.units || []).map((u) => (
                        <option key={u.id} value={u.id}>{u.unit_name}</option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <input className="ui-input" type="number" min="0" step="0.01" value={it.unit_price ?? ""} onFocus={selectInputOnFocus} onChange={(e) => updateUnitPrice(i, e.target.value)} />
                  </td>
                  <td>
                    <QtyStepper className="ui-input" min={0} value={it.quantity} onFocus={selectInputOnFocus} onChange={(e) => updateQuantity(i, e.target.value)} />
                  </td>
                  <td>
                    <input className="ui-input" type="number" min="0" max="100" step="0.1" value={it.discount_pct ?? ""} onFocus={selectInputOnFocus} onChange={(e) => update(i, "discount_pct", e.target.value)} />
                  </td>
                  <td>
                    <QtyStepper className="ui-input" min={0} value={it.bonus_quantity ?? ""} onFocus={selectInputOnFocus} onChange={(e) => update(i, "bonus_quantity", e.target.value)} />
                  </td>
                  <td className="num">{ils(line.lineTotal)}</td>
                  <td><Button variant="ghost" size="sm" icon="trash" onClick={() => remove(i)} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <SaleSummaryFooter totals={totals} defaultTaxRate={defaultTaxRate} />
    </div>
  );
}

export default function SalesInvoices() {
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [customers, setCustomers] = useState([]);
  const [store, setStore] = useState({});
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [docDate, setDocDate] = useState(todayISO());
  const [refText, setRefText] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState([]);
  const [saving, setSaving] = useState(false);
  const [editId, setEditId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [postTarget, setPostTarget] = useState(null);
  const [posting, setPosting] = useState(false);

  const taxInclusive = store.tax_inclusive !== false && store.tax_inclusive !== "0";

  const loadCustomers = useCallback(async () => {
    try {
      const { data } = await api.get("/api/customers", { headers: getAuthHeaders() });
      setCustomers(Array.isArray(data) ? data : []);
    } catch { /* ignore */ }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const { data } = await api.get("/api/settings", { headers: getAuthHeaders() });
      setStore(data || {});
    } catch { /* ignore */ }
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/api/sales/invoices", { headers: getAuthHeaders() });
      setInvoices(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "تعذّر التحميل");
    } finally {
      setLoading(false);
    }
    // toast object from useToast() is recreated each render — do not add to deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadCustomers();
    loadSettings();
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const invoiceId = searchParams.get("invoiceId");
    if (!invoiceId) return;
    openDetail(invoiceId);
    const next = new URLSearchParams(searchParams);
    next.delete("invoiceId");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openForm() {
    setEditId(null);
    setCustomerId("");
    setDocDate(todayISO());
    setRefText("");
    setNotes("");
    setItems([]);
    setShowForm(true);
  }

  async function fillFormFromDoc(data, id) {
    setCustomerId(String(data.customer_id));
    setDocDate(data.invoice_date?.slice(0, 10) || todayISO());
    setRefText(data.ref_text || "");
    setNotes(data.notes || "");
    const mapped = await Promise.all(
      (data.items || []).map(async (it) => {
        const units = await fetchProductUnits(it.product_id);
        const qty = Number(it.quantity) || 0;
        return {
          product_id: it.product_id,
          name: it.name,
          barcode: it.barcode,
          quantity: it.quantity,
          unit_id: it.product_unit_id ?? pickDefaultSaleUnit(units).id,
          units,
          total_price: it.total_price,
          unit_price: deriveUnitPrice(it.total_price, qty) || it.unit_price,
          price_mode: "total",
          discount_pct: it.discount_pct != null && it.discount_pct !== 0 ? it.discount_pct : "",
          bonus_quantity: it.bonus_quantity != null && it.bonus_quantity !== 0 ? it.bonus_quantity : "",
        };
      })
    );
    setItems(mapped);
    setEditId(id);
    setShowForm(true);
  }

  async function persist() {
    if (!customerId) {
      toast.error("اختر العميل");
      return null;
    }
    if (items.length === 0) {
      toast.error("أضف أصنافاً");
      return null;
    }
    setSaving(true);
    const payload = {
      customer_id: Number(customerId),
      invoice_date: docDate,
      ref_text: refText,
      notes,
      items: items.map((it) => ({
        product_id: it.product_id,
        quantity: Number(it.quantity),
        unit_id: it.unit_id != null ? Number(it.unit_id) : undefined,
        total_price: Number(it.total_price),
        discount_pct: it.discount_pct === "" ? undefined : Number(it.discount_pct),
        bonus_quantity: it.bonus_quantity === "" ? undefined : Number(it.bonus_quantity),
      })),
    };
    try {
      if (editId) {
        await api.put(`/api/sales/invoices/${editId}`, payload, { headers: getAuthHeaders() });
        toast.success("تم تعديل المسودة");
        return editId;
      }
      const { data } = await api.post("/api/sales/invoices", payload, { headers: getAuthHeaders() });
      toast.success("تم الحفظ كمسودة");
      return data?.id ?? null;
    } catch (e) {
      toast.error(e.response?.data?.error || "فشل الحفظ");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    const id = await persist();
    if (id == null) return;
    setShowForm(false);
    setEditId(null);
    loadList();
  }

  async function openDetail(id) {
    try {
      const { data } = await api.get(`/api/sales/invoices/${id}`, { headers: getAuthHeaders() });
      if (data.status === "draft") {
        fillFormFromDoc(data, id);
      } else {
        setDetail(data);
      }
    } catch {
      toast.error("تعذّر التحميل");
    }
  }

  async function removeDoc(id) {
    if (!window.confirm("حذف هذه المسودة؟")) return;
    try {
      await api.delete(`/api/sales/invoices/${id}`, { headers: getAuthHeaders() });
      toast.success("تم الحذف");
      loadList();
    } catch (e) {
      toast.error(e.response?.data?.error || "فشل الحذف");
    }
  }

  async function startPost(row) {
    setPostTarget(row);
  }

  async function confirmPost(paymentPayload) {
    if (!postTarget) return;
    setPosting(true);
    try {
      await api.post(`/api/sales/invoices/${postTarget.id}/post`, paymentPayload, { headers: getAuthHeaders() });
      toast.success("تم الترحيل");
      setPostTarget(null);
      loadList();
    } catch (e) {
      toast.error(e.response?.data?.error || "فشل الترحيل");
    } finally {
      setPosting(false);
    }
  }

  async function printDoc(id) {
    try {
      const { data } = await api.get(`/api/sales/invoices/${id}`, { headers: getAuthHeaders() });
      printSalesInvoiceDoc(data, store);
    } catch {
      toast.error("تعذّر التحميل");
    }
  }

  const columns = useMemo(() => [
    { key: "invoice_no", header: "رقم", render: (r) => `#${r.invoice_no ?? r.id}` },
    { key: "customer_name", header: "العميل" },
    { key: "invoice_date", header: "التاريخ", render: (r) => dateOnly(r.invoice_date) },
    { key: "total", header: "الإجمالي", align: "left", className: "num", render: (r) => ils(r.total) },
    { key: "status", header: "الحالة", render: (r) => <StatusPill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</StatusPill> },
    {
      key: "actions",
      header: "إجراءات",
      render: (r) => (
        <div className="ui-table__actions">
          <Button variant="ghost" size="sm" onClick={() => openDetail(r.id)}>عرض</Button>
          <Button variant="ghost" size="sm" icon="print" onClick={() => printDoc(r.id)}>طباعة</Button>
          {r.status === "draft" && (
            <>
              <Button variant="outline" size="sm" icon="check" onClick={() => startPost(r)}>ترحيل</Button>
              <Button variant="ghost" size="sm" icon="trash" onClick={() => removeDoc(r.id)} />
            </>
          )}
        </div>
      ),
    },
  ], []);

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        icon="customers"
        title="فتورة مبيعات"
        subtitle="فواتير بيع للعملاء من المكتب"
        actions={
          <>
            <ReportToolbar
              title="فتورات المبيعات"
              columns={pickExportColumns(columns)}
              rows={invoices}
              filename="sales-invoices"
              disabled={loading}
            />
            <Button icon="plus" onClick={openForm}>فاتورة مبيعات جديدة</Button>
          </>
        }
      />

      <DataTable
        columns={columns}
        rows={invoices}
        loading={loading}
        emptyIcon="customers"
        empty="لا توجد فواتير"
        emptyHint="أنشئ فاتورة جديدة للبدء"
      />

      <Modal
        open={showForm}
        title={editId ? "تعديل المسودة" : "فاتورة مبيعات جديدة"}
        onClose={() => { setShowForm(false); setEditId(null); }}
        size="xl"
        footer={
          <>
            <Button onClick={save} disabled={saving}>{saving ? "جاري الحفظ…" : editId ? "حفظ التعديلات" : "حفظ كمسودة"}</Button>
            <Button variant="secondary" onClick={() => { setShowForm(false); setEditId(null); }}>إلغاء</Button>
          </>
        }
      >
        <FormGrid>
          <FormField label="العميل" required>
            <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">— اختر —</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </FormField>
          <FormField label="التاريخ">
            <Input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />
          </FormField>
          <FormField label="مرجع الفاتورة">
            <Input value={refText} onChange={(e) => setRefText(e.target.value)} />
          </FormField>
        </FormGrid>
        <div style={{ margin: "1rem 0 0.5rem", fontWeight: 700 }}>الأصناف</div>
        <ItemEditor items={items} setItems={setItems} defaultTaxRate={store.default_tax_rate} taxInclusive={taxInclusive} />
        <FormField label="ملاحظات" className="ui-field--full">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>
      </Modal>

      <Modal
        open={!!detail}
        title={detail ? `تفاصيل الفاتورة #${detail.invoice_no ?? detail.id}` : ""}
        onClose={() => setDetail(null)}
        size="lg"
        footer={detail ? <Button icon="print" onClick={() => printSalesInvoiceDoc(detail, store)}>طباعة</Button> : null}
      >
        {detail && (
          <>
            <div className="detail-header">
              <div>العميل: <strong>{detail.customer_name}</strong></div>
              <div>الحالة: <StatusPill tone={STATUS_TONE[detail.status]}>{STATUS_LABEL[detail.status]}</StatusPill></div>
            </div>
            <DataTable
              columns={[
                { key: "name", header: "الصنف" },
                { key: "unit_name", header: "الوحدة", render: (it) => it.unit_name || "—" },
                { key: "quantity", header: "الكمية", render: (it) => fmtQty(it.quantity) },
                { key: "unit_price", header: "سعر الوحدة", className: "num", render: (it) => ils(it.unit_price) },
                { key: "line_total", header: "الإجمالي", className: "num", render: (it) => ils(it.line_total) },
              ]}
              rows={detail.items || []}
              empty="لا توجد أصناف"
            />
          </>
        )}
      </Modal>

      <Modal
        open={!!postTarget}
        title={postTarget ? `ترحيل فاتورة #${postTarget.invoice_no ?? postTarget.id}` : ""}
        onClose={() => !posting && setPostTarget(null)}
        size="md"
      >
        {postTarget ? (
          <InvoicePaymentPanel
            total={Number(postTarget.total) || 0}
            onSubmit={confirmPost}
            onCancel={() => setPostTarget(null)}
            submitting={posting}
          />
        ) : null}
      </Modal>
    </div>
  );
}
