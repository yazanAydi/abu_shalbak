import { apiErrorMessage } from "../utils/apiError";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders, getUser } from "../utils/auth";
import { userHasOfficePermission } from "../utils/accountantPermissions";
import { isAdminRole } from "../utils/roles";
import { searchProductsApi } from "../utils/productSearch";
import { todayISO, ils, dateOnly } from "../utils/format";
import { getDatePresets, todayYmd, firstOfCurrentMonthYmd } from "../utils/reportDates";
import {
  BAKERY_MATERIAL_SALES_EMPTY,
  bakeryExportColumns,
  bakeryPrintMeta,
  bakeryRevenueKindLabel,
  bakerySummaryItems,
  formatQtyByUnit,
  formatQtyWithUnit,
} from "./bakeryReportView";
import ProductPicker from "../components/ProductPicker";
import QtyStepper from "../components/QtyStepper";
import { invalidateProductCache } from "../components/ProductPicker";
import ProductUnitsModal from "./productDashboard/ProductUnitsModal";
import EditProductModal from "./productDashboard/EditProductModal";
import UnitNameSelect from "../components/UnitNameSelect";
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
  Textarea,
  ReportToolbar,
  FilterBar,
  useToast,
  Card,
  CardHeader,
  CardBody,
  PrimaryButton,
  SecondaryButton,
  DangerButton,
  SearchInput,
  DateField,
  StatCard,
  EmptyState,
  Skeleton,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";
import { handleEnterNavKeyDown } from "../utils/focusNavigation";
import CameraBarcodeButton from "../components/barcode/CameraBarcodeButton";
import { normalizeBarcode } from "../utils/barcode";

const BAKERY_SCOPE = "bakery";

const emptyForm = {
  barcode: "",
  name: "",
  price: "",
  cost: "",
  unit: "",
  stock: "",
  min_stock: "",
};

function unwrapList(data) {
  const rows = data?.data ?? data;
  if (Array.isArray(rows)) return rows;
  if (Array.isArray(rows?.items)) return rows.items;
  return [];
}

function unwrapPage(data) {
  const body = data?.data ?? data;
  if (Array.isArray(body?.items)) {
    return { items: body.items, total: Number(body.total) || body.items.length };
  }
  const rows = Array.isArray(body) ? body : [];
  return { items: rows, total: rows.length };
}

function isPosAvailable(value) {
  return value === true || value === 1 || value === "1" || Number(value) === 1;
}

function withPosFlag(product, enabled) {
  return { ...product, pos_available: enabled ? 1 : 0 };
}

function productUnitsFromResponse(data) {
  if (Array.isArray(data?.units)) return data.units;
  if (Array.isArray(data?.data?.units)) return data.data.units;
  if (Array.isArray(data)) return data;
  return [];
}

