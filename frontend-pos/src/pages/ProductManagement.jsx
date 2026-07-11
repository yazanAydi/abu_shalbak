import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { searchProductsApi } from "../utils/productSearch";
import { ils } from "../utils/format";
import {
  PageHeader,
  Card,
  CardBody,
  DataTable,
  SearchInput,
  FormField,
  FormGrid,
  Input,
  PrimaryButton,
  SecondaryButton,
  DangerButton,
  ReportToolbar,
  Modal,
  useToast,
} from "../components/ui";
import EditProductModal from "./productDashboard/EditProductModal";
import ProductUnitsModal from "./productDashboard/ProductUnitsModal";
import DuplicateBarcodeConflict from "./productDashboard/DuplicateBarcodeConflict";
import EditBarcodeModal from "./productDashboard/EditBarcodeModal";
import ImportSummaryModal from "./productDashboard/ImportSummaryModal";
import { pickExportColumns } from "../utils/reportExport";
import "./productDashboard/productBarcodes.css";
import CameraBarcodeButton from "../components/barcode/CameraBarcodeButton";
import { normalizeBarcode } from "../utils/barcode";
import { displayEntityCode, displayListRowNumber } from "../utils/entityCodeDisplay";
import "../components/barcode/barcode-scanner.css";

const PAGE = 50;

// UI-only gate matching the requested admin password. The backend still
// enforces a valid admin JWT on the delete endpoint, so this is not the
// actual security boundary.
const ADMIN_DELETE_PASSWORD = "admin123";

const emptyForm = {
  barcode: "",
  sku: "",
  name: "",
  name_en: "",
  price: "",
  cost: "",
  category: "",
  stock: "",
  tax_rate: "",
  unit: "",
  expiry_date: "",
  min_price: "",
  max_price: "",
  is_weighed: false,
};


async function lookupProductByBarcodeApi(barcode) {
  const code = normalizeBarcode(barcode);
  if (!code) return null;
  try {
    const { data } = await api.get(`/api/products/${encodeURIComponent(code)}`, {
      headers: getAuthHeaders(),
    });
    return data;
  } catch (e) {
    if (e.response?.status === 404) return null;
    throw e;
  }
}

async function fetchSuggestedBarcode() {
  try {
    const { data } = await api.get("/api/products/next-barcode", {
      headers: getAuthHeaders(),
    });
    return data?.barcode ?? "";
  } catch {
    return "";
  }
}

async function freshAddForm() {
  const barcode = await fetchSuggestedBarcode();
  return { ...emptyForm, barcode };
}

function formToPayload(form) {
  return {
    barcode: form.barcode.trim(),
    sku: form.sku?.trim() || null,
    name: form.name.trim(),
    name_en: form.name_en?.trim() || null,
    price: Number(form.price),
    cost: form.cost === "" ? 0 : Number(form.cost),
    category: form.category.trim() || null,
    stock: Number(form.stock),
    tax_rate: form.tax_rate !== "" ? Number(form.tax_rate) : null,
    unit: form.is_weighed ? "كغم" : form.unit?.trim() || null,
    expiry_date: form.expiry_date?.trim() || null,
    min_price: form.min_price !== "" ? Number(form.min_price) : null,
    max_price: form.max_price !== "" ? Number(form.max_price) : null,
    is_weighed: form.is_weighed ? 1 : 0,
  };
}

function validateAddForm(form) {
  const name = form.name.trim();
  if (!form.barcode.trim()) return "الباركود مطلوب";
  if (!name) return "الاسم مطلوب";
  if (form.price === "" || !Number.isFinite(Number(form.price)) || Number(form.price) < 0) {
    return "أدخل سعر بيع صالحاً";
  }
  if (form.stock === "" || !Number.isFinite(Number(form.stock))) {
    return "أدخل مخزوناً صالحاً";
  }
  return null;
}

