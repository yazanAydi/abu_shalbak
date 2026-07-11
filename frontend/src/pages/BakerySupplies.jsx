import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { searchProductsApi } from "../utils/productSearch";
import { ils, dateOnly, qty as fmtQty } from "../utils/format";
import ProductPicker from "../components/ProductPicker";
import QtyStepper from "../components/QtyStepper";
import { invalidateProductCache } from "../components/ProductPicker";
import ProductUnitsModal from "./productDashboard/ProductUnitsModal";
import EditProductModal from "./productDashboard/EditProductModal";
import { fetchProductUnits, pickDefaultPurchaseUnit, ItemEditor } from "./Purchases";
import { deriveUnitCost } from "../utils/purchaseTotals";
import {
  PageHeader,
  Tabs,
  Button,
  DataTable,
  Modal,
  StatusPill,
  FormField,
  FormGrid,
  Input,
  Select,
  Textarea,
  ReportToolbar,
  FilterBar,
  useToast,
  Card,
  CardBody,
  PrimaryButton,
  SearchInput,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";
import { handleEnterNavKeyDown } from "../utils/focusNavigation";
import CameraBarcodeButton from "../components/barcode/CameraBarcodeButton";
import { normalizeBarcode } from "../utils/barcode";

const BAKERY_SCOPE = "bakery";
const STATUS_TONE = { draft: "neutral", posted: "green" };
const STATUS_LABEL = { draft: "مسودة", posted: "مرحّلة" };

const emptyForm = {
  barcode: "",
  name: "",
  cost: "",
  unit: "",
  stock: "",
  min_stock: "",
};

function unwrapList(data) {
  const rows = data?.data ?? data;
  return Array.isArray(rows) ? rows : [];
}

function SuppliesCatalog() {
  const toast = useToast();
  const navigate = useNavigate();
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formErr, setFormErr] = useState(null);
  const [unitsProduct, setUnitsProduct] = useState(null);
  const [editProduct, setEditProduct] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/api/products", {
        params: { scope: BAKERY_SCOPE },
        headers: getAuthHeaders(),
      });
      setProducts(unwrapList(data));
      setSearchResults(null);
    } catch (e) {
      toast.error(e.response?.data?.error || "تعذّر التحميل");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const q = search.trim();
    if (!q) {
      setSearchResults(null);
      setSearchLoading(false);
      return undefined;
    }
    setSearchLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const rows = await searchProductsApi(q, { limit: 500, scope: BAKERY_SCOPE });
        setSearchResults(rows);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const list = search.trim() ? (searchResults ?? []) : products;
  const listLoading = search.trim() ? searchLoading || searchResults === null : loading;

  async function addSupply(ev) {
    ev.preventDefault();
    setFormErr(null);
    if (!form.barcode.trim()) { setFormErr("الباركود مطلوب"); return; }
    if (!form.name.trim()) { setFormErr("الاسم مطلوب"); return; }
    if (form.stock === "" || !Number.isFinite(Number(form.stock))) {
      setFormErr("أدخل مخزوناً صالحاً");
      return;
    }
    try {
      const { data } = await api.post(
        "/api/products",
        {
          barcode: form.barcode.trim(),
          name: form.name.trim(),
          price: 0,
          cost: form.cost === "" ? 0 : Number(form.cost),
          stock: Number(form.stock),
          unit: form.unit.trim() || null,
          min_stock: form.min_stock === "" ? null : Number(form.min_stock),
          inventory_scope: BAKERY_SCOPE,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      const created = data?.data ?? data;
      setForm(emptyForm);
      invalidateProductCache(BAKERY_SCOPE);
      toast.success("تمت إضافة المادة");
      await load();
      if (created?.id) setUnitsProduct(created);
    } catch (e) {
      setFormErr(e.response?.data?.error || e.message);
    }
  }

  const columns = [
    { key: "barcode", header: "الباركود" },
    {
      key: "name",
      header: "الاسم",
      render: (p) => (
        <button
          type="button"
          className="ui-link-btn"
          onClick={() => navigate(`/products/${p.id}`)}
        >
          {p.name}
        </button>
      ),
    },
    { key: "unit", header: "الوحدة", render: (p) => p.unit || "—" },
    { key: "stock", header: "المخزون", className: "num" },
    { key: "cost", header: "الكلفة", className: "num", render: (p) => ils(p.cost) },
    { key: "min_stock", header: "حد التنبيه", className: "num", render: (p) => p.min_stock ?? "—" },
    {
      key: "actions",
      header: "إجراءات",
      render: (p) => (
        <div className="ui-table__actions">
          <Button variant="ghost" size="sm" onClick={() => setEditProduct(p)}>تعديل</Button>
          <Button variant="ghost" size="sm" onClick={() => setUnitsProduct(p)}>الوحدات</Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <Card>
        <CardBody>
          <form onSubmit={addSupply}>
            <FormGrid>
              <FormField label="الباركود" required>
                <div className="barcode-input-row">
                  <Input
                    value={form.barcode}
                    onChange={(e) => setForm((f) => ({ ...f, barcode: e.target.value }))}
                  />
                  <CameraBarcodeButton
                    onScan={(code) => setForm((f) => ({ ...f, barcode: normalizeBarcode(code) }))}
                  />
                </div>
              </FormField>
              <FormField label="الاسم" required>
                <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              </FormField>
              <FormField label="الوحدة">
                <Input value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))} placeholder="كغم، كيس…" />
              </FormField>
              <FormField label="الكلفة">
                <Input type="number" step="0.01" min="0" value={form.cost} onChange={(e) => setForm((f) => ({ ...f, cost: e.target.value }))} />
              </FormField>
              <FormField label="المخزون الافتتاحي" required>
                <Input type="number" min="0" value={form.stock} onChange={(e) => setForm((f) => ({ ...f, stock: e.target.value }))} />
              </FormField>
              <FormField label="حد التنبيه (اختياري)">
                <Input type="number" min="0" value={form.min_stock} onChange={(e) => setForm((f) => ({ ...f, min_stock: e.target.value }))} />
              </FormField>
            </FormGrid>
            {formErr ? <p className="ui-field__error">{formErr}</p> : null}
            <PrimaryButton type="submit" style={{ marginTop: "0.75rem" }}>إضافة مادة</PrimaryButton>
          </form>
        </CardBody>
      </Card>

      <div className="ui-toolbar" style={{ marginTop: "1rem", display: "flex", gap: 8, flexWrap: "wrap" }}>
        <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="بحث في مواد المخبز…" />
        <ReportToolbar
          title="مواد المخبز"
          columns={pickExportColumns(columns)}
          rows={list}
          filename="bakery-supplies"
          disabled={listLoading}
        />
      </div>

      <DataTable
        loading={listLoading}
        columns={columns}
        rows={list}
        emptyIcon="inventory"
        empty="لا توجد مواد مخبز بعد"
        emptyHint="أضف مادة من النموذج أعلاه"
        rowClassName={(p) => (Number(p.stock) <= Number(p.min_stock || 0) && p.min_stock != null ? "out-of-stock" : "")}
      />

      {unitsProduct ? (
        <ProductUnitsModal product={unitsProduct} onClose={() => { setUnitsProduct(null); load(); }} />
      ) : null}
      {editProduct ? (
        <EditProductModal
          product={editProduct}
          onClose={() => setEditProduct(null)}
          onSaved={() => { setEditProduct(null); load(); }}
        />
      ) : null}
    </>
  );
}

function BakeryPurchases() {
  const toast = useToast();
  const [list, setList] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [store, setStore] = useState({});
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [supplierId, setSupplierId] = useState("");
  const [docDate, setDocDate] = useState(new Date().toISOString().slice(0, 10));
  const [refText, setRefText] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState([]);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState(null);

  const loadFilteredInvoices = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: invData }, { data: prodData }] = await Promise.all([
        api.get("/api/purchases/invoices", { headers: getAuthHeaders() }),
        api.get("/api/products", { params: { scope: BAKERY_SCOPE }, headers: getAuthHeaders() }),
      ]);
      const invoices = unwrapList(invData);
      const bakeryIds = new Set(unwrapList(prodData).map((p) => p.id));
      const filtered = [];
      for (const inv of invoices) {
        let full = inv;
        if (!inv.items) {
          const { data: d } = await api.get(`/api/purchases/invoices/${inv.id}`, { headers: getAuthHeaders() });
          full = d?.data ?? d;
        }
        const invItems = full.items || [];
        if (invItems.length > 0 && invItems.every((it) => bakeryIds.has(it.product_id))) {
          filtered.push({ ...full, supplier_name: full.supplier_name ?? inv.supplier_name });
        }
      }
      setList(filtered);
    } catch {
      toast.error("تعذّر التحميل");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    api.get("/api/suppliers", { headers: getAuthHeaders() })
      .then(({ data }) => setSuppliers(unwrapList(data)))
      .catch(() => {});
    api.get("/api/settings", { headers: getAuthHeaders() })
      .then(({ data }) => setStore(data || {}))
      .catch(() => {});
    loadFilteredInvoices();
  }, [loadFilteredInvoices]);

  async function persist() {
    if (!supplierId) { toast.error("اختر المورد"); return null; }
    if (items.length === 0) { toast.error("أضف أصنافاً"); return null; }
    setSaving(true);
    const payload = {
      supplier_id: Number(supplierId),
      invoice_date: docDate,
      ref_text: refText,
      notes,
      items: items.map((it) => ({
        product_id: it.product_id,
        quantity: Number(it.quantity),
        unit_id: it.unit_id != null ? Number(it.unit_id) : undefined,
        total_cost: Number(it.total_cost),
        discount_pct: it.discount_pct === "" ? undefined : Number(it.discount_pct),
        bonus_quantity: it.bonus_quantity === "" ? undefined : Number(it.bonus_quantity),
      })),
    };
    try {
      if (editId) {
        await api.put(`/api/purchases/invoices/${editId}`, payload, { headers: getAuthHeaders() });
        toast.success("تم تعديل المسودة");
        return editId;
      }
      const { data } = await api.post("/api/purchases/invoices", payload, { headers: getAuthHeaders() });
      toast.success("تم الحفظ كمسودة");
      return (data?.data ?? data)?.id ?? null;
    } catch (e) {
      toast.error(e.response?.data?.error || "فشل الحفظ");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function save(post) {
    const id = await persist();
    if (id == null) return;
    if (post) {
      try {
        await api.post(`/api/purchases/invoices/${id}/post`, {}, { headers: getAuthHeaders() });
        toast.success("تم الترحيل");
      } catch (e) {
        toast.error(e.response?.data?.error || "فشل الترحيل");
        return;
      }
    }
    setShowForm(false);
    setEditId(null);
    loadFilteredInvoices();
  }

  async function openDetail(id) {
    try {
      const { data } = await api.get(`/api/purchases/invoices/${id}`, { headers: getAuthHeaders() });
      const doc = data?.data ?? data;
      if (doc.status === "draft") {
        setSupplierId(String(doc.supplier_id));
        setDocDate(doc.invoice_date?.slice(0, 10) || docDate);
        setRefText(doc.ref_text || "");
        setNotes(doc.notes || "");
        const mapped = await Promise.all(
          (doc.items || []).map(async (it) => {
            const units = await fetchProductUnits(it.product_id);
            const qty = Number(it.quantity) || 0;
            return {
              product_id: it.product_id,
              name: it.name,
              barcode: it.barcode,
              quantity: it.quantity,
              unit_id: it.product_unit_id ?? pickDefaultPurchaseUnit(units),
              units,
              total_cost: it.total_cost,
              unit_cost: it.unit_cost != null ? it.unit_cost : deriveUnitCost(it.total_cost, qty),
              cost_mode: "total",
              discount_pct: it.discount_pct != null && it.discount_pct !== 0 ? it.discount_pct : "",
              bonus_quantity: it.bonus_quantity != null && it.bonus_quantity !== 0 ? it.bonus_quantity : "",
            };
          })
        );
        setItems(mapped);
        setEditId(id);
        setShowForm(true);
      } else {
        setDetail(doc);
      }
    } catch {
      toast.error("تعذّر التحميل");
    }
  }

  const columns = [
    { key: "invoice_no", header: "رقم", render: (r) => `#${r.invoice_no ?? r.id}` },
    { key: "supplier_name", header: "المورد" },
    { key: "invoice_date", header: "التاريخ", render: (r) => dateOnly(r.invoice_date) },
    { key: "total", header: "الإجمالي", className: "num", render: (r) => ils(r.total) },
    {
      key: "status",
      header: "الحالة",
      render: (r) => <StatusPill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status] || r.status}</StatusPill>,
    },
    {
      key: "actions",
      header: "إجراءات",
      render: (r) => (
        <div className="ui-table__actions">
          <Button variant="ghost" size="sm" onClick={() => openDetail(r.id)}>عرض</Button>
          {r.status === "draft" && (
            <Button variant="outline" size="sm" icon="check" onClick={async () => {
              if (!window.confirm("ترحيل الفاتورة سيحدّث مخزون مواد المخبز. متابعة؟")) return;
              try {
                await api.post(`/api/purchases/invoices/${r.id}/post`, {}, { headers: getAuthHeaders() });
                toast.success("تم الترحيل");
                loadFilteredInvoices();
              } catch (e) {
                toast.error(e.response?.data?.error || "فشل");
              }
            }}>ترحيل</Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <div className="ui-toolbar" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <ReportToolbar title="مشتريات المخبز" columns={pickExportColumns(columns)} rows={list} filename="bakery-purchases" disabled={loading} />
        <Button icon="plus" onClick={() => {
          setEditId(null);
          setSupplierId("");
          setDocDate(new Date().toISOString().slice(0, 10));
          setRefText("");
          setNotes("");
          setItems([]);
          setShowForm(true);
        }}>فاتورة شراء جديدة</Button>
      </div>
      <DataTable columns={columns} rows={list} loading={loading} emptyIcon="purchases" empty="لا توجد فواتير مشتريات للمخبز" />

      <Modal open={showForm} title={editId ? "تعديل فاتورة المخبز" : "فاتورة شراء — مواد المخبز"} onClose={() => { setShowForm(false); setEditId(null); }} size="xl"
        footer={<>
          <Button onClick={() => save(true)} disabled={saving}>ترحيل</Button>
          <Button variant="secondary" onClick={() => save(false)} disabled={saving}>حفظ كمسودة</Button>
          <Button variant="ghost" onClick={() => { setShowForm(false); setEditId(null); }}>إلغاء</Button>
        </>}>
        <FormGrid>
          <FormField label="المورد" required>
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">— اختر —</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </FormField>
          <FormField label="التاريخ"><Input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} /></FormField>
          <FormField label="مرجع الفاتورة"><Input value={refText} onChange={(e) => setRefText(e.target.value)} /></FormField>
        </FormGrid>
        <div style={{ margin: "1rem 0 0.5rem", fontWeight: 700 }}>الأصناف</div>
        <ItemEditor items={items} setItems={setItems} withVat defaultTaxRate={store.default_tax_rate} scope={BAKERY_SCOPE} />
        <FormField label="ملاحظات"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></FormField>
      </Modal>

      <Modal open={!!detail} title={detail ? `فاتورة #${detail.invoice_no ?? detail.id}` : ""} onClose={() => setDetail(null)} size="lg">
        {detail ? (
          <>
            <div className="detail-header">
              <div>المورد: <strong>{detail.supplier_name}</strong></div>
              <StatusPill tone={STATUS_TONE[detail.status]}>{STATUS_LABEL[detail.status]}</StatusPill>
            </div>
            <DataTable
              columns={[
                { key: "name", header: "الصنف" },
                { key: "quantity", header: "الكمية", render: (it) => fmtQty(it.quantity) },
                { key: "total_cost", header: "الكلفة", className: "num", render: (it) => ils(it.total_cost) },
              ]}
              rows={detail.items || []}
              empty="لا توجد أصناف"
            />
          </>
        ) : null}
      </Modal>
    </>
  );
}

function BakeryConsumption() {
  const toast = useToast();
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [show, setShow] = useState(false);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/api/inventory/adjustments", { headers: getAuthHeaders() });
      const rows = unwrapList(data).filter((r) => r.adjustment_type === "consumption");
      setList(rows);
    } catch {
      toast.error("تعذّر التحميل");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  function addProduct(p) {
    setItems((prev) => prev.some((x) => x.product_id === p.id) ? prev : [...prev, { product_id: p.id, name: p.name, quantity: 1 }]);
  }
  const upd = (i, k, v) => setItems((prev) => prev.map((x, idx) => (idx === i ? { ...x, [k]: v } : x)));

  async function save(post) {
    if (items.length === 0) { toast.error("أضف أصنافاً"); return; }
    setSaving(true);
    try {
      await api.post("/api/inventory/adjustments", {
        adjustment_type: "consumption",
        adjustment_date: date,
        notes,
        items: items.map((it) => ({ product_id: it.product_id, quantity: Number(it.quantity) })),
        post,
      }, { headers: getAuthHeaders() });
      toast.success(post ? "تم تسجيل الاستهلاك" : "حُفظت كمسودة");
      setShow(false);
      setItems([]);
      setNotes("");
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || "فشل الحفظ");
    } finally {
      setSaving(false);
    }
  }

  const columns = [
    { key: "adjustment_no", header: "رقم", render: (r) => `#${r.adjustment_no ?? r.id}` },
    { key: "adjustment_date", header: "التاريخ", render: (r) => dateOnly(r.adjustment_date) },
    { key: "item_count", header: "الأصناف" },
    {
      key: "status",
      header: "الحالة",
      render: (r) => <StatusPill tone={r.status === "posted" ? "green" : "neutral"}>{r.status === "posted" ? "مرحّلة" : "مسودة"}</StatusPill>,
    },
  ];

  return (
    <>
      <div className="ui-toolbar" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <ReportToolbar title="استهلاك مواد المخبز" columns={pickExportColumns(columns)} rows={list} filename="bakery-consumption" disabled={loading} />
        <Button icon="plus" onClick={() => { setDate(new Date().toISOString().slice(0, 10)); setNotes(""); setItems([]); setShow(true); }}>تسجيل استهلاك</Button>
      </div>
      <DataTable columns={columns} rows={list} loading={loading} emptyIcon="inventory" empty="لا يوجد استهلاك مسجّل" />

      <Modal open={show} title="تسجيل استهلاك" onClose={() => setShow(false)} size="lg"
        footer={<>
          <Button onClick={() => save(true)} disabled={saving}>ترحيل مباشر</Button>
          <Button variant="secondary" onClick={() => save(false)} disabled={saving}>حفظ كمسودة</Button>
          <Button variant="ghost" onClick={() => setShow(false)}>إلغاء</Button>
        </>}>
        <FormField label="التاريخ"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></FormField>
        <p className="ui-field__hint">سيتم خصم الكميات من مخزون مواد المخبز.</p>
        <div data-enter-nav="" onKeyDown={handleEnterNavKeyDown}>
          <div style={{ margin: "0.75rem 0" }}><ProductPicker onPick={addProduct} scope={BAKERY_SCOPE} placeholder="ابحث عن مادة مخبز…" /></div>
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead><tr><th>الصنف</th><th>الكمية</th><th></th></tr></thead>
              <tbody>
                {items.length === 0 && <tr><td colSpan={3} style={{ textAlign: "center", padding: "1rem", color: "var(--office-panel-muted)" }}>أضف أصنافاً</td></tr>}
                {items.map((it, i) => (
                  <tr key={it.product_id}>
                    <td>{it.name}</td>
                    <td><QtyStepper className="ui-input" style={{ width: 140 }} min={0} value={it.quantity} onChange={(e) => upd(i, "quantity", e.target.value)} /></td>
                    <td><Button variant="ghost" size="sm" icon="trash" onClick={() => setItems((p) => p.filter((_, idx) => idx !== i))} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <FormField label="ملاحظات"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></FormField>
      </Modal>
    </>
  );
}

function BakeryLowStock() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [threshold, setThreshold] = useState(5);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/api/inventory/low-stock?scope=${BAKERY_SCOPE}&threshold=${threshold}`, {
        headers: getAuthHeaders(),
      });
      setRows(unwrapList(data));
    } catch {
      toast.error("تعذّر التحميل");
    } finally {
      setLoading(false);
    }
  }, [threshold, toast]);

  useEffect(() => { load(); }, [load]);

  const columns = useMemo(() => [
    { key: "name", header: "المادة" },
    { key: "barcode", header: "الباركود" },
    { key: "unit", header: "الوحدة", render: (r) => r.unit || "—" },
    { key: "stock", header: "المخزون", className: "num" },
    { key: "min_stock", header: "حد التنبيه", className: "num", render: (r) => r.min_stock ?? threshold },
  ], [threshold]);

  return (
    <>
      <FilterBar actions={<Button onClick={load} disabled={loading}>تحديث</Button>}>
        <FormField label="حد افتراضي (إذا لم يُحدَّد للمادة)">
          <Input type="number" min="0" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
        </FormField>
      </FilterBar>
      <ReportToolbar
        title="تنبيهات مخزون المخبز"
        subtitle={`حد ≤ ${threshold}`}
        columns={pickExportColumns(columns)}
        rows={rows}
        filename="bakery-low-stock"
        disabled={loading}
      />
      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        emptyIcon="inventory"
        empty="لا توجد مواد بمخزون منخفض"
        rowClassName={(r) => (Number(r.stock) === 0 ? "out-of-stock" : "")}
      />
    </>
  );
}

export default function BakerySupplies() {
  const [tab, setTab] = useState("catalog");

  const tabs = useMemo(() => [
    { id: "catalog", label: "المواد", icon: "products" },
    { id: "purchases", label: "مشتريات", icon: "purchases" },
    { id: "consumption", label: "استهلاك", icon: "inventory" },
    { id: "alerts", label: "تنبيهات", icon: "expiry" },
  ], []);

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        icon="inventory"
        title="مواد المخبز"
        subtitle="مخزون منفصل لمواد الإنتاج — شراء، استهلاك، وتنبيهات"
      />
      <Tabs active={tab} onChange={setTab} tabs={tabs} />
      {tab === "catalog" && <SuppliesCatalog />}
      {tab === "purchases" && <BakeryPurchases />}
      {tab === "consumption" && <BakeryConsumption />}
      {tab === "alerts" && <BakeryLowStock />}
    </div>
  );
}