function PosAvailableToggle({ product, disabled, onToggle }) {
  const [on, setOn] = useState(() => isPosAvailable(product.pos_available));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setOn(isPosAvailable(product.pos_available));
  }, [product.id, product.pos_available]);

  async function change(next) {
    if (busy || disabled) return;
    setOn(next);
    setBusy(true);
    try {
      await onToggle(product, next);
    } catch {
      setOn(!next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="ui-checkbox-label">
      <input
        className="ui-check"
        type="checkbox"
        checked={on}
        disabled={disabled || busy}
        onChange={(e) => change(e.target.checked)}
      />
      <span>{on ? "نعم" : "لا"}</span>
    </label>
  );
}

function SuppliesCatalog({ kind = "workspace", canWriteMaterials, canWriteProducts }) {
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
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deletePw, setDeletePw] = useState("");
  const [deletePwError, setDeletePwError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const canAdminProducts = isAdminRole(getUser()?.role);

  const listParams = useMemo(() => {
    if (kind === "materials") return { membership: "bakery", kind: "materials", limit: 50, offset: 0 };
    if (kind === "finished") return { membership: "bakery", kind: "finished", limit: 50, offset: 0 };
    return { membership: "bakery", kind: "workspace", limit: 50, offset: 0 };
  }, [kind]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/api/products", {
        params: listParams,
        headers: getAuthHeaders(),
      });
      const page = unwrapPage(data);
      setProducts(page.items);
      setSearchResults(null);
    } catch (e) {
      toast.error(apiErrorMessage(e, "تعذّر التحميل"));
    } finally {
      setLoading(false);
    }
  }, [toast, listParams]);

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
        const rows = await searchProductsApi(q, { limit: 50, membership: "bakery", kind });
        setSearchResults(rows);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search, kind]);

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
    const price = form.price === "" ? 0 : Number(form.price);
    if (!Number.isFinite(price) || price < 0) {
      setFormErr("أدخل سعر بيع صالحاً");
      return;
    }
    try {
      const { data } = await api.post(
        "/api/products",
        {
          barcode: form.barcode.trim(),
          name: form.name.trim(),
          price,
          cost: form.cost === "" ? 0 : Number(form.cost),
          stock: Number(form.stock),
          unit: form.unit.trim() || null,
          min_stock: form.min_stock === "" ? null : Number(form.min_stock),
          inventory_scope: kind === "finished" ? "retail" : BAKERY_SCOPE,
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
      setFormErr(apiErrorMessage(e));
    }
  }

  function patchPosFlag(productId, enabled) {
    const apply = (rows) =>
      (rows || []).map((row) => (Number(row.id) === Number(productId) ? withPosFlag(row, enabled) : row));
    setProducts((rows) => apply(rows));
    setSearchResults((rows) => (rows ? apply(rows) : rows));
  }

  async function togglePos(product, enabled) {
    const { data } = await api.get(`/api/products/${product.id}/units`, { headers: getAuthHeaders() });
    const units = productUnitsFromResponse(data);
    const targets = enabled
      ? [units.find((u) => u.is_default) || units[0]].filter(Boolean)
      : units.filter((u) => u?.id);
    if (!targets.length) {
      toast.error("لا توجد وحدة لتحديث إتاحة الكاشير");
      throw new Error("no unit");
    }
    try {
      for (const unit of targets) {
        await api.put(
          `/api/products/${product.id}/units/${unit.id}`,
          { sale_enabled: enabled },
          { headers: getAuthHeaders() }
        );
      }
      patchPosFlag(product.id, enabled);
      toast.success(enabled ? "متاح للبيع في الكاشير" : "أُخفي عن الكاشير");
    } catch (e) {
      toast.error(apiErrorMessage(e, "تعذّر تحديث إتاحة الكاشير"));
      throw e;
    }
  }

  const rowCanWrite = (p) =>
    String(p.inventory_scope || "retail") === "bakery" ? canWriteMaterials : canWriteProducts;

  function requestDelete(product) {
    if (!product?.id || !canAdminProducts) return;
    setDeletePw("");
    setDeletePwError(null);
    setPendingDelete(product);
  }

  function cancelDelete() {
    setPendingDelete(null);
    setDeletePw("");
    setDeletePwError(null);
  }

  function removeLocal(productId) {
    setProducts((rows) => (rows || []).filter((row) => Number(row.id) !== Number(productId)));
    setSearchResults((rows) => (rows ? rows.filter((row) => Number(row.id) !== Number(productId)) : rows));
  }

  async function confirmDelete() {
    if (!pendingDelete?.id) return;
    if (!deletePw) {
      setDeletePwError("كلمة المرور مطلوبة");
      return;
    }
    setDeleting(true);
    try {
      await api.delete(`/api/admin/products/${pendingDelete.id}`, {
        headers: { ...getAuthHeaders(), "X-Confirm-Password": deletePw },
      });
      removeLocal(pendingDelete.id);
      invalidateProductCache();
      toast.success("تم الحذف");
      cancelDelete();
      await load();
    } catch (e) {
      toast.error(apiErrorMessage(e, "تعذّر الحذف"));
    } finally {
      setDeleting(false);
    }
  }

  const columns = [
    { key: "barcode", header: "الباركود" },
    {
      key: "name",
      header: "الاسم",
      render: (p) =>
        userHasOfficePermission(getUser(), "products") ? (
        <button
          type="button"
          className="ui-link-btn"
          onClick={() => navigate(`/products/${p.id}`)}
        >
          {p.name}
        </button>
        ) : (
          p.name
        ),
    },
    { key: "unit", header: "الوحدة", render: (p) => p.unit || "—" },
    { key: "stock", header: "المخزون", className: "num" },
    { key: "price", header: "سعر البيع", className: "num", render: (p) => ils(p.price) },
    { key: "cost", header: "الكلفة", className: "num", render: (p) => ils(p.cost) },
    {
      key: "kind",
      header: "النوع",
      render: (p) => (String(p.inventory_scope || "retail") === "bakery" ? "مادة" : "صنف بيع"),
    },
    {
      key: "pos_available",
      header: "متاح للكاشير",
      render: (p) => {
        const material = String(p.inventory_scope || "retail") === "bakery";
        if (!material) return "نعم";
        if (!rowCanWrite(p)) return isPosAvailable(p.pos_available) ? "نعم" : "لا";
        return <PosAvailableToggle product={p} onToggle={togglePos} />;
      },
    },
    { key: "min_stock", header: "حد التنبيه", className: "num", render: (p) => p.min_stock ?? "—" },
    {
      key: "actions",
      header: "إجراءات",
      render: (p) => {
        const canEdit = rowCanWrite(p);
        if (!canEdit && !canAdminProducts) return "—";
        return (
          <div className="ui-table__actions">
            {canEdit ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => setEditProduct(p)}>تعديل</Button>
                <Button variant="ghost" size="sm" onClick={() => setUnitsProduct(p)}>الوحدات</Button>
              </>
            ) : null}
            {canAdminProducts ? (
              <DangerButton size="sm" type="button" onClick={() => requestDelete(p)}>حذف</DangerButton>
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <>
      {canWriteMaterials && kind !== "finished" ? (
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
                <UnitNameSelect
                  value={form.unit}
                  onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
                />
              </FormField>
              <FormField label="سعر البيع" hint="سعر الكاشير لهذه المادة — يمكن إبقاؤه صفراً إذا لم تُباع">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.price}
                  onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                />
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
      ) : null}

      <div className="ui-toolbar" style={{ marginTop: "1rem", display: "flex", gap: 8, flexWrap: "wrap" }}>
        <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="بحث في أصناف المخبز…" />
        <ReportToolbar
          title="أصناف المخبز"
          columns={pickExportColumns(columns)}
          rows={list}
          filename="bakery-catalog"
          disabled={listLoading}
        />
      </div>

      <DataTable
        loading={listLoading}
        columns={columns}
        rows={list}
        emptyIcon="inventory"
        empty="لا توجد أصناف مخبز مطابقة"
        emptyHint="أضف مادة من النموذج أعلاه"
        rowClassName={(p) => (Number(p.stock) <= Number(p.min_stock || 0) && p.min_stock != null ? "out-of-stock" : "")}
      />

      <ProductUnitsModal
        open={!!unitsProduct}
        product={unitsProduct}
        onClose={() => { setUnitsProduct(null); load(); }}
        onChanged={load}
      />
      <EditProductModal
        open={!!editProduct}
        product={editProduct}
        onClose={() => setEditProduct(null)}
        onSaved={() => { setEditProduct(null); load(); }}
      />
      <Modal
        open={!!pendingDelete}
        onClose={cancelDelete}
        title="تأكيد الحذف"
        footer={
          <>
            <SecondaryButton type="button" onClick={cancelDelete} disabled={deleting}>
              إلغاء
            </SecondaryButton>
            <DangerButton type="button" onClick={confirmDelete} disabled={deleting}>
              {deleting ? "جارٍ الحذف…" : "تأكيد الحذف"}
            </DangerButton>
          </>
        }
      >
        <p>
          {pendingDelete
            ? `سيتم حذف «${pendingDelete.name}» نهائياً.`
            : "سيتم حذف هذا المنتج نهائياً."}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            confirmDelete();
          }}
        >
          <FormField label="كلمة مرور الحذف" required error={deletePwError}>
            <Input
              type="password"
              value={deletePw}
              autoFocus
              invalid={Boolean(deletePwError)}
              onChange={(e) => {
                setDeletePw(e.target.value);
                if (deletePwError) setDeletePwError(null);
              }}
              placeholder="أدخل كلمة المرور للمتابعة"
            />
          </FormField>
        </form>
      </Modal>
    </>
  );
}