export default function ProductManagement() {
  const toast = useToast();
  const navigate = useNavigate();
  const [products, setProducts] = useState([]);
  const [searchResults, setSearchResults] = useState(null);
  const [loading, setLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [uploadFeedback, setUploadFeedback] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [importSummary, setImportSummary] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [formErr, setFormErr] = useState(null);
  const [editProduct, setEditProduct] = useState(null);
  const [unitsProduct, setUnitsProduct] = useState(null);
  const [conflictProduct, setConflictProduct] = useState(null);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [editBarcodeProduct, setEditBarcodeProduct] = useState(null);
  const [showNeedsReviewOnly, setShowNeedsReviewOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [pendingDelete, setPendingDelete] = useState(null);
  const [pw, setPw] = useState("");
  const [pwError, setPwError] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/api/products", {
        headers: getAuthHeaders(),
      });
      setProducts(Array.isArray(data) ? data : []);
      setSearchResults(null);
    } catch (e) {
      toast.error(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    fetchSuggestedBarcode().then((barcode) => {
      if (!cancelled && barcode) {
        setForm((f) => (f.barcode ? f : { ...f, barcode }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
        const rows = await searchProductsApi(q, { limit: 500 });
        setSearchResults(rows);
      } catch (e) {
        toast.error(e.response?.data?.error || e.message);
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);

    return () => window.clearTimeout(timer);
  }, [search, toast]);

  const isSearchActive = Boolean(search.trim());
  const baseList = isSearchActive ? (searchResults ?? []) : products;
  const filtered = showNeedsReviewOnly
    ? baseList.filter((p) => Number(p.needs_review) === 1)
    : baseList;
  const listLoading = isSearchActive
    ? searchLoading || searchResults === null
    : loading;

  const pageSlice = useMemo(() => {
    const start = page * PAGE;
    return filtered.slice(start, start + PAGE);
  }, [filtered, page]);

  useEffect(() => {
    setPage(0);
    setSelectedIds(new Set());
  }, [search]);

  useEffect(() => {
    const code = form.barcode.trim();
    if (!code) {
      setConflictProduct(null);
      return undefined;
    }
    const timer = window.setTimeout(async () => {
      try {
        const hit = await lookupProductByBarcodeApi(code);
        setConflictProduct(hit);
      } catch {
        setConflictProduct(null);
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [form.barcode]);

  async function onUpload(ev) {
    const file = ev.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadFeedback(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const { data } = await api.post("/api/admin/products/upload", fd);
      setUploadFeedback({
        ok: true,
        text: data.message || `تمت إضافة ${data.inserted} منتجًا`,
      });
      setImportSummary(data);
      await load();
    } catch (e) {
      if (e.response?.status === 401) {
        setUploadFeedback({
          ok: false,
          text:
            "انتهت الجلسة أو غير صالحة — سجّل الخروج ثم الدخول كمسؤول وأعد رفع الملف.",
        });
        return;
      }
      const noResponse = !e.response;
      const net =
        noResponse &&
        (e.code === "ERR_NETWORK" ||
          String(e.message || "").includes("Network Error"));
      const text = net
        ? "تعذّر الاتصال بالخادم. شغّل الخادم في طرفية أخرى: من مجلد backend نفّذ npm start — اتركه يعمل (مثلاً المنفذ 5000) ثم أعد المحاولة."
        : e.response?.data?.detail ||
          e.response?.data?.error ||
          e.message ||
          "فشل الرفع";
      setUploadFeedback({ ok: false, text });
    } finally {
      setUploading(false);
      ev.target.value = "";
    }
  }

  async function addProduct(ev) {
    ev.preventDefault();
    setFormErr(null);

    const validationErr = validateAddForm(form);
    if (validationErr) {
      setFormErr(validationErr);
      return;
    }

    if (conflictProduct) {
      setFormErr("الباركود مستخدم لمنتج موجود — اختر إجراءً من اللوحة أدناه");
      return;
    }

    try {
      const { data: created } = await api.post(
        "/api/products",
        formToPayload(form),
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      setForm(await freshAddForm());
      setConflictProduct(null);
      toast.success("تمت إضافة المنتج");
      await load();
      if (created?.id) setUnitsProduct(created);
    } catch (e) {
      if (e.response?.status === 409) {
        const existing = await lookupProductByBarcodeApi(form.barcode);
        if (existing) {
          setConflictProduct(existing);
          setFormErr("الباركود مستخدم لمنتج موجود — اختر إجراءً من اللوحة أدناه");
          return;
        }
      }
      setFormErr(e.response?.data?.error || e.message);
    }
  }

  async function handleReplaceConflict() {
    if (!conflictProduct) return;
    setFormErr(null);

    const validationErr = validateAddForm(form);
    if (validationErr) {
      setFormErr(validationErr);
      return;
    }

    setConflictBusy(true);
    try {
      await api.put(
        `/api/products/${conflictProduct.id}`,
        formToPayload(form),
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      setForm(await freshAddForm());
      setConflictProduct(null);
      toast.success("تم استبدال المنتج");
      await load();
    } catch (e) {
      setFormErr(e.response?.data?.error || e.message);
    } finally {
      setConflictBusy(false);
    }
  }

  async function handleDeleteConflict() {
    if (!conflictProduct) return;
    if (!window.confirm(`حذف المنتج «${conflictProduct.name}»؟`)) return;

    setConflictBusy(true);
    setFormErr(null);
    try {
      await api.delete(`/api/admin/products/${conflictProduct.id}`, {
        headers: getAuthHeaders(),
      });
      setConflictProduct(null);
      toast.success("تم الحذف — يمكنك الآن إضافة المنتج");
      await load();
    } catch (e) {
      setFormErr(e.response?.data?.error || e.message);
    } finally {
      setConflictBusy(false);
    }
  }

  function handleEditBarcodeSaved() {
    setEditBarcodeProduct(null);
    setConflictProduct(null);
    load();
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function toggleSelect(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllOnPage(checked) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const p of pageSlice) {
        if (checked) next.add(p.id);
        else next.delete(p.id);
      }
      return next;
    });
  }

  function requestDelete(mode, ids) {
    if (!ids || ids.length === 0) return;
    setPw("");
    setPwError(null);
    setPendingDelete({ mode, ids });
  }

  function cancelDelete() {
    setPendingDelete(null);
    setPw("");
    setPwError(null);
  }

  async function runDelete(ids) {
    try {
      if (ids.length > 1) {
        await api.post(
          "/api/admin/products/bulk-delete",
          { ids },
          { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
        );
      } else {
        await api.delete(`/api/admin/products/${ids[0]}`, {
          headers: getAuthHeaders(),
        });
      }
      toast.success(ids.length > 1 ? `تم حذف ${ids.length} منتجًا` : "تم الحذف");
      clearSelection();
      await load();
    } catch (e) {
      toast.error(e.response?.data?.error || e.message);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    if (pw !== ADMIN_DELETE_PASSWORD) {
      setPwError("كلمة المرور غير صحيحة");
      return;
    }
    setDeleting(true);
    try {
      await runDelete(pendingDelete.ids);
      cancelDelete();
    } finally {
      setDeleting(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE));

  async function toggleActive(p) {
    const next = Number(p.is_active) === 0 ? 1 : 0;
    try {
      await api.patch(
        `/api/products/${p.id}/active`,
        { is_active: next },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      toast.success(next ? "تم تفعيل المنتج" : "تم إيقاف المنتج");
      await load();
    } catch (e) {
      toast.error(e.response?.data?.error || e.message);
    }
  }

  const allOnPageSelected =
    pageSlice.length > 0 && pageSlice.every((p) => selectedIds.has(p.id));

  const columns = [
    {
      key: "select",
      header: (
        <input
          type="checkbox"
          aria-label="تحديد كل المنتجات في الصفحة"
          checked={allOnPageSelected}
          onChange={(e) => toggleSelectAllOnPage(e.target.checked)}
        />
      ),
      render: (p) => (
        <input
          type="checkbox"
          aria-label={`تحديد ${p.name}`}
          checked={selectedIds.has(p.id)}
          onChange={() => toggleSelect(p.id)}
        />
      ),
    },
    { key: "barcode", header: "الباركود" },
    {
      key: "sku",
      header: "الرقم",
      className: "num",
      value: (p) => displayEntityCode(p.sku),
      render: (p, i) => displayListRowNumber(page, PAGE, i),
    },
    {
      key: "name",
      header: "الاسم",
      render: (p) => (
        <button
          type="button"
          onClick={() => navigate(`/products/${p.id}`)}
          title="عرض لوحة المنتج 360"
          style={{
            background: "none",
            border: "none",
            padding: 0,
            color: "var(--office-accent, #0f766e)",
            fontWeight: 600,
            cursor: "pointer",
            font: "inherit",
            textAlign: "right",
          }}
        >
          {p.name}
          {Number(p.needs_review) === 1 ? (
            <span style={{ marginInlineStart: "0.35rem", color: "#b45309", fontSize: "0.85em" }}>
              (يحتاج مراجعة)
            </span>
          ) : null}
        </button>
      ),
    },
    {
      key: "price",
      header: "السعر",
      className: "num",
      value: (p) => ils(p.price),
      render: (p) => ils(p.price),
    },
    { key: "stock", header: "المخزون", className: "num" },
    {
      key: "is_active",
      header: "الحالة",
      value: (p) => (Number(p.is_active) === 0 ? "غير نشط" : "نشط"),
      render: (p) => (Number(p.is_active) === 0 ? "غير نشط" : "نشط"),
    },
    {
      key: "actions",
      header: "",
      render: (p) => (
        <div className="ui-table__actions">
          <SecondaryButton size="sm" type="button" onClick={() => navigate(`/products/${p.id}`)}>
            تفاصيل
          </SecondaryButton>
          <SecondaryButton size="sm" type="button" onClick={() => setEditProduct(p)}>
            تعديل
          </SecondaryButton>
          <SecondaryButton size="sm" type="button" onClick={() => toggleActive(p)}>
            {Number(p.is_active) === 0 ? "تفعيل" : "إيقاف"}
          </SecondaryButton>
          <DangerButton size="sm" type="button" onClick={() => requestDelete("single", [p.id])}>
            حذف
          </DangerButton>
        </div>
      ),
    },
  ];

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title="إدارة المنتجات"
        subtitle="المنتجات والباركود والمخزون"
        icon="products"
        actions={
          <ReportToolbar
            title="إدارة المنتجات"
            subtitle={search.trim() ? `بحث: ${search.trim()}` : undefined}
            columns={pickExportColumns(columns)}
            rows={filtered}
            filename="products"
            disabled={listLoading}
          />
        }
      />

      <Card>
        <CardBody>
          <h2 className="dashboard-section-title">رفع منتجات (CSV أو Excel)</h2>
          <p style={{ color: "var(--office-text-muted)", fontSize: "0.9rem" }}>
            بطاقة الأصناف أو قائمة الأسعار من حساباتي (.xlsx)، أو CSV بعناوين عربية/إنجليزية.
            يُكتشف نوع الملف تلقائياً.
          </p>
          <input
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={onUpload}
            disabled={uploading}
            style={{ marginTop: "0.75rem" }}
          />
          {uploading ? <p>جاري الرفع…</p> : null}
          {uploadFeedback ? (
            <p style={{ color: uploadFeedback.ok ? "var(--office-success)" : "var(--office-danger)" }}>
              {uploadFeedback.text}
            </p>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h2 className="dashboard-section-title">إضافة منتج</h2>
          <form onSubmit={addProduct}>
            <FormGrid>
              <FormField
                label="الباركود"
                required
                hint="مقترح — يمكن تعديله أو مسح باركود آخر"
              >
                <div className="barcode-input-row">
                  <Input
                    value={form.barcode}
                    onChange={(e) => setForm({ ...form, barcode: e.target.value })}
                    placeholder="00000000001"
                    required
                  />
                  <CameraBarcodeButton
                    onScan={(code) =>
                      setForm((f) => ({ ...f, barcode: normalizeBarcode(code) }))
                    }
                  />
                </div>
              </FormField>
              <FormField label="الرقم">
                <Input
                  value={form.sku}
                  onChange={(e) => setForm({ ...form, sku: e.target.value })}
                  placeholder="يُولَّد تلقائياً إن تُرك فارغاً"
                />
              </FormField>
              <FormField label="الاسم" required>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                />
              </FormField>
              <FormField label="يُباع بالوزن (ميزان)">
                <label className="ui-checkbox-label">
                  <input
                    type="checkbox"
                    checked={Boolean(form.is_weighed)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        is_weighed: e.target.checked,
                        unit: e.target.checked ? "كغم" : form.unit,
                      })
                    }
                  />
                  <span>منتج ميزان — أدخل رمز الميزان (مثل 2100003) والسعر لكل كغم</span>
                </label>
              </FormField>
              <FormField label={form.is_weighed ? "السعر لكل كغم" : "سعر البيع"} required>
                <Input
                  type="number"
                  step="0.01"
                  value={form.price}
                  onChange={(e) => setForm({ ...form, price: e.target.value })}
                  required
                />
              </FormField>
              <FormField label="تكلفة">
                <Input
                  type="number"
                  step="0.01"
                  value={form.cost}
                  onChange={(e) => setForm({ ...form, cost: e.target.value })}
                />
              </FormField>
              <FormField label="التصنيف">
                <Input
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                />
              </FormField>
              <FormField label="المخزون" required>
                <Input
                  type="number"
                  value={form.stock}
                  onChange={(e) => setForm({ ...form, stock: e.target.value })}
                  required
                />
              </FormField>
              <FormField label="نسبة الضريبة (0–1)">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1"
                  value={form.tax_rate}
                  onChange={(e) => setForm({ ...form, tax_rate: e.target.value })}
                />
              </FormField>
              <FormField label="الوحدة">
                <Input
                  value={form.unit}
                  onChange={(e) => setForm({ ...form, unit: e.target.value })}
                />
              </FormField>
              <FormField label="تاريخ الصلاحية">
                <Input
                  type="date"
                  value={form.expiry_date}
                  onChange={(e) => setForm({ ...form, expiry_date: e.target.value })}
                />
              </FormField>
            </FormGrid>
            <DuplicateBarcodeConflict
              existingProduct={conflictProduct}
              busy={conflictBusy}
              onReplace={handleReplaceConflict}
              onDelete={handleDeleteConflict}
              onEditBarcode={() => setEditBarcodeProduct(conflictProduct)}
            />
            {formErr ? (
              <p style={{ color: "var(--office-danger)", marginTop: "0.5rem" }}>{formErr}</p>
            ) : null}
            <PrimaryButton type="submit" className="ui-mt-md">
              إضافة المنتج
            </PrimaryButton>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h2 className="dashboard-section-title">المنتجات</h2>
          <div className="ui-toolbar">
            <div className="barcode-input-row ui-flex-1-max">
              <SearchInput
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="بحث بالباركود أو الاسم"
              />
              <CameraBarcodeButton
                onScan={(code) => setSearch(normalizeBarcode(code))}
              />
            </div>
            <label className="ui-checkbox-label">
              <input
                type="checkbox"
                checked={showNeedsReviewOnly}
                onChange={(e) => setShowNeedsReviewOnly(e.target.checked)}
              />
              يحتاج مراجعة فقط
            </label>
            <DangerButton
              type="button"
              disabled={selectedIds.size === 0}
              onClick={() => requestDelete("bulk", [...selectedIds])}
            >
              حذف المحدد ({selectedIds.size})
            </DangerButton>
            <DangerButton
              type="button"
              disabled={products.length === 0}
              onClick={() => requestDelete("all", products.map((p) => p.id))}
            >
              حذف كل المنتجات ({products.length})
            </DangerButton>
          </div>
          <DataTable
            columns={columns}
            rows={pageSlice}
            loading={listLoading}
            empty="لا توجد منتجات"
            emptyIcon="products"
          />
          {!listLoading && filtered.length > 0 ? (
            <div className="ui-toolbar" style={{ marginTop: "1rem", marginBottom: 0 }}>
              <SecondaryButton
                type="button"
                disabled={page <= 0}
                onClick={() => setPage((p) => p - 1)}
              >
                السابق
              </SecondaryButton>
              <span style={{ color: "var(--office-text-muted)" }}>
                صفحة {page + 1} / {totalPages}
              </span>
              <SecondaryButton
                type="button"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                التالي
              </SecondaryButton>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <ImportSummaryModal
        open={!!importSummary}
        onClose={() => setImportSummary(null)}
        data={importSummary}
      />

      <EditProductModal
        open={!!editProduct}
        onClose={() => setEditProduct(null)}
        product={editProduct}
        onSaved={() => {
          setEditProduct(null);
          load();
        }}
      />

      <ProductUnitsModal
        open={!!unitsProduct}
        product={unitsProduct}
        onClose={() => setUnitsProduct(null)}
        onChanged={load}
      />

      <EditBarcodeModal
        open={!!editBarcodeProduct}
        onClose={() => setEditBarcodeProduct(null)}
        product={editBarcodeProduct}
        onSaved={handleEditBarcodeSaved}
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
        <p style={{ marginTop: 0 }}>
          {pendingDelete && pendingDelete.ids.length > 1
            ? `سيتم حذف ${pendingDelete.ids.length} منتجًا نهائياً.`
            : "سيتم حذف هذا المنتج نهائياً."}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            confirmDelete();
          }}
        >
          <FormField label="كلمة مرور المسؤول" required>
            <Input
              type="password"
              value={pw}
              autoFocus
              onChange={(e) => {
                setPw(e.target.value);
                if (pwError) setPwError(null);
              }}
              placeholder="أدخل كلمة المرور للمتابعة"
            />
          </FormField>
        </form>
        {pwError ? (
          <p style={{ color: "var(--office-danger)", marginTop: "0.5rem" }}>{pwError}</p>
        ) : null}
      </Modal>
    </div>
  );
}
