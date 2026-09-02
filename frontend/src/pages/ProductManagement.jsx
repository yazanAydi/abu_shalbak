import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { searchProductsApi } from "../utils/productSearch";
import { ils, formatStockWithUnit } from "../utils/format";
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
import { pickExportColumns } from "../utils/reportExport";
import "./productDashboard/productBarcodes.css";
import CameraBarcodeButton from "../components/barcode/CameraBarcodeButton";
import { normalizeBarcode } from "../utils/barcode";
import {
  displayProductBarcode,
  displayProductSku,
  filterProductsBySkuQuery,
  parseProductSkuNumber,
  productSkuInputValue,
  sortProductsBySku,
} from "../utils/entityCodeDisplay";
import CategorySelect from "../components/CategorySelect";
import UnitNameSelect from "../components/UnitNameSelect";
import "../components/barcode/barcode-scanner.css";

const EditProductModal = lazy(() => import("./productDashboard/EditProductModal"));
const ProductUnitsModal = lazy(() => import("./productDashboard/ProductUnitsModal"));
const DuplicateBarcodeConflict = lazy(() => import("./productDashboard/DuplicateBarcodeConflict"));
const EditBarcodeModal = lazy(() => import("./productDashboard/EditBarcodeModal"));
const ImportSummaryModal = lazy(() => import("./productDashboard/ImportSummaryModal"));

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
  scale_code: "",
  package_conversion: "",
  package_price: "",
};


function toConflictProduct(hit) {
  if (!hit) return null;
  const productBarcode = hit.product?.barcode ?? hit.primary_barcode ?? hit.barcode ?? null;
  const productPrice = hit.product?.price ?? hit.price;
  const unitPrice = hit.selectedUnit?.price ?? hit.price;
  const matchedBarcode = hit.matched_barcode ?? hit.scanned_barcode ?? hit.barcode ?? null;
  const matchedUnitName = hit.matched_unit_name ?? hit.unit_name ?? null;
  const matchIsPrimary =
    matchedBarcode != null &&
    productBarcode != null &&
    String(matchedBarcode) === String(productBarcode);
  return {
    id: hit.id ?? hit.product?.id,
    name: hit.name ?? hit.product?.name,
    stock: hit.stock ?? hit.product?.stock,
    category: hit.category ?? hit.product?.category ?? null,
    is_active: hit.is_active ?? hit.product?.is_active,
    productBarcode,
    productPrice,
    unitPrice,
    matchedBarcode,
    matchedUnitName,
    matchIsPrimary,
  };
}

async function lookupProductByBarcodeApi(barcode) {
  const code = normalizeBarcode(barcode);
  if (!code) return null;
  const { data } = await api.get("/api/products/lookup", {
    params: { barcode: code },
    headers: getAuthHeaders(),
  });
  return data?.found ? data : null;
}

async function fetchSuggestedSku() {
  try {
    const { data } = await api.get("/api/products/next-sku", {
      headers: getAuthHeaders(),
    });
    return productSkuInputValue(data?.sku);
  } catch {
    return "";
  }
}

function freshAddFormSync(sku = "") {
  return { ...emptyForm, sku: productSkuInputValue(sku) };
}

function mergeProductRow(list, row) {
  if (!row?.id) return list;
  const idx = list.findIndex((p) => p.id === row.id);
  if (idx === -1) {
    return sortProductsBySku([row, ...list]);
  }
  const next = list.slice();
  next[idx] = { ...list[idx], ...row };
  return next;
}

function removeProductRows(list, ids) {
  const drop = new Set(ids.map(Number));
  return list.filter((p) => !drop.has(Number(p.id)));
}

function barcodeMatchesSku(barcode, sku) {
  const b = parseProductSkuNumber(barcode);
  const s = parseProductSkuNumber(sku);
  return b != null && s != null && b === s;
}

