import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { displayProductBarcode, displayProductSku } from "../utils/entityCodeDisplay";
import CategorySelect from "../components/CategorySelect";
import UnitNameSelect from "../components/UnitNameSelect";
import {
  PageHeader,
  Card,
  CardBody,
  DataTable,
  SearchInput,
  FilterBar,
  FormField,
  Select,
  StatusPill,
  SecondaryButton,
  useToast,
} from "../components/ui";
import {
  PRODUCT_ORG_PAGE_SIZE,
  buildOrganizationListParams,
} from "./productOrganization/buildListParams";
import {
  ROW_SAVE,
  applySuccessfulPatch,
  errorLabel,
  revertRow,
  rowSaveMessage,
  savedLabel,
} from "./productOrganization/rowSaveState";
import "./ProductOrganization.css";

function unwrapList(data) {
  const body = data?.data ?? data;
  const items = Array.isArray(body?.items)
    ? body.items
    : Array.isArray(body)
      ? body
      : [];
  const total = Number(body?.total);
  return { items, total: Number.isFinite(total) ? total : items.length };
}

export default function ProductOrganization() {
  const toast = useToast();
  const [products, setProducts] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [unitFilter, setUnitFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [categories, setCategories] = useState([]);
  const [unitNames, setUnitNames] = useState([]);
  const [saveState, setSaveState] = useState({});
  const saveTimers = useRef(new Map());

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
      setOffset(0);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get("/api/products/categories", {
        params: { active: 1 },
        headers: getAuthHeaders(),
      }),
      api.get("/api/products/unit-names", {
        params: { active: 1 },
        headers: getAuthHeaders(),
      }),
    ])
      .then(([catRes, unitRes]) => {
        if (cancelled) return;
        setCategories(Array.isArray(catRes.data) ? catRes.data : []);
        setUnitNames(Array.isArray(unitRes.data) ? unitRes.data : []);
      })
      .catch(() => {
        if (!cancelled) {
          setCategories([]);
          setUnitNames([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = buildOrganizationListParams({
        search: debouncedSearch,
        unit: unitFilter,
        category: categoryFilter,
        isActive: statusFilter,
        limit: PRODUCT_ORG_PAGE_SIZE,
        offset,
      });
      const { data } = await api.get("/api/products", {
        params,
        headers: getAuthHeaders(),
      });
      const { items, total: nextTotal } = unwrapList(data);
      setProducts(items);
      setTotal(nextTotal);
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "تعذر تحميل المنتجات");
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, unitFilter, categoryFilter, statusFilter, offset, toast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const timers = saveTimers.current;
    return () => {
      for (const id of timers.values()) window.clearTimeout(id);
      timers.clear();
    };
  }, []);

  const patchProduct = useCallback(
    async (product, field, nextValue) => {
      const prev = product[field] ?? null;
      const next = nextValue ? String(nextValue) : null;
      const prevNorm = prev == null || String(prev).trim() === "" ? null : String(prev);
      if (prevNorm === next) return;

      const snapshot = { [field]: product[field] };
      setProducts((rows) => applySuccessfulPatch(rows, product.id, { [field]: next }));
      setSaveState((s) => ({
        ...s,
        [product.id]: { status: ROW_SAVE.SAVING, field },
      }));

      try {
        const { data } = await api.put(
          `/api/products/${product.id}`,
          { [field]: next },
          { headers: getAuthHeaders() }
        );
        const row = data?.data ?? data;
        setProducts((rows) => applySuccessfulPatch(rows, product.id, row || { [field]: next }));
        setSaveState((s) => ({
          ...s,
          [product.id]: { status: ROW_SAVE.SAVED, field },
        }));
        toast.success(savedLabel());
        const existing = saveTimers.current.get(product.id);
        if (existing) window.clearTimeout(existing);
        saveTimers.current.set(
          product.id,
          window.setTimeout(() => {
            setSaveState((s) => {
              if (s[product.id]?.status !== ROW_SAVE.SAVED) return s;
              const nextState = { ...s };
              delete nextState[product.id];
              return nextState;
            });
            saveTimers.current.delete(product.id);
          }, 2000)
        );
      } catch (e) {
        setProducts((rows) => revertRow(rows, product.id, snapshot));
        const message = e.response?.data?.error || e.message || errorLabel();
        setSaveState((s) => ({
          ...s,
          [product.id]: { status: ROW_SAVE.ERROR, field, message },
        }));
        toast.error(message);
      }
    },
    [toast]
  );

  const columns = useMemo(
    () => [
      {
        key: "index",
        header: "#",
        render: (_row, index) => offset + index + 1,
      },
      {
        key: "sku",
        header: "الرقم",
        render: (p) => displayProductSku(p.sku),
      },
      {
        key: "name",
        header: "اسم المنتج",
        render: (p) => p.name || "—",
      },
      {
        key: "barcode",
        header: "الباركود",
        render: (p) => displayProductBarcode(p),
      },
      {
        key: "unit",
        header: "الوحدة",
        render: (p) => {
          const weighed = Number(p.is_weighed) === 1;
          return (
            <UnitNameSelect
              value={weighed ? "كغم" : p.unit || ""}
              names={unitNames}
              disabled={weighed}
              emptyLabel="اختر الوحدة"
              onChange={(e) => patchProduct(p, "unit", e.target.value)}
            />
          );
        },
      },
      {
        key: "category",
        header: "التصنيف",
        render: (p) => (
          <CategorySelect
            value={p.category || ""}
            categories={categories}
            emptyLabel="بدون تصنيف"
            onChange={(e) => patchProduct(p, "category", e.target.value)}
          />
        ),
      },
      {
        key: "is_active",
        header: "الحالة",
        hideOnMobile: true,
        render: (p) => (
          <StatusPill tone={Number(p.is_active) === 0 ? "neutral" : "green"}>
            {Number(p.is_active) === 0 ? "غير نشط" : "نشط"}
          </StatusPill>
        ),
      },
      {
        key: "actions",
        header: "",
        render: (p) => {
          const st = saveState[p.id];
          const msg = rowSaveMessage(st);
          return (
            <div className="product-org-actions">
              {msg ? (
                <span
                  className={`product-org-save product-org-save--${st.status}`}
                >
                  {msg}
                </span>
              ) : null}
              <Link className="product-org-link" to={`/products/${p.id}`}>
                تفاصيل
              </Link>
            </div>
          );
        },
      },
    ],
    [offset, unitNames, categories, patchProduct, saveState]
  );

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + products.length, total);
  const canPrev = offset > 0;
  const canNext = offset + products.length < total;

  return (
    <div className="product-org-page" dir="rtl">
      <PageHeader
        icon="products"
        title="تنظيم المنتجات"
        subtitle="إدارة الوحدات والتصنيفات للمنتجات"
      />

      <div className="product-org-filters">
        <FilterBar>
          <FormField label="البحث عن منتج" className="product-org-search">
            <SearchInput
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="ابحث عن اسم المنتج أو الرقم أو الباركود"
            />
          </FormField>
          <FormField label="الوحدة">
            <UnitNameSelect
              value={unitFilter}
              names={unitNames}
              emptyLabel="كل الوحدات"
              onChange={(e) => {
                setUnitFilter(e.target.value);
                setOffset(0);
              }}
            />
          </FormField>
          <FormField label="التصنيف">
            <CategorySelect
              value={categoryFilter}
              categories={categories}
              emptyLabel="كل التصنيفات"
              onChange={(e) => {
                setCategoryFilter(e.target.value);
                setOffset(0);
              }}
            />
          </FormField>
          <FormField label="الحالة">
            <Select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">جميع المنتجات</option>
              <option value="1">المنتجات الفعالة</option>
              <option value="0">المنتجات غير الفعالة</option>
            </Select>
          </FormField>
        </FilterBar>
      </div>

      <Card>
        <CardBody>
          <div className="product-org-table">
            <DataTable
              columns={columns}
              rows={products}
              loading={loading}
              empty="لا توجد منتجات مطابقة للبحث"
              emptyIcon="products"
            />
          </div>
          {!loading && total > 0 ? (
            <div className="product-org-pager">
              <span className="product-org-pager__count">
                {from}–{to} من {total}
              </span>
              <div className="product-org-pager__btns">
                <SecondaryButton
                  type="button"
                  disabled={!canPrev}
                  onClick={() => setOffset((n) => Math.max(0, n - PRODUCT_ORG_PAGE_SIZE))}
                >
                  السابق
                </SecondaryButton>
                <SecondaryButton
                  type="button"
                  disabled={!canNext}
                  onClick={() => setOffset((n) => n + PRODUCT_ORG_PAGE_SIZE)}
                >
                  التالي
                </SecondaryButton>
              </div>
            </div>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