function BakeryConsumption() {
  const toast = useToast();
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [show, setShow] = useState(false);
  const [date, setDate] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState([]);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailLoadingId, setDetailLoadingId] = useState(null);

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

  async function openDetail(id) {
    setDetailLoadingId(id);
    try {
      const { data } = await api.get(`/api/inventory/adjustments/${id}`, { headers: getAuthHeaders() });
      setDetail(data);
    } catch (e) {
      toast.error(apiErrorMessage(e, "تعذّر تحميل التفاصيل"));
    } finally {
      setDetailLoadingId(null);
    }
  }

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
      toast.error(apiErrorMessage(e, "فشل الحفظ"));
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
    {
      key: "actions",
      header: "إجراءات",
      render: (r) => (
        <div className="ui-table__actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={detailLoadingId === r.id}
            onClick={() => openDetail(r.id)}
          >
            {detailLoadingId === r.id ? "جاري التحميل…" : "تفاصيل"}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <div className="ui-toolbar" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <ReportToolbar title="استهلاك مواد المخبز" columns={pickExportColumns(columns)} rows={list} filename="bakery-consumption" disabled={loading} />
        <Button icon="plus" onClick={() => { setDate(todayISO()); setNotes(""); setItems([]); setShow(true); }}>تسجيل استهلاك</Button>
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
                    <td><Button variant="ghost" size="sm" icon="trash" aria-label="حذف" onClick={() => setItems((p) => p.filter((_, idx) => idx !== i))} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <FormField label="ملاحظات"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></FormField>
      </Modal>

      <Modal
        open={!!detail}
        title={detail ? `استهلاك #${detail.adjustment_no ?? detail.id}` : ""}
        onClose={() => setDetail(null)}
        footer={<Button variant="ghost" onClick={() => setDetail(null)}>إغلاق</Button>}
      >
        {detail ? (
          <>
            <dl
              className="pd-kv"
              style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.35rem 1.5rem", marginBottom: "1.25rem" }}
            >
              <dt>بواسطة</dt>
              <dd>{detail.created_by_name || "—"}</dd>
              <dt>التاريخ</dt>
              <dd>{dateOnly(detail.adjustment_date)}</dd>
              <dt>الحالة</dt>
              <dd>
                <StatusPill tone={detail.status === "posted" ? "green" : "neutral"}>
                  {detail.status === "posted" ? "مرحّلة" : "مسودة"}
                </StatusPill>
              </dd>
              {detail.notes ? (
                <>
                  <dt>الملاحظات</dt>
                  <dd>{detail.notes}</dd>
                </>
              ) : null}
            </dl>
            <h3 className="ui-section">الأصناف والكميات</h3>
            <DataTable
              columns={[
                { key: "name", header: "الصنف", nameColumn: true, wrap: true },
                { key: "barcode", header: "الباركود", render: (it) => it.barcode || "—" },
                {
                  key: "quantity",
                  header: "الكمية",
                  align: "left",
                  render: (it) => formatQtyWithUnit(it.quantity, it.unit),
                },
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

function BakeryLowStock() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [threshold, setThreshold] = useState(5);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/api/inventory/low-stock?membership=bakery&threshold=${threshold}`, {
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

function BakeryMaterialSales() {
  const presets = useMemo(() => getDatePresets(), []);
  const [from, setFrom] = useState(firstOfCurrentMonthYmd());
  const [to, setTo] = useState(todayYmd());
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const loadReport = useCallback(async () => {
    if (!from || !to) {
      setErr("حدد تاريخ البداية والنهاية");
      setLoading(false);
      return;
    }
    if (from > to) {
      setErr("تاريخ البداية يجب أن يسبق النهاية");
      setLoading(false);
      return;
    }
    setLoading(true);
    setErr("");
    try {
      const { data } = await api.get("/api/reports/bakery", {
        params: { from, to, revenue_kind: "material" },
        headers: getAuthHeaders(),
      });
      setReport(data);
    } catch (e) {
      setErr(apiErrorMessage(e, "تعذّر تحميل مبيعات المواد"));
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  function applyPreset(preset) {
    if (preset.mode === "day") {
      const date = preset.date || todayYmd();
      setFrom(date);
      setTo(date);
      return;
    }
    setFrom(preset.from || firstOfCurrentMonthYmd());
    setTo(preset.to || todayYmd());
  }

  const kpis = report?.kpis;
  const rows = report?.products || [];
  const columns = useMemo(
    () => [
      { key: "name", header: "المنتج" },
      {
        key: "revenue_kind",
        header: "النوع",
        render: (r) => (
          <StatusPill tone="orange" noDot>
            {bakeryRevenueKindLabel(r.revenue_kind)}
          </StatusPill>
        ),
      },
      { key: "barcode", header: "الباركود", render: (r) => r.barcode || "—" },
      { key: "unit", header: "الوحدة" },
      {
        key: "sold_quantity",
        header: "الكمية المباعة",
        className: "num",
        render: (r) => formatQtyWithUnit(r.sold_quantity, r.unit),
      },
      {
        key: "refunded_quantity",
        header: "الكمية المرتجعة",
        className: "num",
        render: (r) => formatQtyWithUnit(r.refunded_quantity, r.unit),
      },
      {
        key: "net_quantity",
        header: "صافي الكمية المباعة",
        className: "num",
        render: (r) => formatQtyWithUnit(r.net_quantity, r.unit),
      },
      {
        key: "net_revenue",
        header: "صافي المبيعات",
        className: "num",
        render: (r) => ils(r.net_revenue),
      },
      { key: "invoice_count", header: "عدد الفواتير", className: "num" },
    ],
    []
  );

  return (
    <>
      <FilterBar
        className="ui-mt-md"
        actions={
          <>
            {presets.map((p) => (
              <SecondaryButton key={p.id} type="button" onClick={() => applyPreset(p)}>
                {p.label}
              </SecondaryButton>
            ))}
            <PrimaryButton type="button" onClick={loadReport} disabled={loading}>
              {loading ? "جاري التحميل…" : "تحديث"}
            </PrimaryButton>
          </>
        }
      >
        <FormField label="من تاريخ">
          <DateField value={from} onChange={(e) => setFrom(e.target.value)} />
        </FormField>
        <FormField label="إلى تاريخ">
          <DateField value={to} onChange={(e) => setTo(e.target.value)} />
        </FormField>
      </FilterBar>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
        <ReportToolbar
          title="مبيعات المواد"
          subtitle="إيراد بيع مواد المخبز المتاحة للكاشير — بدون مشتريات أو استهلاك"
          columns={bakeryExportColumns()}
          rows={rows}
          filename="bakery-material-sales"
          summary={bakerySummaryItems(kpis, { slice: "material" })}
          meta={bakeryPrintMeta({ from, to, report })}
          disabled={loading}
        />
      </div>

      {err ? <EmptyState title={err} className="ui-mt-md" /> : null}

      {loading ? (
        <div className="ui-mt-md">
          <Skeleton style={{ height: 120, marginBottom: 16 }} />
          <Skeleton style={{ height: 240 }} />
        </div>
      ) : null}

      {!loading && !err && report ? (
        <>
          <div className="ui-stat-grid ui-mt-md">
            <StatCard
              label="إيراد بيع المواد"
              value={ils(kpis?.material_net_revenue ?? kpis?.net_revenue)}
              icon="finance"
              tone="green"
            />
            <StatCard
              label="الكمية المباعة"
              value={formatQtyByUnit(kpis?.sold_quantity_by_unit)}
              icon="inventory"
            />
            <StatCard
              label="عدد الفواتير"
              value={String(kpis?.invoice_count ?? 0)}
              icon="finance"
            />
          </div>
          <Card className="ui-mt-md">
            <CardHeader title="مبيعات المواد" />
            <CardBody>
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={(r) => r.product_id}
                empty={BAKERY_MATERIAL_SALES_EMPTY}
                emptyIcon="inventory"
              />
            </CardBody>
          </Card>
        </>
      ) : null}
    </>
  );
}

export default function BakerySupplies() {
  const [searchParams, setSearchParams] = useSearchParams();
  const user = getUser();
  const canWriteMaterials = userHasOfficePermission(user, "bakery_supplies");
  const canWriteProducts = userHasOfficePermission(user, "products");
  const kindParam = searchParams.get("kind");
  const initialKind = ["materials", "finished", "workspace", "material_sales"].includes(kindParam)
    ? kindParam
    : "workspace";
  const [tab, setTab] = useState(
    initialKind === "materials"
      ? "materials"
      : initialKind === "finished"
        ? "finished"
        : initialKind === "material_sales"
          ? "material_sales"
          : "catalog"
  );

  useEffect(() => {
    if (kindParam === "materials") setTab("materials");
    if (kindParam === "finished") setTab("finished");
    if (kindParam === "material_sales") setTab("material_sales");
  }, [kindParam]);

  const tabs = useMemo(() => [
    { id: "catalog", label: "الكل", icon: "products" },
    { id: "finished", label: "أصناف البيع", icon: "finance" },
    { id: "materials", label: "المواد", icon: "inventory" },
    { id: "material_sales", label: "مبيعات المواد", icon: "finance" },
    ...(canWriteMaterials ? [{ id: "consumption", label: "استهلاك", icon: "inventory" }] : []),
    { id: "alerts", label: "تنبيهات", icon: "expiry" },
  ], [canWriteMaterials]);

  function changeTab(next) {
    setTab(next);
    if (next === "materials" || next === "finished" || next === "material_sales") {
      setSearchParams({ kind: next }, { replace: true });
    } else {
      setSearchParams({}, { replace: true });
    }
  }

  const catalogKind = tab === "materials" ? "materials" : tab === "finished" ? "finished" : "workspace";

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        icon="inventory"
        title="الأصناف والمخزون"
        subtitle="مواد المخبز وأصناف البيع — نفس السجل والأسعار والوحدات"
      />
      <Tabs active={tab} onChange={changeTab} tabs={tabs} />
      {(tab === "catalog" || tab === "materials" || tab === "finished") && (
        <SuppliesCatalog
          kind={catalogKind}
          canWriteMaterials={canWriteMaterials}
          canWriteProducts={canWriteProducts}
        />
      )}
      {tab === "material_sales" && <BakeryMaterialSales />}
      {tab === "consumption" && <BakeryConsumption />}
      {tab === "alerts" && <BakeryLowStock />}
    </div>
  );
}