function validateWeighedPackageFields(form) {
  if (!form.is_weighed) return null;
  const convEmpty = form.package_conversion === "" || form.package_conversion == null;
  const priceEmpty = form.package_price === "" || form.package_price == null;
  if (convEmpty && priceEmpty) return null;
  if (convEmpty || priceEmpty) {
    return "أدخل وزن الحبة وسعر الحبة معاً، أو اتركهما فارغين للبيع بالوزن فقط";
  }
  if (!Number.isFinite(Number(form.package_conversion)) || Number(form.package_conversion) <= 0) {
    return "وزن الحبة غير صالح";
  }
  if (!Number.isFinite(Number(form.package_price)) || Number(form.package_price) <= 0) {
    return "سعر الحبة غير صالح";
  }
  return null;
}

function formToPayload(form) {
  return {
    barcode: form.barcode.trim(),
    sku: form.sku?.trim() || null,
    needs_review: barcodeMatchesSku(form.barcode, form.sku) ? 1 : 0,
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
    ...(form.is_weighed
      ? {
          scale_code: form.scale_code?.trim() || null,
          ...(form.package_conversion !== "" &&
          form.package_price !== "" &&
          Number.isFinite(Number(form.package_conversion)) &&
          Number.isFinite(Number(form.package_price))
            ? {
                package_conversion: Number(form.package_conversion),
                package_price: Number(form.package_price),
              }
            : {}),
        }
      : {}),
  };
}

function formToUpdatePayload(form) {
  const { stock: _ignoredStock, ...payload } = formToPayload(form);
  return payload;
}

function validateAddForm(form) {
  const name = form.name.trim();
  if (!form.barcode.trim()) return "الباركود مطلوب";
  if (!name) return "الاسم مطلوب";
  if (form.price === "" || !Number.isFinite(Number(form.price)) || Number(form.price) < 0) {
    return form.is_weighed ? "أدخل سعر الكغم" : "أدخل سعر بيع صالحاً";
  }
  const packageErr = validateWeighedPackageFields(form);
  if (packageErr) return packageErr;
  if (form.stock === "" || !Number.isFinite(Number(form.stock))) {
    return "أدخل مخزوناً صالحاً";
  }
  return null;
}

const PRODUCT_PAGE_SIZE = 200;

export default function ProductManagement() {
  const toast = useToast();
  const navigate = useNavigate();
  const [products, setProducts] = useState([]);
  const [productsTotal, setProductsTotal] = useState(0);
  const [searchResults, setSearchResults] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [search, setSearch] = useState("");
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

  // The catalogue is fetched a page at a time rather than in one response; at a
  // few thousand SKUs the full list was megabytes of JSON and a row per product
  // in the DOM. "needs review" is filtered server-side so the toggle still sees
  // the whole catalogue rather than just the pages loaded so far.
  const fetchProductPage = useCallback(
    async (offset) => {
      const params = { scope: "retail", limit: PRODUCT_PAGE_SIZE, offset };
      if (showNeedsReviewOnly) params.needs_review = 1;
      const { data } = await api.get("/api/products", {
        params,
        headers: getAuthHeaders(),
      });
      const body = data?.data ?? data;
      const items = Array.isArray(body?.items)
        ? body.items
        : Array.isArray(body)
          ? body
          : [];
      const total = Number(body?.total);
      return { items, total: Number.isFinite(total) ? total : items.length };
    },
    [showNeedsReviewOnly]
  );

  const applyLocalRow = useCallback((row) => {
    if (!row?.id) return;
    setProducts((prev) => mergeProductRow(prev, row));
    setSearchResults((prev) => (prev ? mergeProductRow(prev, row) : prev));
  }, []);

  const applyLocalRemove = useCallback((ids) => {
    setProducts((prev) => removeProductRows(prev, ids));
    setSearchResults((prev) => (prev ? removeProductRows(prev, ids) : prev));
    setProductsTotal((n) => Math.max(0, n - ids.length));
  }, []);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const { items, total } = await fetchProductPage(0);
      setProducts(items);
      setProductsTotal(total);
    } catch (e) {
      toast.error(e.response?.data?.error || e.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [fetchProductPage, toast]);

  const loadMoreProducts = useCallback(async () => {
    setLoadingMore(true);
    try {
      const { items, total } = await fetchProductPage(products.length);
      setProductsTotal(total);
      setProducts((prev) => {
        // Rows can shift between pages if someone edits the catalogue mid-scroll.
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...items.filter((p) => !seen.has(p.id))];
      });
    } catch (e) {
      toast.error(e.response?.data?.error || e.message);
    } finally {
      setLoadingMore(false);
    }
  }, [fetchProductPage, products.length, toast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    fetchSuggestedSku().then((sku) => {
      if (!cancelled && sku) {
        setForm((f) =>
          parseProductSkuNumber(f.sku) != null ? f : { ...f, sku }
        );
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
        const rows = await searchProductsApi(q, { limit: 50, scope: "retail" });
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
  const filtered = useMemo(() => {
    const rawList = isSearchActive ? (searchResults ?? []) : products;
    const baseList = isSearchActive
      ? filterProductsBySkuQuery(rawList, search)
      : sortProductsBySku(rawList);
    if (isSearchActive && showNeedsReviewOnly) {
      return baseList.filter((p) => Number(p.needs_review) === 1);
    }
    return baseList;
  }, [isSearchActive, searchResults, products, search, showNeedsReviewOnly]);
  const listLoading = isSearchActive
    ? searchLoading || searchResults === null
    : loading;

  useEffect(() => {
    setSelectedIds(new Set());
  }, [search, showNeedsReviewOnly]);

  useEffect(() => {
    const code = form.barcode.trim();
    if (!code) {
      setConflictProduct(null);
      return undefined;
    }
    const timer = window.setTimeout(async () => {
      try {
        const hit = await lookupProductByBarcodeApi(code);
        setConflictProduct(toConflictProduct(hit));
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
      await load({ silent: true });
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

    if (barcodeMatchesSku(form.barcode, form.sku)) {
      const ok = window.confirm(
        "الباركود المدخل يطابق رقم المنتج. إذا كان هذا الباركود الحقيقي للمتابعة اضغط موافق، وإلا أدخل باركوداً مختلفاً."
      );
      if (!ok) return;
    }

    try {
      const { data: created } = await api.post(
        "/api/products",
        formToPayload(form),
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      applyLocalRow(created);
      setProductsTotal((n) => n + 1);
      setForm(freshAddFormSync(created?.next_sku));
      if (!created?.next_sku) {
        fetchSuggestedSku().then((sku) => {
          if (sku) setForm((f) => (f.sku ? f : { ...f, sku }));
        });
      }
      setConflictProduct(null);
      toast.success("تمت إضافة المنتج");
      if (created?.id) setUnitsProduct(created);
    } catch (e) {
      if (e.response?.status === 409) {
        const existing = await lookupProductByBarcodeApi(form.barcode);
        if (existing) {
          setConflictProduct(toConflictProduct(existing));
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
      const { data: updated } = await api.put(
        `/api/products/${conflictProduct.id}`,
        formToUpdatePayload(form),
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      applyLocalRow(updated);
      setForm(freshAddFormSync(updated?.next_sku));
      setConflictProduct(null);
      toast.success("تم استبدال المنتج");
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
      applyLocalRemove([conflictProduct.id]);
      setConflictProduct(null);
      toast.success("تم الحذف — يمكنك الآن إضافة المنتج");
    } catch (e) {
      setFormErr(e.response?.data?.error || e.message);
    } finally {
      setConflictBusy(false);
    }
  }

  function handleEditBarcodeSaved(row) {
    setEditBarcodeProduct(null);
    setConflictProduct(null);
    if (row) applyLocalRow(row);
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

  function toggleSelectAllVisible(checked) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const p of filtered) {
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
          { headers: { ...getAuthHeaders(), "Content-Type": "application/json", "X-Confirm-Password": pw } }
        );
      } else {
        await api.delete(`/api/admin/products/${ids[0]}`, {
          headers: { ...getAuthHeaders(), "X-Confirm-Password": pw },
        });
      }
      toast.success(ids.length > 1 ? `تم حذف ${ids.length} منتجًا` : "تم الحذف");
      applyLocalRemove(ids);
      clearSelection();
    } catch (e) {
      toast.error(e.response?.data?.error || e.message);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    if (!pw) {
      setPwError("كلمة المرور مطلوبة");
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

  async function toggleActive(p) {
    const next = Number(p.is_active) === 0 ? 1 : 0;
    try {
      await api.patch(
        `/api/products/${p.id}/active`,
        { is_active: next },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      toast.success(next ? "تم تفعيل المنتج" : "تم إيقاف المنتج");
      applyLocalRow({ ...p, is_active: next });
    } catch (e) {
      toast.error(e.response?.data?.error || e.message);
    }
  }

  const allVisibleSelected =
    filtered.length > 0 && filtered.every((p) => selectedIds.has(p.id));

  const columns = useMemo(() => [
    {
      key: "select",
      hideOnMobile: true,
      header: (
        <input
          type="checkbox"
          aria-label="تحديد كل المنتجات الظاهرة"
          checked={allVisibleSelected}
          onChange={(e) => toggleSelectAllVisible(e.target.checked)}
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
    {
      key: "barcode",
      hideOnMobile: true,
      header: "الباركود",
      value: (p) => displayProductBarcode(p),
      render: (p) => displayProductBarcode(p),
    },
    {
      key: "sku",
      hideOnMobile: true,
      header: "الرقم",
      className: "num",
      value: (p) => displayProductSku(p.sku),
      render: (p) => displayProductSku(p.sku),
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
    { key: "stock", header: "المخزون", className: "num", render: (p) => formatStockWithUnit(p.stock, p) },
    {
      key: "is_active",
      hideOnMobile: true,
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
  ], [allVisibleSelected, selectedIds, navigate]);

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
            getExportRows={async () => {
              const params = { scope: "retail", limit: "all", offset: 0 };
              if (showNeedsReviewOnly) params.needs_review = 1;
              if (search.trim()) params.q = search.trim();
              const { data } = await api.get("/api/products", {
                params,
                headers: getAuthHeaders(),
              });
              if (Array.isArray(data?.items)) return data.items;
              return Array.isArray(data?.data ?? data) ? (data?.data ?? data) : filtered;
            }}
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
                hint="امسح أو أدخل باركود المنتج"
              >
                <div className="barcode-input-row">
                  <Input
                    value={form.barcode}
                    onChange={(e) => setForm({ ...form, barcode: e.target.value })}
                    placeholder="امسح أو أدخل الباركود"
                    required
                  />
                  <CameraBarcodeButton
                    onScan={(code) =>
                      setForm((f) => ({ ...f, barcode: normalizeBarcode(code) }))
                    }
                  />
                </div>
              </FormField>
              <FormField
                label="الرقم"
                hint="مقترح — يمكن تعديله"
              >
                <Input
                  value={form.sku}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={11}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/\D/g, "").slice(0, 11);
                    setForm({ ...form, sku: raw });
                  }}
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
                  <span>يُباع بالوزن من الميزان (كغم). اترك وزن الحبة وسعر الحبة فارغين للبيع بالوزن فقط</span>
                </label>
              </FormField>
              {form.is_weighed ? (
                <FormField label="رمز الميزان" hint="مثل 2100003 — مستقل عن الباركود ورقم المنتج">
                  <Input
                    value={form.scale_code}
                    inputMode="numeric"
                    autoComplete="off"
                    onChange={(e) => setForm({ ...form, scale_code: e.target.value.replace(/\D/g, "") })}
                    placeholder="2100003"
                  />
                </FormField>
              ) : null}
              {form.is_weighed ? (
                <FormField
                  label="وزن الحبة (كغم)"
                  hint="اختياري مع سعر الحبة — اتركهما فارغين إذا كان المنتج يُباع من الميزان فقط. يحدد خصم المخزون وليس السعر"
                >
                  <Input
                    type="number"
                    step="0.001"
                    min="0.001"
                    value={form.package_conversion}
                    onChange={(e) => setForm({ ...form, package_conversion: e.target.value })}
                    placeholder="1.000"
                  />
                </FormField>
              ) : null}
              {form.is_weighed ? (
                <FormField
                  label="سعر الحبة"
                  hint="املأه مع وزن الحبة لإضافة بيع الحبة — مستقل عن سعر الكغم"
                >
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.package_price}
                    onChange={(e) => setForm({ ...form, package_price: e.target.value })}
                    placeholder="0.00"
                  />
                </FormField>
              ) : null}
              <FormField
                label={form.is_weighed ? "سعر الكغم (ميزان)" : "سعر البيع"}
                hint={form.is_weighed ? "سعر الميزان لكل كغم — مستقل عن سعر الحبة" : undefined}
                required
              >
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
                <CategorySelect
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                />
              </FormField>
              <FormField label="المخزون" required>
                <Input
                  type="number"
                  step={form.is_weighed ? "0.001" : "1"}
                  value={form.stock}
                  onChange={(e) => setForm({ ...form, stock: e.target.value })}
                  required
                />
              </FormField>
              <FormField label="الوحدة">
                <UnitNameSelect
                  value={form.is_weighed ? "كغم" : form.unit}
                  disabled={form.is_weighed}
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
            <Suspense fallback={null}>
            <DuplicateBarcodeConflict
              existingProduct={conflictProduct}
              busy={conflictBusy}
              onReplace={handleReplaceConflict}
              onDelete={handleDeleteConflict}
              onEditBarcode={() => setEditBarcodeProduct(conflictProduct)}
              onEditUnits={() => setUnitsProduct(conflictProduct)}
            />
            </Suspense>
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
                placeholder="بحث بالباركود أو الاسم أو الرقم"
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
          </div>
          <DataTable
            columns={columns}
            rows={filtered}
            loading={listLoading}
            empty="لا توجد منتجات"
            emptyIcon="products"
          />
          {!isSearchActive && !loading && products.length < productsTotal ? (
            <div className="ui-load-more">
              <span className="ui-load-more__count">
                {products.length} من {productsTotal}
              </span>
              <SecondaryButton
                type="button"
                onClick={loadMoreProducts}
                disabled={loadingMore}
              >
                {loadingMore ? "جاري التحميل…" : "تحميل المزيد"}
              </SecondaryButton>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Suspense fallback={null}>
      <ImportSummaryModal
        open={!!importSummary}
        onClose={() => setImportSummary(null)}
        data={importSummary}
      />
      </Suspense>

      <Suspense fallback={null}>
      <EditProductModal
        open={!!editProduct}
        onClose={() => setEditProduct(null)}
        product={editProduct}
        onSaved={(row) => {
          setEditProduct(null);
          applyLocalRow(row);
        }}
      />

      <ProductUnitsModal
        open={!!unitsProduct}
        product={unitsProduct}
        onClose={() => setUnitsProduct(null)}
        onChanged={async () => {
          if (unitsProduct) applyLocalRow(unitsProduct);
          const code = form.barcode.trim();
          if (!code) return;
          try {
            const hit = await lookupProductByBarcodeApi(code);
            setConflictProduct(toConflictProduct(hit));
          } catch {
            setConflictProduct(null);
          }
        }}
      />

      <EditBarcodeModal
        open={!!editBarcodeProduct}
        onClose={() => setEditBarcodeProduct(null)}
        product={editBarcodeProduct}
        onSaved={handleEditBarcodeSaved}
      />
      </Suspense>

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
